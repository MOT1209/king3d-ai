import { describe, expect, it } from "vitest";
import type { MeshStats, SceneInfo } from "../src/integrations/blender/protocol.ts";
import { evaluateGeneratedGates } from "../src/pipeline/generative-gates.ts";
import { parseGenerativeSpec, type GenerativeSpec } from "../src/spec/generative-spec.ts";

function mesh(overrides: Partial<MeshStats> = {}): MeshStats {
  return {
    name: "mesh",
    verts: 100,
    edges: 200,
    faces: 98,
    tris: 180,
    ngons: 0,
    non_manifold_edges: 0,
    loose_verts: 0,
    has_uv: true,
    uv_layers: ["UVMap"],
    material_slots: 1,
    empty_material_slots: 0,
    dimensions: [1, 1, 1],
    world_dimensions: [1, 1, 1],
    bbox_min: [0, 0, 0],
    bbox_max: [1, 1, 1],
    scale: [1, 1, 1],
    transform_applied: true,
    volume: 1,
    ...overrides,
  };
}

function scene(materials = 1): SceneInfo {
  return {
    blender_version: "4.2",
    python_version: "3.11",
    engine: "BLENDER_WORKBENCH",
    scene_name: "Scene",
    objects: [],
    counts: {
      objects: 1,
      meshes: 1,
      cameras: 0,
      lights: 0,
      materials,
      orphan_meshes: 0,
      orphan_materials: 0,
      total_tris: 180,
    },
  };
}

function specWith(quality: Partial<GenerativeSpec["quality"]> = {}): GenerativeSpec {
  return parseGenerativeSpec({
    id: "t",
    created_at: new Date().toISOString(),
    source: { prompt: "a mug" },
    generator: { name: "trellis2", model: "4B" },
    object: { name: "mug", category: "generated" },
    quality: { target_tris: 20000, max_materials: 4, require_uv: true, require_manifold: false, ...quality },
  });
}

function gate(report: ReturnType<typeof evaluateGeneratedGates>, id: string) {
  return report.gates.find((g) => g.id === id);
}

describe("evaluateGeneratedGates", () => {
  it("passes a clean, manifold, UV'd mesh within budget", () => {
    const report = evaluateGeneratedGates({ spec: specWith(), meshes: [mesh()], scene: scene() });
    expect(report.passed).toBe(true);
    expect(gate(report, "generative_integrity")?.passed).toBe(true);
    expect(gate(report, "non_empty")?.passed).toBe(true);
    expect(gate(report, "uv_present")?.passed).toBe(true);
  });

  it("warns (not fails) on non-manifold when require_manifold is false", () => {
    const report = evaluateGeneratedGates({
      spec: specWith({ require_manifold: false }),
      meshes: [mesh({ non_manifold_edges: 7 })],
      scene: scene(),
    });
    const g = gate(report, "generative_integrity");
    expect(g?.passed).toBe(false);
    expect(g?.severity).toBe("warning");
    // A warning does not block the overall verdict.
    expect(report.passed).toBe(true);
  });

  it("hard-fails on non-manifold when require_manifold is true", () => {
    const report = evaluateGeneratedGates({
      spec: specWith({ require_manifold: true }),
      meshes: [mesh({ non_manifold_edges: 7 })],
      scene: scene(),
    });
    const g = gate(report, "generative_integrity");
    expect(g?.severity).toBe("error");
    expect(report.passed).toBe(false);
  });

  it("fails when PBR materials did not survive (empty slot)", () => {
    const report = evaluateGeneratedGates({
      spec: specWith(),
      meshes: [mesh({ material_slots: 1, empty_material_slots: 1 })],
      scene: scene(),
    });
    expect(gate(report, "materials_assigned")?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("fails uv_present only when require_uv is set and a mesh lacks UV", () => {
    const withReq = evaluateGeneratedGates({
      spec: specWith({ require_uv: true }),
      meshes: [mesh({ has_uv: false, uv_layers: [] })],
      scene: scene(),
    });
    expect(gate(withReq, "uv_present")?.passed).toBe(false);

    const withoutReq = evaluateGeneratedGates({
      spec: specWith({ require_uv: false }),
      meshes: [mesh({ has_uv: false, uv_layers: [] })],
      scene: scene(),
    });
    expect(gate(withoutReq, "uv_present")).toBeUndefined();
  });

  it("adds export gates only once export data is present", () => {
    const before = evaluateGeneratedGates({ spec: specWith(), meshes: [mesh()], scene: scene() });
    expect(gate(before, "export_round_trip")).toBeUndefined();

    const after = evaluateGeneratedGates({
      spec: specWith(),
      meshes: [mesh({ tris: 180 })],
      scene: scene(),
      exported: { tris: 180, objects: 1, sizeBytes: 2048 },
    });
    expect(gate(after, "export_round_trip")?.passed).toBe(true);
    expect(gate(after, "export_written")?.passed).toBe(true);
  });
});
