import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "../src/core/config.ts";
import { buildSpecRequest } from "../src/pipeline/analyze.ts";
import { completeDraft, SpecDraft, safeParseSceneSpec } from "../src/spec/scene-spec.ts";

const mugJson = JSON.parse(readFileSync(join(paths.root, "src", "spec", "fixtures", "mug.json"), "utf8"));

/** The fixture minus the fields the pipeline fills in - i.e. a valid draft. */
function draftJson(): Record<string, unknown> {
  const { spec_version, id, created_at, source, ...rest } = structuredClone(mugJson);
  void spec_version;
  void id;
  void created_at;
  void source;
  return rest;
}

describe("SpecDraft", () => {
  it("accepts a draft of the fixture", () => {
    expect(SpecDraft.safeParse(draftJson()).success).toBe(true);
  });

  it("rejects the bookkeeping fields it is not meant to supply", () => {
    // The run id and timestamp belong to the pipeline; accepting them from an
    // answer invites two sources of truth for what a run is called.
    const withId = { ...draftJson(), id: "made_up" };
    expect(SpecDraft.safeParse(withId).success).toBe(false);
  });

  it("rejects a misspelled key rather than silently dropping it", () => {
    const typo = { ...draftJson(), componets: [] };
    expect(SpecDraft.safeParse(typo).success).toBe(false);
  });

  it("applies the same cross-reference checks as the full spec", () => {
    const broken = draftJson() as { components: Array<{ material: string }> };
    broken.components[0]!.material = "nope";
    const result = SpecDraft.safeParse(broken);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("unknown material");
  });

  it("still requires at least one component and one material", () => {
    expect(SpecDraft.safeParse({ ...draftJson(), components: [] }).success).toBe(false);
    expect(SpecDraft.safeParse({ ...draftJson(), materials: [] }).success).toBe(false);
  });
});

describe("completeDraft", () => {
  it("supplies the bookkeeping fields and yields a valid spec", () => {
    const draft = SpecDraft.parse(draftJson());
    const spec = completeDraft(draft, { id: "run_42", source: { image: "reference.png" } });

    expect(spec.id).toBe("run_42");
    expect(spec.spec_version).toBe(1);
    expect(spec.source.image).toBe("reference.png");
    expect(Number.isNaN(Date.parse(spec.created_at))).toBe(false);
    expect(safeParseSceneSpec(spec).success).toBe(true);
  });

  it("keeps everything the draft said", () => {
    const draft = SpecDraft.parse(draftJson());
    const spec = completeDraft(draft, { id: "x", source: {} });
    expect(spec.components.map((c) => c.id)).toEqual(["body", "handle"]);
    expect(spec.components[1]?.rotation_deg.value).toEqual([90, 0, 0]);
  });
});

describe("spec request", () => {
  it("shows the image and teaches the whole modelling vocabulary", () => {
    const request = buildSpecRequest({ imagePath: "/tmp/ref.png", example: { hint: true } });

    expect(request.stage).toBe("spec");
    expect(request.images[0]?.path).toBe("/tmp/ref.png");
    // The builder executes the answer literally, so the request has to name every
    // strategy and primitive it is allowed to use.
    for (const token of ["primitive", "hollow", "cut", "array", "cylinder", "torus", "uv_sphere"]) {
      expect(request.schemaHint, token).toContain(token);
    }
    expect(request.instruction).toMatch(/Metres, always/);
    expect(request.instruction).toMatch(/\+Z is up/);
    expect(request.context?.["worked_example"]).toEqual({ hint: true });
  });

  it("insists on honest provenance, since the review stage relies on it", () => {
    const request = buildSpecRequest({ imagePath: "/tmp/ref.png" });
    expect(request.instruction).toMatch(/claiming to have\s+seen something you inferred is not/);
  });

  it("asks differently when working from a prompt with no image", () => {
    const request = buildSpecRequest({ prompt: "a wooden stool with three legs" });
    expect(request.images).toHaveLength(0);
    expect(request.instruction).toContain("a wooden stool with three legs");
    expect(request.instruction).toMatch(/everything is inference/);
  });
});
