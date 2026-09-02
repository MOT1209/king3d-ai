/**
 * The review stage: compare the render against the reference, and turn what is
 * wrong into edits the pipeline can apply.
 *
 * A defect is only useful if something can act on it, so each one may carry a
 * fix expressed as a path into the spec plus a new value. Repairs therefore
 * change the spec and re-run the deterministic build, rather than poking at the
 * Blender scene directly - which keeps the spec the single source of truth and
 * every repair reproducible.
 */
import { z } from "zod";
import { Ai3dError } from "../core/errors.ts";
import type { VisionRequest } from "../providers/provider.ts";
import { inferredFields, safeParseSceneSpec, type SceneSpec } from "../spec/scene-spec.ts";
import type { GateReport } from "./gates.ts";

/**
 * The editable surface of a spec.
 *
 * Deliberately narrow: the review may adjust sizes, placements, rotations and
 * material values, but may not restructure the object. Restructuring is a new
 * spec, not a repair, and letting a review rewrite arbitrary fields would make
 * failures impossible to reason about.
 */
export const RepairPath = z
  .string()
  .regex(
    /^(object\.overall_dimensions_m\.value|components\.[a-z0-9_]+\.(dimensions_m|position_m|rotation_deg)\.value|materials\.[a-z0-9_]+\.(base_color|metallic|roughness))$/,
    "fix paths may only target component dimensions/position/rotation, material colour/metallic/roughness, or the overall size",
  );

export const Defect = z.object({
  id: z.string(),
  /** P0 blocks acceptance, P1 should be fixed, P2 is a note. */
  severity: z.enum(["P0", "P1", "P2"]),
  /** Which part of the object is wrong, in the spec's own vocabulary. */
  component: z.string().optional(),
  problem: z.string().min(1),
  fix: z
    .object({
      path: RepairPath,
      value: z.union([z.number(), z.array(z.number())]),
      reason: z.string(),
    })
    .nullable()
    .default(null),
});
export type Defect = z.infer<typeof Defect>;

