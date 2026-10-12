import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.ts";
import { isAi3dError } from "../src/core/errors.ts";
import { acquireMeshGen, generatorInfo, isGeneratorName, listGenerators } from "../src/integrations/meshgen/index.ts";
import { apiCreateGenerativeRun, apiGenerators } from "../src/server/routes.ts";
import { listRuns } from "../src/server/runs-list.ts";
import { runPaths } from "../src/pipeline/run.ts";
import { parseGenerativeSpec } from "../src/spec/generative-spec.ts";

describe("generator registry", () => {
  it("knows both generators and flags the licence restriction on Hunyuan3D only", () => {
    expect(isGeneratorName("trellis2")).toBe(true);
    expect(isGeneratorName("hunyuan3d")).toBe(true);
    expect(isGeneratorName("midjourney")).toBe(false);
    expect(generatorInfo("trellis2").restriction).toBeNull();
    expect(generatorInfo("hunyuan3d").restriction).toMatch(/EU, UK and South Korea/);
  });

  it("reports Hunyuan3D as not configured until a URL is set", () => {
    const off = listGenerators(loadConfig({}));
    expect(off.find((g) => g.name === "trellis2")?.configured).toBe(true);
    expect(off.find((g) => g.name === "hunyuan3d")?.configured).toBe(false);

    const on = listGenerators(loadConfig({ hunyuan3dUrl: "http://127.0.0.1:8901" }));
    expect(on.find((g) => g.name === "hunyuan3d")?.configured).toBe(true);
  });

  it("refuses an unconfigured Hunyuan3D with a message that names the licence", () => {
    try {
      acquireMeshGen(loadConfig({}), "hunyuan3d");
      expect.unreachable();
    } catch (e) {
      expect(isAi3dError(e) && e.code).toBe("CONFIG_INVALID");
      expect((e as Error).message).toContain("KING3D_GEN_HUNYUAN3D_URL");
      expect((e as Error).message).toContain("EU, UK and South Korea");
    }
  });

  it("returns an http provider for a configured Hunyuan3D and the mock for TRELLIS in mock mode", () => {
    expect(acquireMeshGen(loadConfig({ hunyuan3dUrl: "http://127.0.0.1:8901" }), "hunyuan3d").kind).toBe("http");
    expect(acquireMeshGen(loadConfig({ trellisMode: "mock" }), "trellis2").kind).toBe("mock");
  });
});

describe("generative spec", () => {
  const base = {
    id: "g",
    created_at: new Date().toISOString(),
    source: { prompt: "a mug" },
    object: { name: "mug" },
  };

  it("accepts either generator and rejects an unknown one", () => {
    expect(parseGenerativeSpec({ ...base, generator: { name: "hunyuan3d", model: "2.1" } }).generator.name).toBe("hunyuan3d");
    expect(() => parseGenerativeSpec({ ...base, generator: { name: "other" } })).toThrow();
  });
});

describe("generative routes", () => {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((id) => rm(runPaths(id).dir, { recursive: true, force: true })));
  });

  it("lists the generators without secrets", async () => {
    const body = (await apiGenerators()).body as { generators: Array<{ name: string }> };
    expect(body.generators.map((g) => g.name)).toEqual(["trellis2", "hunyuan3d"]);
  });

  it("rejects an unknown generator and an unconfigured Hunyuan3D before any run exists", async () => {
    const before = (await listRuns()).length;
    const saved = process.env["KING3D_GEN_HUNYUAN3D_URL"];
    delete process.env["KING3D_GEN_HUNYUAN3D_URL"];
    try {
      const unknown = await apiCreateGenerativeRun({ generator: "nope", prompt: "a mug" });
      expect(unknown.status).toBe(400);
      const off = await apiCreateGenerativeRun({ generator: "hunyuan3d", prompt: "a mug" });
      expect(off.status).toBe(400);
      expect(JSON.stringify(off.body)).toContain("KING3D_GEN_HUNYUAN3D_URL");
    } finally {
      if (saved !== undefined) process.env["KING3D_GEN_HUNYUAN3D_URL"] = saved;
    }
    // Nothing was created on disk by the refused requests.
    expect((await listRuns()).length).toBe(before);
  });
});
