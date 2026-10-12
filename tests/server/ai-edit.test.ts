import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paths } from "../../src/core/config.ts";
import { newRunId, runPaths } from "../../src/pipeline/run.ts";
import type { ModelProvider, VisionRequest } from "../../src/providers/provider.ts";
import { LlmModelProvider } from "../../src/providers/llm/llm-provider.ts";
import { apiAiEdit, apiEditRun, apiLlmStatus } from "../../src/server/routes.ts";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((id) => rm(runPaths(id).dir, { recursive: true, force: true })));
});

async function makeRun(): Promise<string> {
  const id = newRunId("aied");
  created.push(id);
  const rp = runPaths(id);
  await mkdir(rp.dir, { recursive: true });
  await writeFile(rp.spec, await readFile(join(paths.root, "src", "spec", "fixtures", "mug.json"), "utf8"), "utf8");
  return id;
}

/** A model that answers with a fixed object and remembers the request it got. */
function fakeModel(answer: unknown): ModelProvider & { seen: VisionRequest<unknown>[] } {
  const seen: VisionRequest<unknown>[] = [];
  return {
    name: "fake-model",
    seen,
    async ask<T>(request: VisionRequest<T>): Promise<T> {
      seen.push(request as VisionRequest<unknown>);
      return request.schema.parse(answer);
    },
  };
}

describe("apiAiEdit", () => {
  it("returns a proposal and writes nothing", async () => {
    const id = await makeRun();
    const model = fakeModel({
      explanation: "Made the handle wider.",
      fixes: [{ path: "components.handle.dimensions_m.value", value: [0.09, 0.064, 0.012], reason: "wider" }],
    });
    const result = await apiAiEdit(id, { instruction: "make the handle wider" }, { provider: model });

    expect(result.status).toBe(200);
    const body = result.body as { explanation: string; fixes: Array<{ path: string }>; skipped: unknown[]; model: string };
    expect(body.explanation).toBe("Made the handle wider.");
    expect(body.fixes).toHaveLength(1);
    expect(body.skipped).toEqual([]);
    expect(body.model).toBe("fake-model");
    // A proposal is not an edit: the working spec is unchanged until it is applied.
    const edited = await apiEditRun(id, { fixes: [{ path: "materials.ceramic_white.metallic", value: 0.2 }] });
    expect((edited.body as { rev: number }).rev).toBe(1);
  });

  it("tells the model the real component ids, the allowed vocabulary and the request", async () => {
    const id = await makeRun();
    const model = fakeModel({ explanation: "nothing to do", fixes: [] });
    await apiAiEdit(id, { instruction: "make it taller" }, { provider: model });

    const request = model.seen[0]!;
    expect(request.instruction).toContain("make it taller");
    expect(request.schemaHint).toContain("components.<component_id>.dimensions_m.value");
    const ids = (request.context as { components: Array<{ id: string }> }).components.map((c) => c.id);
    expect(ids).toEqual(["body", "handle"]);
  });

  it("holds a real model to the repair vocabulary: out-of-vocabulary paths are retried, then a 502", async () => {
    const id = await makeRun();
    const bad = JSON.stringify({
      explanation: "Restructured it.",
      fixes: [{ path: "components.handle.geometry.kind", value: 1, reason: "x" }],
    });
    const replies = [bad, bad];
    const client = {
      name: "fake",
      model: "m",
      async complete() {
        return replies.shift() ?? bad;
      },
    };
    const result = await apiAiEdit(id, { instruction: "change the geometry" }, { provider: new LlmModelProvider(client) });
    expect(result.status).toBe(502);
    expect((result.body as { error: string }).error).toBe("LLM_INVALID_OUTPUT");
    expect(replies).toHaveLength(0); // it was asked twice: the original and one retry
  });

  it("drops fixes that name a component that does not exist and reports why", async () => {
    const id = await makeRun();
    const model = fakeModel({
      explanation: "Resized two parts.",
      fixes: [
        { path: "components.handle.dimensions_m.value", value: [0.09, 0.064, 0.012], reason: "ok" },
        { path: "components.lid.dimensions_m.value", value: [1, 1, 1], reason: "no such part" },
      ],
    });
    const body = (await apiAiEdit(id, { instruction: "resize" }, { provider: model })).body as {
      fixes: Array<{ path: string }>;
      skipped: Array<{ path: string; reason: string }>;
    };
    expect(body.fixes.map((f) => f.path)).toEqual(["components.handle.dimensions_m.value"]);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]?.path).toBe("components.lid.dimensions_m.value");
  });

  it("validates the instruction", async () => {
    const id = await makeRun();
    const model = fakeModel({ explanation: "x", fixes: [] });
    expect((await apiAiEdit(id, { instruction: "   " }, { provider: model })).status).toBe(400);
    expect((await apiAiEdit(id, { instruction: "x".repeat(2001) }, { provider: model })).status).toBe(400);
    expect((await apiAiEdit("aied_nope", { instruction: "hi" }, { provider: model })).status).toBe(404);
  });

  it("explains how to configure a model when none is set", async () => {
    const id = await makeRun();
    const saved = process.env["KING3D_LLM_PROVIDER"];
    delete process.env["KING3D_LLM_PROVIDER"];
    try {
      const result = await apiAiEdit(id, { instruction: "make it taller" });
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).toContain("KING3D_LLM_PROVIDER");
    } finally {
      if (saved !== undefined) process.env["KING3D_LLM_PROVIDER"] = saved;
    }
  });
});

describe("apiLlmStatus", () => {
  it("reports the configuration without any secret", async () => {
    const saved = { p: process.env["KING3D_LLM_PROVIDER"], k: process.env["KING3D_LLM_API_KEY"] };
    process.env["KING3D_LLM_PROVIDER"] = "anthropic";
    process.env["KING3D_LLM_API_KEY"] = "sk-ant-should-not-leak";
    try {
      const result = await apiLlmStatus();
      expect(result.body).toEqual({ configured: true, provider: "anthropic", model: "claude-opus-5-5" });
      expect(JSON.stringify(result.body)).not.toContain("should-not-leak");
    } finally {
      for (const [key, value] of [["KING3D_LLM_PROVIDER", saved.p], ["KING3D_LLM_API_KEY", saved.k]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
