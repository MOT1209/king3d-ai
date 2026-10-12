/**
 * Claude, through the official SDK.
 *
 * The SDK is an optional dependency and is imported lazily, so a project that
 * never configures Anthropic neither loads it nor breaks when it is absent.
 *
 * Current-model rules applied here (see the claude-api guidance):
 *  - Opus 5.5 / Fable 5.1 run thinking always on, so `thinking` is omitted and
 *    depth is steered with `output_config.effort`.
 *  - No forced tool_choice and no prefill: the JSON contract is carried by the
 *    prompt and validated by the caller, not forced through the API.
 *  - Refusals are HTTP 200 with stop_reason "refusal"; they are surfaced as an
 *    error rather than read as an (empty) answer.
 *  - Models that support it get server-side refusal fallbacks by default.
 */
import { Ai3dError } from "../../core/errors.ts";
import type { ChatClient, ChatRequest } from "./types.ts";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** Models that take `output_config.effort` and the server-side fallback beta. */
const CURRENT_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Server-side refusal fallbacks; on by default for the models that support them. */
  fallbacks?: boolean;
}

export class AnthropicChatClient implements ChatClient {
  readonly name = "anthropic";
  readonly model: string;
  readonly #options: AnthropicOptions;

  constructor(options: AnthropicOptions = {}) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.#options = options;
  }

  async complete(request: ChatRequest): Promise<string> {
    let sdk: typeof import("@anthropic-ai/sdk");
    try {
      sdk = await import("@anthropic-ai/sdk");
    } catch {
      throw new Ai3dError("LLM_UNAVAILABLE", "the Anthropic SDK is not installed; run: npm install @anthropic-ai/sdk");
    }

    const Anthropic = sdk.default;
    // With no explicit key the SDK resolves ANTHROPIC_API_KEY / an `ant auth login` profile itself.
    const client = new Anthropic({
      ...(this.#options.apiKey ? { apiKey: this.#options.apiKey } : {}),
      ...(this.#options.baseUrl ? { baseURL: this.#options.baseUrl } : {}),
    });

    const content: Array<
      | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string } }
      | { type: "text"; text: string }
    > = [
      ...request.images.map((image) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data: image.base64,
        },
      })),
      { type: "text", text: request.user },
    ];

    const current = CURRENT_MODELS.has(this.model);
    const useFallbacks = current && this.#options.fallbacks !== false;

    try {
      const response = await client.beta.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 16000,
        system: request.system,
        messages: [{ role: "user", content }],
        ...(current ? { output_config: { effort: "medium" as const } } : {}),
        ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      });

      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category ?? "unspecified";
        throw new Ai3dError("LLM_FAILED", `the model declined this request (category: ${category})`, { category });
      }
      if (response.stop_reason === "max_tokens") {
        throw new Ai3dError("LLM_FAILED", "the model's answer was cut off at max_tokens");
      }

      return response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    } catch (e) {
      if (e instanceof Ai3dError) throw e;
      if (e instanceof Anthropic.AuthenticationError) {
        throw new Ai3dError("LLM_UNAVAILABLE", "Anthropic rejected the API key (401)");
      }
      if (e instanceof Anthropic.RateLimitError) {
        throw new Ai3dError("LLM_FAILED", "Anthropic rate limit hit (429); retry shortly");
      }
      if (e instanceof Anthropic.APIConnectionError) {
        throw new Ai3dError("LLM_UNAVAILABLE", "could not reach the Anthropic API");
      }
      if (e instanceof Anthropic.APIError) {
        throw new Ai3dError("LLM_FAILED", `Anthropic API error ${e.status ?? ""}: ${e.message}`.trim());
      }
      throw e;
    }
  }
}