export const ReviewVerdict = z.object({
  /** 0-1: how closely the render matches the reference overall. */
  similarity: z.number().min(0).max(1),
  verdict: z.enum(["accept", "repair"]),
  /** What is actually visible in the sheet, before judging it. */
  observations: z.string().min(1),
  defects: z.array(Defect).default([]),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

const SCHEMA_HINT = `A JSON object:

{
  "similarity": 0.0-1.0,
  "verdict": "accept" | "repair",
  "observations": "what you actually see in each cell, before judging it",
  "defects": [
    {
      "id": "short_slug",
      "severity": "P0" | "P1" | "P2",
      "component": "component id, when the defect belongs to one",
      "problem": "what is wrong, stated as a comparison against the reference",
      "fix": null | {
        "path": "components.<id>.dimensions_m.value",
        "value": [0.08, 0.08, 0.12],
        "reason": "why this value"
      }
    }
  ]
}

Allowed fix paths, and nothing else:
  object.overall_dimensions_m.value            [x, y, z] in metres
  components.<id>.dimensions_m.value           [x, y, z] in metres, before rotation
  components.<id>.position_m.value             [x, y, z] in metres
  components.<id>.rotation_deg.value           [x, y, z] in degrees
  materials.<id>.base_color                    [r, g, b, a] each 0-1
  materials.<id>.metallic                      0-1
  materials.<id>.roughness                     0-1

Leave "fix" as null when a defect needs restructuring rather than a value change;
say so in "problem" instead. Set "verdict" to "repair" if any P0 defect exists.`;

export interface ReviewContext {
  spec: SceneSpec;
  sheetPath: string;
  referencePath?: string;
  gates: GateReport;
  /** Which repair cycle this is, so the reviewer knows what was already tried. */
  cycle: number;
  previousDefects?: Defect[];
}

export function buildReviewRequest(context: ReviewContext): VisionRequest<ReviewVerdict> {
  const { spec, gates } = context;
  const hasReference = context.referencePath !== undefined;

  const instruction = hasReference
    ? `Compare the rendered views of this model against the reference image and judge how well they match.

The contact sheet's first cell is the reference; the rest are renders of the model from
labelled angles. Work through each render against the reference before scoring.

Judge what is actually there: shape, proportion, the presence and placement of each part,
and surface colour. Ignore differences in lighting style, background and render quality -
the renders use a fast preview engine and are not meant to look photographic.

Some values in the spec were inferred rather than observed, because a single image cannot
show every side. Do not report an inferred value as wrong unless the render contradicts
something the reference actually shows.`
    : `Judge whether these rendered views depict the object described in the spec below, and
whether it is internally coherent.

There is no reference image, so score similarity against the written description: is every
described part present, are the proportions plausible for this kind of object, and is
anything obviously broken, floating, intersecting or missing?`;

  const failedGates = gates.gates.filter((g) => !g.passed);

  const context_: Record<string, unknown> = {
    object: {
      name: spec.object.name,
      category: spec.object.category,
      description: spec.object.description,
      overall_dimensions_m: spec.object.overall_dimensions_m.value,
    },
    components: spec.components.map((c) => ({
      id: c.id,
      role: c.role,
      identity_defining: c.identity_defining,
      dimensions_m: c.dimensions_m.value,
      position_m: c.position_m.value,
      rotation_deg: c.rotation_deg.value,
      material: c.material,
    })),
    materials: spec.materials.map((m) => ({
      id: m.id,
      base_color: m.base_color,
      metallic: m.metallic,
      roughness: m.roughness,
      appearance: m.appearance,
    })),
    inferred_fields: inferredFields(spec),
    measured_scores: gates.scores,
    failed_gates: failedGates.map((g) => ({ id: g.id, severity: g.severity, message: g.message, data: g.data })),
    repair_cycle: context.cycle,
    ...(context.previousDefects && context.previousDefects.length > 0
      ? { defects_from_last_cycle: context.previousDefects.map((d) => ({ id: d.id, problem: d.problem })) }
      : {}),
  };

  return {
    stage: "review",
    instruction,
    images: [{ path: context.sheetPath, label: "contact sheet (reference first, then renders)" }],
    schema: ReviewVerdict,
    schemaHint: SCHEMA_HINT,
    context: context_,
  };
}

export interface RepairOutcome {
  spec: SceneSpec;
  applied: Array<{ defect: string; path: string; from: unknown; to: unknown }>;
  skipped: Array<{ defect: string; reason: string }>;
}

/**
 * Apply the fixes a review proposed, then re-validate the whole spec.
 *
 * A fix that would produce an invalid spec is rejected outright rather than
 * half-applied: it is better to keep a coherent spec and report the refusal.
 */
export function applyRepairs(spec: SceneSpec, defects: Defect[]): RepairOutcome {
  const draft = structuredClone(spec) as SceneSpec;
  const applied: RepairOutcome["applied"] = [];
  const skipped: RepairOutcome["skipped"] = [];

  for (const defect of defects) {
    if (!defect.fix) {
      skipped.push({ defect: defect.id, reason: "no machine-applicable fix was proposed" });
      continue;
    }
    const target = resolveTarget(draft, defect.fix.path);
    if (!target) {
      skipped.push({ defect: defect.id, reason: `"${defect.fix.path}" does not resolve in this spec` });
      continue;
    }
    const before = target.get();
    if (!shapeMatches(before, defect.fix.value)) {
      skipped.push({
        defect: defect.id,
        reason: `expected ${describeShape(before)} at "${defect.fix.path}" but the fix supplied ${describeShape(defect.fix.value)}`,
      });
      continue;
    }
    target.set(defect.fix.value);
    applied.push({ defect: defect.id, path: defect.fix.path, from: before, to: defect.fix.value });
  }

  const revalidated = safeParseSceneSpec(draft);
  if (!revalidated.success) {
    throw new Ai3dError("SPEC_INVALID", "the repaired spec no longer validates; no changes were kept", {
      issues: revalidated.error.issues,
      attempted: applied,
    });
  }
  return { spec: revalidated.data, applied, skipped };
}

interface Target {
  get(): unknown;
  set(value: unknown): void;
}

/** Resolve one of the allowed repair paths to a getter/setter pair. */
function resolveTarget(spec: SceneSpec, path: string): Target | null {
  const parts = path.split(".");

  if (path === "object.overall_dimensions_m.value") {
    return {
      get: () => spec.object.overall_dimensions_m.value,
      set: (v) => {
        spec.object.overall_dimensions_m.value = v as [number, number, number];
        // The value is now the reviewer's, not the reference's.
        spec.object.overall_dimensions_m.provenance = "inferred";
      },
    };
  }

  if (parts[0] === "components") {
    const component = spec.components.find((c) => c.id === parts[1]);
    if (!component) return null;
    const field = parts[2] as "dimensions_m" | "position_m" | "rotation_deg";
    if (field !== "dimensions_m" && field !== "position_m" && field !== "rotation_deg") return null;
    return {
      get: () => component[field].value,
      set: (v) => {
        component[field].value = v as [number, number, number];
        component[field].provenance = "inferred";
      },
    };
  }

  if (parts[0] === "materials") {
    const material = spec.materials.find((m) => m.id === parts[1]);
    if (!material) return null;
    const field = parts[2] as "base_color" | "metallic" | "roughness";
    if (field !== "base_color" && field !== "metallic" && field !== "roughness") return null;
    return {
      get: () => material[field],
      set: (v) => {
        if (field === "base_color") material.base_color = v as [number, number, number, number];
        else material[field] = v as number;
        material.provenance = "inferred";
      },
    };
  }

  return null;
}

function shapeMatches(before: unknown, value: unknown): boolean {
  if (typeof before === "number") return typeof value === "number";
  if (Array.isArray(before)) return Array.isArray(value) && value.length === before.length;
  return false;
}

function describeShape(value: unknown): string {
  if (typeof value === "number") return "a number";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value;
}
