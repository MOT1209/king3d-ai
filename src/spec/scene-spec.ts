/**
 * SceneSpec - the source of truth for a generated asset.
 *
 * Every stage after analysis reads this and nothing else, so the reasoning about
 * "what are we building" happens once and is then executed deterministically.
 *
 * The defining feature is provenance. A single photograph shows one side of an
 * object; everything else is inference. Recording which is which lets the review
 * stage judge an inferred back panel differently from an observed handle, and
 * stops the pipeline from presenting a guess as a measurement.
 */
import { z } from "zod";
import { LightType, PrimitiveKind, RGB, RGBA, Vec3 } from "../integrations/blender/protocol.ts";

export const SPEC_VERSION = 1;

export const Provenance = z.enum(["observed", "inferred"]);
export type Provenance = z.infer<typeof Provenance>;

/** A value plus how we came to believe it. */
export function measured<T extends z.ZodTypeAny>(inner: T) {
  return z.object({
    value: inner,
    provenance: Provenance,
    /** 0-1. Anything below 0.5 is a candidate for a clarifying question. */
    confidence: z.number().min(0).max(1).default(0.5),
    note: z.string().optional(),
  });
}

export const MeasuredVec3 = measured(Vec3);
export const MeasuredNumber = measured(z.number());
export const MeasuredString = measured(z.string());

export const Symmetry = z.enum(["none", "mirror_x", "mirror_y", "radial"]);

/**
 * How a component's geometry gets built. Deliberately a small closed set: the
 * builder must be able to execute every strategy without improvisation.
 */
export const GeometryStrategy = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("primitive"),
    primitive: PrimitiveKind,
    options: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}),
    shade_smooth: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("hollow"),
    /** Outer shell primitive; the cavity is cut from it. */
    primitive: PrimitiveKind,
    options: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}),
    wall_thickness_m: z.number().positive(),
    /** Which face the opening is on. "none" makes a sealed hollow. */
    open: z.enum(["top", "bottom", "front", "none"]).default("top"),
    shade_smooth: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("cut"),
    primitive: PrimitiveKind,
    options: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}),
    /** Cutters are placed relative to this component's own origin. */
    cutters: z
      .array(
        z.object({
          primitive: PrimitiveKind,
          options: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}),
          dimensions_m: Vec3,
          offset_m: Vec3.default([0, 0, 0]),
          rotation_deg: Vec3.default([0, 0, 0]),
        }),
      )
      .min(1),
    shade_smooth: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("array"),
    primitive: PrimitiveKind,
    options: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}),
    count: z.number().int().min(2).max(64),
    /** Per-copy offset in metres. */
    step_m: Vec3,
    shade_smooth: z.boolean().default(false),
  }),
]);
export type GeometryStrategy = z.infer<typeof GeometryStrategy>;

export const ComponentSpec = z.object({
  /** Stable identifier; also the Blender object name. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, "component ids are lowercase snake_case so they are safe as Blender object names"),
  name: z.string(),
  /** What this part is for, in the object's own terms ("handle", "lid", "leg"). */
  role: z.string(),
  geometry: GeometryStrategy,
  dimensions_m: MeasuredVec3,
  position_m: MeasuredVec3,
  rotation_deg: MeasuredVec3.default({ value: [0, 0, 0], provenance: "inferred", confidence: 0.5 }),
  /** Reference into `materials` by id. */
  material: z.string(),
  parent: z.string().optional(),
  /** Identity-defining parts must survive optimisation and must not be dropped. */
  identity_defining: z.boolean().default(false),
  notes: z.string().optional(),
});
export type ComponentSpec = z.infer<typeof ComponentSpec>;

