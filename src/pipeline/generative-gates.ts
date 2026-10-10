/**
 * Quality gates for generative mode.
 *
 * The SceneSpec gates in gates.ts reason about named components, identity parts
 * and per-component proportions - none of which exist for a single opaque mesh
 * imported from TRELLIS.2. This evaluator runs the subset that *is* meaningful
 * for a generated-then-repaired mesh, plus one gate specific to generative
 * output: `generative_integrity`, which is where the common defect of a
 * generative pipeline - non-manifold geometry left over after the best-effort
 * repair pass - surfaces as a hard failure.
 *
 * Like the SceneSpec gates, everything here is measured, not judged: it reads
 * the numbers `inspect.all` returns after repair + optimise and gives the same
 * verdict every time.
 */
import type { MeshStats, SceneInfo } from "../integrations/blender/protocol.ts";
import type { GenerativeSpec } from "../spec/generative-spec.ts";
import { fail, pass, type GateReport, type GateResult, type Scores } from "./gates.ts";

export interface GenerativeGateInputs {
  spec: GenerativeSpec;
  meshes: MeshStats[];
  scene: SceneInfo;
  /** Present only after the export stage has run. */
  exported?: { tris: number; objects: number; sizeBytes: number };
  /** Present only after a review; 0-1. */
  similarity?: number;
}

export function evaluateGeneratedGates(inputs: GenerativeGateInputs): GateReport {
  const { spec, meshes, scene } = inputs;
  const gates: GateResult[] = [];

  // --- generative integrity (the defining gate for this mode) -------------
  // After repair.clean, lingering non-manifold edges are the primary signal
  // that a generative mesh is not game-ready. Hard-fail only when the spec
  // requires a manifold result; otherwise warn, since some generative meshes
  // cannot be made fully manifold without retopology (out of scope here).
  const nonManifold = meshes.filter((m) => m.non_manifold_edges > 0);
  gates.push(
    nonManifold.length === 0
      ? pass("generative_integrity", "mesh is manifold after repair")
      : fail(
          "generative_integrity",
          spec.quality.require_manifold ? "error" : "warning",
          `non-manifold edges remain after repair: ${nonManifold
            .map((m) => `${m.name}(${m.non_manifold_edges})`)
            .join(", ")}`,
          { meshes: nonManifold.map((m) => ({ name: m.name, edges: m.non_manifold_edges })) },
        ),
  );

  const loose = meshes.filter((m) => m.loose_verts > 0);
  gates.push(
    loose.length === 0
      ? pass("generative_loose", "no loose geometry after repair")
      : fail("generative_loose", "warning", `loose vertices remain in ${loose.map((m) => m.name).join(", ")}`, {
          meshes: loose.map((m) => ({ name: m.name, loose: m.loose_verts })),
        }),
  );

  // n-gons are expected from marching-cubes output and resolved by the exporter's
  // triangulation; report them for visibility but never fail on them.
  const ngons = meshes.filter((m) => m.ngons > 0);
  if (ngons.length > 0) {
    gates.push(
      fail("generative_ngons", "warning", "n-gons present (expected pre-triangulation; informational)", {
        meshes: ngons.map((m) => ({ name: m.name, ngons: m.ngons })),
      }),
    );
  }

  // --- geometry presence --------------------------------------------------
  const emptyMesh = meshes.filter((m) => m.faces === 0);
  gates.push(
    emptyMesh.length === 0
      ? pass("non_empty", "every mesh has geometry")
      : fail("non_empty", "error", `empty meshes: ${emptyMesh.map((m) => m.name).join(", ")}`, {
          meshes: emptyMesh.map((m) => m.name),
        }),
  );

  // --- materials (PBR must survive import + decimation) -------------------
  const unpainted = meshes.filter((m) => m.material_slots === 0 || m.empty_material_slots > 0);
  gates.push(
    unpainted.length === 0
      ? pass("materials_assigned", "every mesh carries a material (PBR preserved)")
      : fail("materials_assigned", "error", `missing materials on ${unpainted.map((m) => m.name).join(", ")}`, {
          meshes: unpainted.map((m) => m.name),
        }),
  );

  gates.push(
    scene.counts.materials <= spec.quality.max_materials
      ? pass("material_budget", `${scene.counts.materials}/${spec.quality.max_materials} materials`)
      : fail(
          "material_budget",
          "warning",
          `${scene.counts.materials} materials exceeds the budget of ${spec.quality.max_materials}`,
          { measured: scene.counts.materials, budget: spec.quality.max_materials },
        ),
  );

  // --- optimisation -------------------------------------------------------
  const totalTris = meshes.reduce((sum, m) => sum + m.tris, 0);
  gates.push(
    totalTris <= spec.quality.target_tris
      ? pass("triangle_budget", `${totalTris}/${spec.quality.target_tris} triangles`)
      : fail("triangle_budget", "warning", `${totalTris} triangles exceeds the budget of ${spec.quality.target_tris}`, {
          measured: totalTris,
          budget: spec.quality.target_tris,
        }),
  );

  if (spec.quality.require_uv) {
    const withoutUv = meshes.filter((m) => !m.has_uv);
    gates.push(
      withoutUv.length === 0
        ? pass("uv_present", "every mesh is unwrapped")
        : fail("uv_present", "error", `no UV map on ${withoutUv.map((m) => m.name).join(", ")}`, {
            meshes: withoutUv.map((m) => m.name),
          }),
    );
  }

  // --- export -------------------------------------------------------------
  if (inputs.exported) {
    gates.push(
      inputs.exported.tris === totalTris
        ? pass("export_round_trip", `re-imported GLB matches at ${totalTris} triangles`)
        : fail("export_round_trip", "error", "the exported GLB does not re-import with the same triangle count", {
            inScene: totalTris,
            inFile: inputs.exported.tris,
          }),
    );
    gates.push(
      inputs.exported.sizeBytes > 0
        ? pass("export_written", `${inputs.exported.sizeBytes} bytes written`)
        : fail("export_written", "error", "the exported file is empty"),
    );
  }

  return {
    gates,
    scores: score(gates, inputs, totalTris),
    passed: !gates.some((g) => !g.passed && g.severity === "error"),
  };
}

