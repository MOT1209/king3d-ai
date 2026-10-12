import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/core/config.ts";
import { isAi3dError } from "../src/core/errors.ts";
import { AnthropicChatClient } from "../src/providers/llm/anthropic.ts";
import { createChatClient, llmStatus } from "../src/providers/llm/index.ts";
import { extractJson, LlmModelProvider } from "../src/providers/llm/llm-provider.ts";
import { OpenAiCompatibleChatClient } from "../src/providers/llm/openai-compatible.ts";
import type { ChatClient, ChatRequest } from "../src/providers/llm/types.ts";
import type { VisionRequest } from "../src/providers/provider.ts";

const Answer = z.object({ verdict: z.enum(["ok", "bad"]), score: z.number().min(0).max(1) });

function request(): VisionRequest<z.infer<typeof Answer>> {
  return {
    stage: "t",
    instruction: "Judge it.",
    images: [],
    schema: Answer,
    schemaHint: '{ "verdict": "ok" | "bad", "score": 0-1 }',
    context: { thing: "a mug" },
  };
}

/** A scripted model: returns the next canned reply and records what it was asked. */
function scripted(...replies: string[]): ChatClient & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    name: "fake",
    model: "fake-1",
    calls,
    async complete(req) {
      calls.push(req);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("no more replies");
      return reply;
    },
  };
}

describe("extractJson", () => {
  it("reads plain, fenced and chatty replies", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go:\n{"a":{"b":2}}\nHope that helps.')).toEqual({ a: { b: 2 } });
  });

  it("rejects replies with no usable JSON", () => {
    expect(() => extractJson("no json here")).toThrow(/no JSON object/);
    expect(() => extractJson("{broken")).toThrow();
    expect(() => extractJson('{"a": nope}')).toThrow(/not valid JSON/);
  });
});

describe("LlmModelProvider", () => {
  it("returns a schema-valid answer", async () => {
    const client = scripted('{"verdict":"ok","score":0.9}');
    const answer = await new LlmModelProvider(client).ask(request());
    expect(answer).toEqual({ verdict: "ok", score: 0.9 });
    // The prompt carries the instruction, the schema and the facts.
    expect(client.calls[0]?.user).toContain("Judge it.");
    expect(client.calls[0]?.user).toContain('"verdict"');
    expect(client.calls[0]?.user).toContain("a mug");
  });

  it("retries once and tells the model what was wrong", async () => {
    const client = scripted('{"verdict":"maybe","score":2}', '{"verdict":"bad","score":0.1}');
    const answer = await new LlmModelProvider(client).ask(request());
    expect(answer.verdict).toBe("bad");
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.user).toContain("previous answer was rejected");
    expect(client.calls[1]?.user).toContain("verdict");
  });

  it("gives up after the retry with LLM_INVALID_OUTPUT", async () => {
    const client = scripted("nonsense", "still nonsense");
    await expect(new LlmModelProvider(client).ask(request())).rejects.toSatisfy(
      (e: unknown) => isAi3dError(e) && e.code === "LLM_INVALID_OUTPUT",
    );
    expect(client.calls).toHaveLength(2);
  });

  it("does not swallow transport errors as invalid output", async () => {
    const client = scripted(); // throws a plain Error on first call
    await expect(new LlmModelProvider(client).ask(request())).rejects.toThrow("no more replies");
  });
});

// ---------------------------------------------------------------- real adapters against a local server

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, any>;
}

