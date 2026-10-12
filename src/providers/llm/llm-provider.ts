/**
 * A ModelProvider backed by a real language model.
 *
 * Where the agent-in-the-loop provider writes a question to disk and waits for
 * someone else to answer, this one asks a configured model directly and
 * validates the reply against the request's own schema - so the pipeline cannot
 * tell which model, or which vendor, answered.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Ai3dError } from "../../core/errors.ts";
import type { ModelProvider, VisionRequest } from "../provider.ts";
import type { ChatClient, ChatImage } from "./types.ts";

const SYSTEM_PROMPT =
  "You are one judgement stage inside a deterministic 3D asset pipeline. " +
  "Answer with exactly one JSON object that matches the schema in the request. " +
  "No prose before or after it, no markdown fences, no comments.";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Pull the JSON object out of a model reply. Models wrap answers in fences or
 * add a sentence of preamble despite being told not to, so be forgiving about
 * the wrapper and strict about the content (which the schema then checks).
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Ai3dError("LLM_INVALID_OUTPUT", "the reply contained no JSON object", { reply: text.slice(0, 500) });
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    throw new Ai3dError("LLM_INVALID_OUTPUT", `the reply was not valid JSON: ${(e as Error).message}`, {
      reply: text.slice(0, 500),
    });
  }
}

async function loadImages(request: VisionRequest<unknown>): Promise<ChatImage[]> {
  const images: ChatImage[] = [];
  for (const image of request.images) {
    const mediaType = IMAGE_TYPES[extname(image.path).toLowerCase()];
    if (!mediaType) continue; // an unsupported type is skipped, not fatal
    images.push({ mediaType, base64: (await readFile(image.path)).toString("base64") });
  }
  return images;
}

function userPrompt(request: VisionRequest<unknown>, imageLabels: string[]): string {
  const parts = [request.instruction.trim(), `Answer schema:\n${request.schemaHint.trim()}`];
  if (request.context && Object.keys(request.context).length > 0) {
    parts.push(`Facts to take into account:\n${JSON.stringify(request.context, null, 2)}`);
  }
  if (imageLabels.length > 0) {
    parts.push(`Attached images, in order: ${imageLabels.join(", ")}.`);
  }
  return parts.join("\n\n");
}

export class LlmModelProvider implements ModelProvider {
  readonly name: string;
  readonly #client: ChatClient;

  constructor(client: ChatClient) {
    this.#client = client;
    this.name = `llm:${client.name}:${client.model}`;
  }

  async ask<T>(request: VisionRequest<T>): Promise<T> {
    const images = await loadImages(request);
    const labels = request.images.filter((i) => IMAGE_TYPES[extname(i.path).toLowerCase()]).map((i) => i.label);
    const base = userPrompt(request, labels);

    let user = base;
    let lastProblem = "";
    // One retry: a model that returns almost-right JSON usually fixes it when told what was wrong.
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.#client.complete({ system: SYSTEM_PROMPT, user, images });
      try {
        const parsed = request.schema.safeParse(extractJson(reply));
        if (parsed.success) return parsed.data;
        lastProblem = parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
      } catch (e) {
        if (!(e instanceof Ai3dError) || e.code !== "LLM_INVALID_OUTPUT") throw e;
        lastProblem = e.message;
      }
      user = `${base}\n\nYour previous answer was rejected: ${lastProblem}\nReturn a corrected JSON object only.`;
    }
    throw new Ai3dError("LLM_INVALID_OUTPUT", `the model did not return a valid answer: ${lastProblem}`, {
      stage: request.stage,
    });
  }
}