/** Weighted 0-1 scores, mirroring the dimensions gates.ts reports. */
function score(gates: GateResult[], inputs: GenerativeGateInputs, totalTris: number): Scores {
  const verdict = (ids: string[]): number => {
    const relevant = gates.filter((g) => ids.includes(g.id));
    if (relevant.length === 0) return 1;
    const weightOf = (g: GateResult): number => (g.severity === "error" ? 1 : 0.4);
    const total = relevant.reduce((sum, g) => sum + weightOf(g), 0);
    const earned = relevant.reduce((sum, g) => sum + (g.passed ? weightOf(g) : 0), 0);
    return total === 0 ? 1 : earned / total;
  };

  const geometry = verdict(["generative_integrity", "generative_loose", "generative_ngons", "non_empty"]);
  const material = verdict(["materials_assigned", "material_budget"]);

  const budget = inputs.spec.quality.target_tris;
  const headroom = totalTris <= budget ? 1 - (totalTris / budget) * 0.3 : Math.max(0, budget / totalTris);
  const optimization = Math.min(1, headroom * verdict(["triangle_budget", "uv_present"]));

  const exportScore = inputs.exported ? verdict(["export_round_trip", "export_written"]) : 0;

  const parts: Array<[number, number]> = [
    [geometry, 0.35],
    [material, 0.2],
    [optimization, 0.15],
  ];
  if (inputs.exported) parts.push([exportScore, 0.1]);
  if (inputs.similarity !== undefined) parts.push([inputs.similarity, 0.2]);

  const weightTotal = parts.reduce((sum, [, w]) => sum + w, 0);
  const overall = parts.reduce((sum, [value, w]) => sum + value * w, 0) / weightTotal;

  const round = (v: number): number => Math.round(v * 1000) / 1000;
  const scores: Scores = {
    geometry: round(geometry),
    material: round(material),
    optimization: round(optimization),
    export: round(exportScore),
    overall: round(overall),
  };
  if (inputs.similarity !== undefined) scores.similarity = round(inputs.similarity);
  return scores;
}
