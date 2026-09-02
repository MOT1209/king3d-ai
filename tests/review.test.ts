import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paths } from "../src/core/config.ts";
import { Ai3dError } from "../src/core/errors.ts";
import { applyRepairs, buildReviewRequest, Defect, ReviewVerdict } from "../src/pipeline/review.ts";
import { AgentInLoopProvider } from "../src/providers/agent-in-loop.ts";
import { NeedsModelInput } from "../src/providers/provider.ts";
import { safeParseSceneSpec, type SceneSpec } from "../src/spec/scene-spec.ts";

const mugJson = JSON.parse(readFileSync(join(paths.root, "src", "spec", "fixtures", "mug.json"), "utf8"));

function mugSpec(): SceneSpec {
  const parsed = safeParseSceneSpec(mugJson);
  if (!parsed.success) throw new Error("fixture invalid");
  return parsed.data;
}

function defect(overrides: Partial<Defect> = {}): Defect {
  return Defect.parse({ id: "d1", severity: "P1", problem: "something is off", ...overrides });
}

const emptyGates = {
  gates: [],
  scores: { geometry: 1, material: 1, optimization: 1, export: 1, overall: 1 },
  passed: true,
};

describe("repair paths", () => {
  it("accepts the documented editable paths", () => {
    for (const path of [
      "object.overall_dimensions_m.value",
      "components.body.dimensions_m.value",
      "components.handle.position_m.value",
      "components.handle.rotation_deg.value",
      "materials.ceramic_white.base_color",
      "materials.ceramic_white.roughness",
    ]) {
      expect(() => defect({ fix: { path, value: 1, reason: "r" } }), path).not.toThrow();
    }
  });

  it("refuses paths that would restructure the spec", () => {
    // Restructuring is a new spec, not a repair; allowing it would make a failed
    // build impossible to attribute to either the spec or the review.
    for (const path of [
      "components",
      "components.body.geometry.primitive",
      "components.body.id",
      "quality.target_tris",
      "render.review_engine",
      "components.body.dimensions_m",
      "__proto__.polluted",
    ]) {
      expect(() => defect({ fix: { path, value: 1, reason: "r" } }), path).toThrow();
    }
  });
});

