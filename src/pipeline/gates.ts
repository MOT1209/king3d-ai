/**
 * Deterministic quality gates.
 *
 * Everything here is measured, not judged: it runs on the numbers `inspect.all`
 * and `scene.info` return, costs no model tokens, and gives the same verdict
 * every time. Only similarity to the reference needs a pair of eyes, and that
 * arrives separately as a review score.
 */
import type { MeshStats, SceneInfo } from "../integrations/blender/protocol.ts";
import type { SceneSpec } from "../spec/scene-spec.ts";

export type GateSeverity = "error" | "warning";

export interface GateResult {
  id: string;
  passed: boolean;
  severity: GateSeverity;
  message: string;
  /** Free-form measured/expected values, kept for the repair stage to act on. */
  data?: Record<string, unknown>;
}

export interface Scores {
  geometry: number;
  material: number;
  optimization: number;
  export: number;
  /** Only set once a review has looked at the contact sheet. */
  similarity?: number;
  overall: number;
}

export interface GateReport {
  gates: GateResult[];
  scores: Scores;
  /** False when any error-severity gate failed. */
  passed: boolean;
}

export interface GateInputs {
  spec: SceneSpec;
  meshes: MeshStats[];
  scene: SceneInfo;
  /** Present only after the export stage has run. */
  exported?: { tris: number; objects: number; sizeBytes: number };
  /** Present only after a review; 0-1. */
  similarity?: number;
}

function pass(id: string, message: string, data?: Record<string, unknown>): GateResult {
  return { id, passed: true, severity: "error", message, ...(data ? { data } : {}) };
}

function fail(id: string, severity: GateSeverity, message: string, data?: Record<string, unknown>): GateResult {
  return { id, passed: false, severity, message, ...(data ? { data } : {}) };
}

/**
 * Rotation-invariant size comparison.
 *
 * A component's spec dimensions are stated in its own local frame while the
 * measurement is world-space, so a rotated part would fail a naive axis-by-axis
 * check. Sorting both triples compares shape rather than orientation, which is
 * what the blockout gate is actually asking about.
 */
function dimensionError(specDims: readonly number[], worldDims: readonly number[]): number {
  const a = [...specDims].sort((x, y) => x - y);
  const b = [...worldDims].sort((x, y) => x - y);
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    const expected = a[i] ?? 0;
    const actual = b[i] ?? 0;
    const denominator = Math.max(Math.abs(expected), 1e-6);
    worst = Math.max(worst, Math.abs(actual - expected) / denominator);
  }
  return worst;
}

