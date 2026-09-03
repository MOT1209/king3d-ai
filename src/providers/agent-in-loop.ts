/**
 * The agent-in-the-loop provider.
 *
 * Instead of calling an API, this writes a self-contained request to disk and
 * reads back a JSON answer. The agent already driving this session - which can
 * see images - is the model. That means no API key, no per-token cost, and no
 * secret to leak, and the same files make a run reproducible and auditable.
 *
 * Runs are therefore resumable rather than blocking: a stage that needs a
 * judgement writes its request and stops, and `king3d resume` continues once the
 * answer file exists.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { Ai3dError } from "../core/errors.ts";
import { createLogger } from "../core/logger.ts";
import { NeedsModelInput, type ModelProvider, type VisionRequest } from "./provider.ts";

const log = createLogger("provider:agent");

export interface AgentProviderOptions {
  /** Directory the request/response pairs live in, normally runs/<id>/prompts. */
  promptDir: string;
}

export class AgentInLoopProvider implements ModelProvider {
  readonly name = "agent-in-loop";
  readonly #promptDir: string;

  constructor(options: AgentProviderOptions) {
    this.#promptDir = options.promptDir;
  }

  requestPath(stage: string): string {
    return join(this.#promptDir, `${stage}.request.md`);
  }

  responsePath(stage: string): string {
    return join(this.#promptDir, `${stage}.response.json`);
  }

  async ask<T>(request: VisionRequest<T>): Promise<T> {
    await mkdir(this.#promptDir, { recursive: true });
    const requestPath = this.requestPath(request.stage);
    const responsePath = this.responsePath(request.stage);

    // Always rewrite the request: the context (gate failures, previous scores)
    // changes between repair cycles even when the question does not.
    await writeFile(requestPath, renderRequest(request, responsePath), "utf8");

    let raw: string;
    try {
      raw = await readFile(responsePath, "utf8");
    } catch {
      log.info(`stage "${request.stage}" is waiting for a judgement`, { requestPath });
      throw new NeedsModelInput(request.stage, requestPath, responsePath);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFence(raw));
    } catch (e) {
      throw new Ai3dError("TOOL_OUTPUT_INVALID", `The answer at ${responsePath} is not valid JSON: ${String(e)}`, {
        stage: request.stage,
        responsePath,
      });
    }

    const result = request.schema.safeParse(parsedJson);
    if (!result.success) {
      // Write the complaint next to the answer so the next attempt can see it.
      const issues = result.error.issues
        .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      await writeFile(
        join(this.#promptDir, `${request.stage}.errors.txt`),
        `The previous answer did not match the schema:\n${issues}\n`,
        "utf8",
      );
      throw new Ai3dError("TOOL_OUTPUT_INVALID", `The answer for "${request.stage}" does not match its schema:\n${issues}`, {
        stage: request.stage,
        responsePath,
        issues: result.error.issues,
      });
    }
    return result.data;
  }
}

/** Tolerate an answer pasted inside a markdown code fence. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .trim();
}

function renderRequest<T>(request: VisionRequest<T>, responsePath: string): string {
  const lines: string[] = [];
  lines.push(`# ${request.stage}`);
  lines.push("");
  lines.push("## Task");
  lines.push("");
  lines.push(request.instruction.trim());
  lines.push("");

  if (request.images.length > 0) {
    lines.push("## Images to look at");
    lines.push("");
    for (const image of request.images) {
      lines.push(`- **${image.label}**: \`${image.path}\``);
    }
    lines.push("");
    lines.push("Open each of these before answering. Do not answer from the description alone.");
    lines.push("");
  }

  if (request.context && Object.keys(request.context).length > 0) {
    lines.push("## Context");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(request.context, null, 2));
    lines.push("```");
    lines.push("");
  }

  lines.push("## Answer format");
  lines.push("");
  lines.push(request.schemaHint.trim());
  lines.push("");
  lines.push("## How to answer");
  lines.push("");
  lines.push(`Write the JSON answer to:`);
  lines.push("");
  lines.push(`    ${responsePath}`);
  lines.push("");
  lines.push("Then re-run the pipeline; it resumes from this stage.");
  lines.push("The answer is validated against a schema, so a missing or misnamed field is rejected.");
  lines.push("");
  return lines.join("\n");
}

/** Convenience for tests and for a future API-backed provider. */
export class StaticProvider implements ModelProvider {
  readonly name = "static";
  readonly #answers: Map<string, unknown>;

  constructor(answers: Record<string, unknown>) {
    this.#answers = new Map(Object.entries(answers));
  }

  async ask<T>(request: VisionRequest<T>): Promise<T> {
    if (!this.#answers.has(request.stage)) {
      throw new NeedsModelInput(request.stage, "(static provider)", "(static provider)");
    }
    const parsed = request.schema.safeParse(this.#answers.get(request.stage));
    if (!parsed.success) {
      throw new Ai3dError("TOOL_OUTPUT_INVALID", `static answer for "${request.stage}" is invalid`, {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }
}