async function serve(reply: (seen: Seen) => { status?: number; body: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = { url: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") };
      seen.push(entry);
      const out = reply(entry);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
}

const png = { mediaType: "image/png", base64: "iVBORw0KGgo=" };

describe("OpenAiCompatibleChatClient", () => {
  it("sends a chat-completions request with auth and an image part", async () => {
    const { url, seen } = await serve(() => ({ body: { choices: [{ message: { content: "hello" } }] } }));
    const client = new OpenAiCompatibleChatClient({ baseUrl: `${url}/v1/`, model: "gpt-x", apiKey: "sk-test" });
    const text = await client.complete({ system: "sys", user: "hi", images: [png] });

    expect(text).toBe("hello");
    const call = seen[0]!;
    expect(call.url).toBe("/v1/chat/completions");
    expect(call.headers["authorization"]).toBe("Bearer sk-test");
    expect(call.body["model"]).toBe("gpt-x");
    expect(call.body["messages"][0]).toEqual({ role: "system", content: "sys" });
    const parts = call.body["messages"][1].content;
    expect(parts[0]).toEqual({ type: "text", text: "hi" });
    expect(parts[1].image_url.url).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("sends no Authorization header for a keyless local server and plain text when there are no images", async () => {
    const { url, seen } = await serve(() => ({ body: { choices: [{ message: { content: "ok" } }] } }));
    await new OpenAiCompatibleChatClient({ baseUrl: url, model: "llama" }).complete({ system: "s", user: "u", images: [] });
    expect(seen[0]!.headers["authorization"]).toBeUndefined();
    expect(seen[0]!.body["messages"][1].content).toBe("u");
  });

  it("maps 401 to LLM_UNAVAILABLE and 500 to LLM_FAILED without leaking the key", async () => {
    const bad = await serve(() => ({ status: 401, body: { error: "nope" } }));
    const client = new OpenAiCompatibleChatClient({ baseUrl: bad.url, model: "m", apiKey: "sk-secret-123" });
    const err = await client.complete({ system: "s", user: "u", images: [] }).catch((e) => e);
    expect(isAi3dError(err) && err.code).toBe("LLM_UNAVAILABLE");
    expect(JSON.stringify(err.toJSON())).not.toContain("sk-secret-123");

    await new Promise<void>((r) => server!.close(() => r()));
    const boom = await serve(() => ({ status: 500, body: { error: "boom" } }));
    const err2 = await new OpenAiCompatibleChatClient({ baseUrl: boom.url, model: "m" })
      .complete({ system: "s", user: "u", images: [] })
      .catch((e) => e);
    expect(isAi3dError(err2) && err2.code).toBe("LLM_FAILED");
  });

  it("reports an unreachable server as LLM_UNAVAILABLE", async () => {
    const err = await new OpenAiCompatibleChatClient({ baseUrl: "http://127.0.0.1:1", model: "m", timeoutMs: 2000 })
      .complete({ system: "s", user: "u", images: [] })
      .catch((e) => e);
    expect(isAi3dError(err) && err.code).toBe("LLM_UNAVAILABLE");
  });
});

describe("AnthropicChatClient (official SDK against a local server)", () => {
  const message = (over: Record<string, unknown> = {}) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: '{"ok":true}' }],
    stop_reason: "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...over,
  });

  it("calls the Messages API with the current-model request shape", async () => {
    const { url, seen } = await serve(() => ({ body: message() }));
    const client = new AnthropicChatClient({ apiKey: "sk-ant-test", baseUrl: url });
    const text = await client.complete({ system: "sys", user: "hi", images: [png] });

    expect(text).toBe('{"ok":true}');
    const call = seen[0]!;
    expect(call.url.startsWith("/v1/messages")).toBe(true);
    expect(call.headers["x-api-key"]).toBe("sk-ant-test");
    expect(call.body["model"]).toBe("claude-opus-5-5");
    expect(call.body["system"]).toBe("sys");
    // Thinking is always on for this model: it must not be sent, nor budget_tokens, nor a prefill.
    expect(call.body["thinking"]).toBeUndefined();
    expect(call.body["tool_choice"]).toBeUndefined();
    expect(call.body["output_config"]).toEqual({ effort: "medium" });
    expect(call.body["fallbacks"]).toBe("default");
    expect(String(call.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    const parts = call.body["messages"][0].content;
    expect(parts[0].type).toBe("image");
    expect(parts[0].source).toEqual({ type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" });
    expect(parts[1]).toEqual({ type: "text", text: "hi" });
  });

  it("can turn refusal fallbacks off, and sends nothing model-specific to an unknown model", async () => {
    const { url, seen } = await serve(() => ({ body: message() }));
    await new AnthropicChatClient({ apiKey: "k", baseUrl: url, fallbacks: false }).complete({ system: "s", user: "u", images: [] });
    expect(seen[0]!.body["fallbacks"]).toBeUndefined();

    await new AnthropicChatClient({ apiKey: "k", baseUrl: url, model: "claude-haiku-4-5" }).complete({ system: "s", user: "u", images: [] });
    expect(seen[1]!.body["output_config"]).toBeUndefined();
    expect(seen[1]!.body["fallbacks"]).toBeUndefined();
  });

  it("surfaces a refusal as an error instead of an empty answer", async () => {
    const { url } = await serve(() => ({
      body: message({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }),
    }));
    const err = await new AnthropicChatClient({ apiKey: "k", baseUrl: url }).complete({ system: "s", user: "u", images: [] }).catch((e) => e);
    expect(isAi3dError(err) && err.code).toBe("LLM_FAILED");
    expect(err.message).toContain("cyber");
  });

  it("maps a 401 to LLM_UNAVAILABLE", async () => {
    const { url } = await serve(() => ({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    }));
    const err = await new AnthropicChatClient({ apiKey: "bad", baseUrl: url }).complete({ system: "s", user: "u", images: [] }).catch((e) => e);
    expect(isAi3dError(err) && err.code).toBe("LLM_UNAVAILABLE");
  });
});

describe("configuration", () => {
  it("defaults to no in-app model (the agent answers) and reports that without a secret", () => {
    const config = loadConfig({ llmProvider: "agent" });
    expect(createChatClient(config)).toBeNull();
    expect(llmStatus(config)).toEqual({ configured: false, provider: "agent", model: null });
  });

  it("status never carries the API key", () => {
    const status = llmStatus(loadConfig({ llmProvider: "anthropic", llmApiKey: "sk-ant-secret" }));
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(status).toEqual({ configured: true, provider: "anthropic", model: "claude-opus-5-5" });
  });

  it("openai-compatible needs a base URL and a model", () => {
    expect(() => createChatClient(loadConfig({ llmProvider: "openai-compatible" }))).toThrow(/KING3D_LLM_BASE_URL/);
    const client = createChatClient(
      loadConfig({ llmProvider: "openai-compatible", llmBaseUrl: "http://127.0.0.1:11434/v1", llmModel: "llama3.2" }),
    );
    expect(client?.name).toBe("openai-compatible");
  });
});