describe("applyRepairs", () => {
  it("applies a valid fix and leaves the original untouched", () => {
    const spec = mugSpec();
    const result = applyRepairs(spec, [
      defect({ fix: { path: "object.overall_dimensions_m.value", value: [0.122, 0.08, 0.1], reason: "measured" } }),
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.spec.object.overall_dimensions_m.value).toEqual([0.122, 0.08, 0.1]);
    expect(spec.object.overall_dimensions_m.value).toEqual([0.116, 0.08, 0.1]);
  });

  it("marks a repaired value as inferred, because it is no longer observed", () => {
    const spec = mugSpec();
    expect(spec.components[0]?.dimensions_m.provenance).toBe("observed");
    const result = applyRepairs(spec, [
      defect({ fix: { path: "components.body.dimensions_m.value", value: [0.09, 0.09, 0.1], reason: "wider" } }),
    ]);
    expect(result.spec.components.find((c) => c.id === "body")?.dimensions_m.provenance).toBe("inferred");
  });

  it("skips a defect with no machine-applicable fix", () => {
    const result = applyRepairs(mugSpec(), [defect({ fix: null })]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/no machine-applicable fix/);
  });

  it("skips a fix pointing at a component that does not exist", () => {
    const result = applyRepairs(mugSpec(), [
      defect({ fix: { path: "components.spout.position_m.value", value: [0, 0, 0], reason: "r" } }),
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/does not resolve/);
  });

  it("skips a fix whose value has the wrong shape", () => {
    // A scalar where a vector belongs would otherwise corrupt the spec silently.
    const result = applyRepairs(mugSpec(), [
      defect({ fix: { path: "components.body.dimensions_m.value", value: 0.09, reason: "r" } }),
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/expected an array of 3 .* supplied a number/);
  });

  it("keeps nothing when the repaired spec would be invalid", () => {
    // roughness above 1 is out of range: the whole repair is rejected rather
    // than leaving a spec that passed review but cannot build.
    expect(() =>
      applyRepairs(mugSpec(), [
        defect({ fix: { path: "materials.ceramic_white.roughness", value: 5, reason: "r" } }),
      ]),
    ).toThrow(Ai3dError);
  });

  it("applies several fixes in one pass", () => {
    const result = applyRepairs(mugSpec(), [
      defect({ id: "a", fix: { path: "materials.ceramic_white.roughness", value: 0.2, reason: "r" } }),
      defect({ id: "b", fix: { path: "components.handle.position_m.value", value: [0.048, 0, 0.05], reason: "r" } }),
    ]);
    expect(result.applied.map((a) => a.defect)).toEqual(["a", "b"]);
    expect(result.spec.materials[0]?.roughness).toBe(0.2);
  });
});

describe("review request", () => {
  it("tells the reviewer which fields were inferred rather than observed", () => {
    const request = buildReviewRequest({
      spec: mugSpec(),
      sheetPath: "/tmp/sheet.png",
      referencePath: "/tmp/ref.png",
      gates: emptyGates,
      cycle: 0,
    });
    expect(request.context?.["inferred_fields"]).toContain("body.rotation_deg");
    expect(request.instruction).toMatch(/Do not report an inferred value as wrong/);
  });

  it("asks a different question when there is no reference image", () => {
    const request = buildReviewRequest({
      spec: mugSpec(),
      sheetPath: "/tmp/sheet.png",
      gates: emptyGates,
      cycle: 0,
    });
    expect(request.instruction).toMatch(/no reference image/);
  });

  it("passes failing gates through so the reviewer sees what was measured", () => {
    const request = buildReviewRequest({
      spec: mugSpec(),
      sheetPath: "/tmp/sheet.png",
      gates: {
        ...emptyGates,
        gates: [{ id: "proportions", passed: false, severity: "error", message: "too tall" }],
      },
      cycle: 1,
    });
    expect(JSON.stringify(request.context?.["failed_gates"])).toContain("too tall");
  });
});

describe("agent-in-loop provider", () => {
  async function provider() {
    const dir = await mkdtemp(join(tmpdir(), "ai3d-prompts-"));
    return { dir, provider: new AgentInLoopProvider({ promptDir: dir }) };
  }

  const request = (stage = "review") => ({
    stage,
    instruction: "Judge the render.",
    images: [{ path: "/tmp/sheet.png", label: "contact sheet" }],
    schema: ReviewVerdict,
    schemaHint: "a ReviewVerdict",
  });

  it("writes a self-contained request and reports that it is waiting", async () => {
    const { dir, provider: p } = await provider();
    await expect(p.ask(request())).rejects.toBeInstanceOf(NeedsModelInput);

    const written = await readFile(join(dir, "review.request.md"), "utf8");
    expect(written).toContain("Judge the render.");
    expect(written).toContain("/tmp/sheet.png");
    // The request must say where the answer goes, or it is not self-contained.
    expect(written).toContain("review.response.json");
  });

  it("returns the parsed verdict once an answer exists", async () => {
    const { dir, provider: p } = await provider();
    await p.ask(request()).catch(() => undefined);
    await writeFile(
      join(dir, "review.response.json"),
      JSON.stringify({ similarity: 0.9, verdict: "accept", observations: "looks right" }),
      "utf8",
    );
    const verdict = await p.ask(request());
    expect(verdict.similarity).toBe(0.9);
    expect(verdict.defects).toEqual([]);
  });

  it("accepts an answer wrapped in a markdown code fence", async () => {
    const { dir, provider: p } = await provider();
    await p.ask(request()).catch(() => undefined);
    await writeFile(
      join(dir, "review.response.json"),
      '```json\n{"similarity":0.5,"verdict":"repair","observations":"ok"}\n```',
      "utf8",
    );
    expect((await p.ask(request())).verdict).toBe("repair");
  });

  it("rejects an answer that does not match the schema and records why", async () => {
    const { dir, provider: p } = await provider();
    await p.ask(request()).catch(() => undefined);
    await writeFile(join(dir, "review.response.json"), JSON.stringify({ similarity: 2, verdict: "maybe" }), "utf8");

    await expect(p.ask(request())).rejects.toThrow(/does not match its schema/);
    expect(await readFile(join(dir, "review.errors.txt"), "utf8")).toContain("similarity");
  });

  it("rejects an answer that is not JSON at all", async () => {
    const { dir, provider: p } = await provider();
    await p.ask(request()).catch(() => undefined);
    await writeFile(join(dir, "review.response.json"), "I think it looks fine", "utf8");
    await expect(p.ask(request())).rejects.toThrow(/not valid JSON/);
  });
});
