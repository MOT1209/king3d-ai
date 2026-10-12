import type { Ai3dConfig } from "../../core/config.ts";
import { Ai3dError } from "../../core/errors.ts";
import { AnthropicChatClient, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.ts";
import { OpenAiCompatibleChatClient } from "./openai-compatible.ts";
import type { ChatClient } from "./types.ts";

/** What a UI may know about the configuration. Deliberately has no secret in it. */
export interface LlmStatus {
  configured: boolean;
  provider: Ai3dConfig["llmProvider"];
  model: string | null;
}

export function llmStatus(config: Ai3dConfig): LlmStatus {
  if (config.llmProvider === "agent") return { configured: false, provider: "agent", model: null };
  const model = config.llmModel ?? (config.llmProvider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : null);
  return { configured: model !== null, provider: config.llmProvider, model };
}

/** The configured chat client, or null when no in-app model is configured. */
export function createChatClient(config: Ai3dConfig): ChatClient | null {
  switch (config.llmProvider) {
    case "agent":
      return null;
    case "anthropic":
      return new AnthropicChatClient({
        ...(config.llmModel ? { model: config.llmModel } : {}),
        ...(config.llmApiKey ? { apiKey: config.llmApiKey } : {}),
        ...(config.llmBaseUrl ? { baseUrl: config.llmBaseUrl } : {}),
      });
    case "openai-compatible": {
      if (!config.llmBaseUrl || !config.llmModel) {
        throw new Ai3dError(
          "CONFIG_INVALID",
          "openai-compatible needs KING3D_LLM_BASE_URL and KING3D_LLM_MODEL " +
            "(e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:11434/v1 for Ollama)",
        );
      }
      return new OpenAiCompatibleChatClient({
        baseUrl: config.llmBaseUrl,
        model: config.llmModel,
        ...(config.llmApiKey ? { apiKey: config.llmApiKey } : {}),
      });
    }
  }
}

export { AnthropicChatClient, OpenAiCompatibleChatClient };
export type { ChatClient } from "./types.ts";
