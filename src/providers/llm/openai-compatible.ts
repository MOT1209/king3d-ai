/**
 * Any server that speaks the OpenAI chat-completions protocol: OpenAI itself,
 * OpenRouter (one key, hundreds of models), Gemini's compatibility endpoint,
 * Ollama and LM Studio (local, no key), DeepSeek, Groq, ...
 *
 * Plain fetch on purpose - the wire format is small and stable, and this keeps
 * the project free of a per-vendor SDK for each of them.
 */
import { Ai3dError } from "../../core/errors.ts";
import type { ChatClient, ChatRequest } from "./types.ts";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  /** Omitted for local servers (Ollama, LM Studio) that need no key. */
  apiKey?: string;
  timeoutMs?: number;
}

export class OpenAiCompatibleChatClient implements ChatClient {
  readonly name = "openai-compatible";
  readonly model: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: OpenAiCompatibleOptions) {
    this.model = options.model;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 180_000;
  }

  async complete(request: ChatRequest): Promise<string> {
    const userContent =
      request.images.length === 0
        ? request.user
        : [
            { type: "text", text: request.user },
            ...request.images.map((image) => ({
              type: "image_url",
              image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
            })),
          ];

    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: userContent },
          ],
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      // The message never includes request headers, so the key cannot leak here.
      throw new Ai3dError("LLM_UNAVAILABLE", `could not reach ${this.#baseUrl}`, {
        cause: e instanceof Error ? e.message : String(e),
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const code = res.status === 401 || res.status === 403 ? "LLM_UNAVAILABLE" : "LLM_FAILED";
      throw new Ai3dError(code, `${this.#baseUrl} returned ${res.status}: ${body.slice(0, 300)}`, { status: res.status });
    }

    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => (typeof part === "string" ? part : ((part as { text?: string }).text ?? ""))).join("");
    }
    throw new Ai3dError("LLM_FAILED", "the response had no message content");
  }
}
