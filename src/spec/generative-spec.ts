/**
 * GenerativeSpec - the source of truth for a run that starts from a generated
 * base mesh instead of being built procedurally from primitives.
 *
 * This is the generative mode's counterpart to SceneSpec. The two are kept
 * separate on purpose: SceneSpec describes an object as a closed set of
 * primitive strategies the deterministic builder executes, and its gates reason
 * about named components, identity parts and proportions. A mesh produced by
 * TRELLIS.2 is a single opaque surface - none of that component vocabulary
 * applies to it. Rather than bend SceneSpec to hold something it was not
 * designed for, generative mode gets its own small schema that records where
 * the mesh came from and the deterministic recipe used to make it game-ready.
 *
 * As with SceneSpec, everything here is serialised to disk (generative-spec.json)
 * and re-parsed on build, so a generative run is reproducible from one JSON file:
 * the same spec drives the same import -> repair -> optimise -> export sequence.
 */
import { z } from "zod";
import { RGBA } from "../integrations/blender/protocol.ts";
import { QualityTargets, RenderProfile } from "./scene-spec.ts";

export const GENERATIVE_SPEC_VERSION = 1;

/**
 * The deterministic repair recipe applied to the generated mesh in Blender.
 * Explicit rather than hard-coded so a run records exactly how its mesh was
 * cleaned, and re-running the spec reproduces it. Mirrors the params of the
 * `repair.clean` Blender command.
 */
export const RepairRecipe = z.object({
  /** Vertices closer than this are welded (metres). */
  weld_distance_m: z.number().nonnegative().default(0.0001),
  delete_loose: z.boolean().default(true),
  dissolve_degenerate: z.boolean().default(true),
  fill_holes: z.boolean().default(true),
  recalc_normals: z.boolean().default(true),
});
export type RepairRecipe = z.infer<typeof RepairRecipe>;

export const GeneratorInfo = z.object({
  name: z.enum(["trellis2", "hunyuan3d"]),
  model: z.string().default("4B"),
  /** Recorded for provenance; which inference endpoint produced the mesh. */
  base_url: z.string().optional(),
  seed: z.number().int().optional(),
});
export type GeneratorInfo = z.infer<typeof GeneratorInfo>;

export const GenerativeSpecFields = z
  .object({
    spec_version: z.literal(GENERATIVE_SPEC_VERSION).default(GENERATIVE_SPEC_VERSION),
    id: z.string(),
    created_at: z.string(),
    source: z.object({
      image: z.string().optional(),
      prompt: z.string().optional(),
    }),
    generator: GeneratorInfo,
    object: z.object({
      name: z.string(),
      category: z.string().default("generated"),
      description: z.string().default(""),
    }),
    repair: RepairRecipe.default({}),
    // Default material King3D applies to the imported mesh. TRELLIS runs in
    // GEOMETRY-ONLY mode (the textured-GLB export depends on the non-commercial
    // nvdiffrast rasterizer, so it is avoided), which means the base mesh arrives
    // with no material. King3D assigns this one and unwraps a fresh UV, producing
    // a game-ready GLB with a clean PBR material slot of its own.
    material: z
      .object({
        name: z.string().default("trellis_base"),
        base_color: RGBA.default([0.8, 0.8, 0.8, 1]),
        metallic: z.number().min(0).max(1).default(0),
        roughness: z.number().min(0).max(1).default(0.6),
      })
      .default({}),
    // Reused verbatim from SceneSpec so the two modes share one definition of
    // "game-ready" (triangle budget, UV requirement, manifold requirement, ...)
    // and one render profile.
    quality: QualityTargets.default({}),
    render: RenderProfile.default({}),
  })
  .strict();

export const GenerativeSpec = GenerativeSpecFields;
export type GenerativeSpec = z.infer<typeof GenerativeSpec>;

/** Draft shape accepted from a front end before the pipeline stamps id/created_at. */
export const GenerativeSpecDraft = GenerativeSpecFields.omit({
  spec_version: true,
  id: true,
  created_at: true,
});
export type GenerativeSpecDraft = z.infer<typeof GenerativeSpecDraft>;

export function parseGenerativeSpec(data: unknown): GenerativeSpec {
  return GenerativeSpec.parse(data);
}

export function safeParseGenerativeSpec(data: unknown): z.SafeParseReturnType<unknown, GenerativeSpec> {
  return GenerativeSpec.safeParse(data);
}