export function evaluateGates(inputs: GateInputs): GateReport {
  const { spec, meshes, scene } = inputs;
  const gates: GateResult[] = [];
  const byName = new Map(meshes.map((m) => [m.name, m]));

  // --- completeness -------------------------------------------------------
  const missing = spec.components.filter((c) => !byName.has(c.id));
  gates.push(
    missing.length === 0
      ? pass("completeness", `all ${spec.components.length} components present`)
      : fail("completeness", "error", `missing components: ${missing.map((c) => c.id).join(", ")}`, {
          missing: missing.map((c) => c.id),
        }),
  );

  const missingIdentity = missing.filter((c) => c.identity_defining);
  if (missingIdentity.length > 0) {
    gates.push(
      fail(
        "identity_parts",
        "error",
        `identity-defining parts are absent: ${missingIdentity.map((c) => c.id).join(", ")}`,
        { missing: missingIdentity.map((c) => c.id) },
      ),
    );
  }

  // --- proportions --------------------------------------------------------
  const tolerance = spec.quality.dimension_tolerance;
  const offenders: Array<{ id: string; error: number; expected: number[]; measured: number[] }> = [];
  for (const component of spec.components) {
    const mesh = byName.get(component.id);
    if (!mesh) continue;
    const error = dimensionError(component.dimensions_m.value, mesh.world_dimensions);
    if (error > tolerance) {
      offenders.push({
        id: component.id,
        error: Number(error.toFixed(4)),
        expected: [...component.dimensions_m.value],
        measured: [...mesh.world_dimensions],
      });
    }
  }
  gates.push(
    offenders.length === 0
      ? pass("proportions", `every component is within ${(tolerance * 100).toFixed(0)}% of its specified size`)
      : fail("proportions", "error", `${offenders.length} component(s) exceed the size tolerance`, { offenders }),
  );

  // --- geometry hygiene ---------------------------------------------------
  const looseVerts = meshes.filter((m) => m.loose_verts > 0);
  gates.push(
    looseVerts.length === 0
      ? pass("loose_geometry", "no loose vertices")
      : fail("loose_geometry", "warning", `loose vertices in ${looseVerts.map((m) => m.name).join(", ")}`, {
          meshes: looseVerts.map((m) => ({ name: m.name, loose: m.loose_verts })),
        }),
  );

  if (spec.quality.require_manifold) {
    const nonManifold = meshes.filter((m) => m.non_manifold_edges > 0);
    gates.push(
      nonManifold.length === 0
        ? pass("manifold", "all meshes are manifold")
        : fail("manifold", "error", `non-manifold edges in ${nonManifold.map((m) => m.name).join(", ")}`, {
            meshes: nonManifold.map((m) => ({ name: m.name, edges: m.non_manifold_edges })),
          }),
    );
  }

  const emptyMesh = meshes.filter((m) => m.faces === 0);
  gates.push(
    emptyMesh.length === 0
      ? pass("non_empty", "every component has geometry")
      : fail("non_empty", "error", `empty meshes: ${emptyMesh.map((m) => m.name).join(", ")}`, {
          meshes: emptyMesh.map((m) => m.name),
        }),
  );

  // --- materials ----------------------------------------------------------
  const unpainted = meshes.filter((m) => m.material_slots === 0 || m.empty_material_slots > 0);
  gates.push(
    unpainted.length === 0
      ? pass("materials_assigned", "every mesh has a material in every slot")
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

  gates.push(
    scene.counts.orphan_materials === 0 && scene.counts.orphan_meshes === 0
      ? pass("no_orphans", "no orphaned datablocks")
      : fail("no_orphans", "warning", "the file carries orphaned meshes or materials", {
          meshes: scene.counts.orphan_meshes,
          materials: scene.counts.orphan_materials,
        }),
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
    const sameTris = inputs.exported.tris === totalTris;
    gates.push(
      sameTris
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

  return { gates, scores: score(gates, inputs, totalTris), passed: !gates.some((g) => !g.passed && g.severity === "error") };
}

/** Weighted 0-1 scores per the quality dimensions the platform reports on. */
function score(gates: GateResult[], inputs: GateInputs, totalTris: number): Scores {
  const verdict = (ids: string[]): number => {
    const relevant = gates.filter((g) => ids.includes(g.id));
    if (relevant.length === 0) return 1;
    const weightOf = (g: GateResult): number => (g.severity === "error" ? 1 : 0.4);
    const total = relevant.reduce((sum, g) => sum + weightOf(g), 0);
    const earned = relevant.reduce((sum, g) => sum + (g.passed ? weightOf(g) : 0), 0);
    return total === 0 ? 1 : earned / total;
  };

  const geometry = verdict(["completeness", "identity_parts", "proportions", "loose_geometry", "manifold", "non_empty"]);
  const material = verdict(["materials_assigned", "material_budget", "no_orphans"]);

  // Optimisation rewards staying under budget rather than merely passing:
  // a model at 20% of budget scores better than one at 99%.
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

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function formatGateReport(report: GateReport): string {
  const lines = report.gates.map((g) => {
    const mark = g.passed ? "PASS" : g.severity === "error" ? "FAIL" : "WARN";
    return `  ${mark}  ${g.id.padEnd(20)} ${g.message}`;
  });
  const s = report.scores;
  const similarity = s.similarity === undefined ? "n/a  " : s.similarity.toFixed(2);
  return (
    `${lines.join("\n")}\n\n` +
    `  geometry ${s.geometry.toFixed(2)}   material ${s.material.toFixed(2)}   ` +
    `optimization ${s.optimization.toFixed(2)}   export ${s.export.toFixed(2)}   similarity ${similarity}\n` +
    `  OVERALL ${s.overall.toFixed(2)}  -  ${report.passed ? "gates passed" : "gates failed"}\n`
  );
}