export const MaterialSpecEntry = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/),
  name: z.string(),
  base_color: RGBA,
  metallic: z.number().min(0).max(1).default(0),
  roughness: z.number().min(0).max(1).default(0.5),
  ior: z.number().optional(),
  alpha: z.number().min(0).max(1).optional(),
  emission_color: RGB.optional(),
  emission_strength: z.number().optional(),
  provenance: Provenance.default("inferred"),
  /** Plain-language description of the surface, used in the review prompt. */
  appearance: z.string().optional(),
});
export type MaterialSpecEntry = z.infer<typeof MaterialSpecEntry>;

export const LightSpec = z.object({
  name: z.string(),
  type: LightType.default("AREA"),
  /** Placed on a sphere around the subject, so lighting survives a rescale. */
  azimuth_deg: z.number(),
  elevation_deg: z.number(),
  distance_factor: z.number().positive().default(2.5),
  energy: z.number().positive(),
  color: RGB.default([1, 1, 1]),
  size_factor: z.number().positive().default(1),
});

export const LightingSpec = z.object({
  preset: z.enum(["studio_three_point", "soft_top", "outdoor_sun", "custom"]).default("studio_three_point"),
  world_color: RGB.default([0.05, 0.05, 0.06]),
  world_strength: z.number().min(0).default(1),
  lights: z.array(LightSpec).default([]),
});

export const CameraSpec = z.object({
  azimuth_deg: z.number().default(35),
  elevation_deg: z.number().default(20),
  lens_mm: z.number().positive().default(50),
  margin: z.number().min(1).default(1.15),
});

export const QualityTargets = z.object({
  target_tris: z.number().int().positive().default(20_000),
  max_materials: z.number().int().positive().default(4),
  require_uv: z.boolean().default(true),
  require_manifold: z.boolean().default(false),
  /** Tolerance for the blockout gate's dimension comparison. */
  dimension_tolerance: z.number().min(0).max(1).default(0.1),
});

export const RenderProfile = z.object({
  /** Structural passes use the cheap engine; the material review may not. */
  review_engine: z.enum(["WORKBENCH", "EEVEE", "CYCLES"]).default("WORKBENCH"),
  final_engine: z.enum(["WORKBENCH", "EEVEE", "CYCLES"]).default("WORKBENCH"),
  resolution: z.number().int().min(128).max(2048).default(384),
  samples: z.number().int().min(1).default(16),
  views: z
    .array(z.enum(["front", "back", "left", "right", "top", "three_quarter"]))
    .default(["front", "right", "three_quarter", "top"]),
});
export type RenderProfile = z.infer<typeof RenderProfile>;

/**
 * The spec fields themselves, before cross-reference validation.
 *
 * Kept separate so the analysis stage can ask for a draft without the
 * bookkeeping fields (id, timestamp, source) that the pipeline fills in itself.
 */
export const SceneSpecFields = z
  .object({
    spec_version: z.literal(SPEC_VERSION).default(SPEC_VERSION),
    id: z.string(),
    created_at: z.string(),
    source: z.object({
      image: z.string().optional(),
      prompt: z.string().optional(),
    }),
    object: z.object({
      category: z.string(),
      name: z.string(),
      description: z.string(),
      overall_dimensions_m: MeasuredVec3,
      symmetry: measured(Symmetry),
      /** What was visible in the reference, so the review knows what to trust. */
      visible_from: z.string().default("unknown"),
      occluded_regions: z.array(z.string()).default([]),
    }),
    components: z.array(ComponentSpec).min(1),
    materials: z.array(MaterialSpecEntry).min(1),
    lighting: LightingSpec.default({}),
    camera: CameraSpec.default({}),
    quality: QualityTargets.default({}),
    render: RenderProfile.default({}),
  })
  .strict();

/**
 * Cross-reference checks, shared by the full spec and the analysis draft.
 *
 * These are the errors a schema alone cannot catch: names that point at nothing,
 * and names that point at each other.
 */
function checkReferences(
  spec: { components: ComponentSpec[]; materials: MaterialSpecEntry[] },
  ctx: z.RefinementCtx,
): void {
  const materialIds = new Set(spec.materials.map((m) => m.id));
  const componentIds = new Set<string>();

  for (const component of spec.components) {
    if (componentIds.has(component.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components"],
        message: `duplicate component id "${component.id}"`,
      });
    }
    componentIds.add(component.id);

    if (!materialIds.has(component.material)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components"],
        message: `component "${component.id}" references unknown material "${component.material}"`,
      });
    }
  }

  for (const component of spec.components) {
    if (component.parent && !componentIds.has(component.parent)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components"],
        message: `component "${component.id}" has unknown parent "${component.parent}"`,
      });
    }
    if (component.parent === component.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components"],
        message: `component "${component.id}" cannot be its own parent`,
      });
    }
  }

  // An unused material is usually a sign the spec was edited inconsistently.
  const used = new Set(spec.components.map((c) => c.material));
  for (const material of spec.materials) {
    if (!used.has(material.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["materials"],
        message: `material "${material.id}" is not used by any component`,
      });
    }
  }
}

export const SceneSpec = SceneSpecFields.superRefine(checkReferences);

export type SceneSpec = z.infer<typeof SceneSpec>;

/**
 * What the analysis stage is asked to produce.
 *
 * The bookkeeping fields are omitted because they are the pipeline's to fill in;
 * asking a reviewer to invent a run id and a timestamp only invites drift.
 */
export const SpecDraft = SceneSpecFields.omit({
  spec_version: true,
  id: true,
  created_at: true,
  source: true,
}).superRefine(checkReferences);

export type SpecDraft = z.infer<typeof SpecDraft>;

/** Complete a draft into a full spec by supplying what the pipeline knows. */
export function completeDraft(
  draft: SpecDraft,
  meta: { id: string; source: { image?: string; prompt?: string } },
): SceneSpec {
  return parseSceneSpec({
    ...draft,
    spec_version: SPEC_VERSION,
    id: meta.id,
    created_at: new Date().toISOString(),
    source: meta.source,
  });
}

/** Parse untrusted spec JSON, with a readable error listing every problem. */
export function parseSceneSpec(data: unknown): SceneSpec {
  return SceneSpec.parse(data);
}

export function safeParseSceneSpec(data: unknown): z.SafeParseReturnType<unknown, SceneSpec> {
  return SceneSpec.safeParse(data);
}

/** Components in an order where a parent always precedes its children. */
export function componentsInBuildOrder(spec: SceneSpec): ComponentSpec[] {
  const byId = new Map(spec.components.map((c) => [c.id, c]));
  const emitted = new Set<string>();
  const ordered: ComponentSpec[] = [];

  const visit = (component: ComponentSpec, seen: Set<string>): void => {
    if (emitted.has(component.id)) return;
    if (seen.has(component.id)) return; // cycle; validation reports it separately
    seen.add(component.id);
    if (component.parent) {
      const parent = byId.get(component.parent);
      if (parent) visit(parent, seen);
    }
    emitted.add(component.id);
    ordered.push(component);
  };

  for (const component of spec.components) visit(component, new Set());
  return ordered;
}

/** Longest side of the object, used to scale lighting distance and clip planes. */
export function objectScale(spec: SceneSpec): number {
  return Math.max(...spec.object.overall_dimensions_m.value, 0.001);
}

/** Every field whose value was inferred rather than seen, for the review prompt. */
export function inferredFields(spec: SceneSpec): string[] {
  const out: string[] = [];
  if (spec.object.overall_dimensions_m.provenance === "inferred") out.push("object.overall_dimensions_m");
  if (spec.object.symmetry.provenance === "inferred") out.push("object.symmetry");
  for (const component of spec.components) {
    for (const [field, value] of [
      ["dimensions_m", component.dimensions_m],
      ["position_m", component.position_m],
      ["rotation_deg", component.rotation_deg],
    ] as const) {
      if (value.provenance === "inferred") out.push(`${component.id}.${field}`);
    }
  }
  for (const material of spec.materials) {
    if (material.provenance === "inferred") out.push(`material.${material.id}`);
  }
  return out;
}
