/**
 * Wire contract between the TypeScript core and the Blender-side Python.
 *
 * One schema pair per command: params are validated before sending, results
 * after receiving, so a drift between the two sides fails loudly at the boundary
 * instead of silently producing a broken scene.
 */
import { z } from "zod";

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const RGBA = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const RGB = z.tuple([z.number(), z.number(), z.number()]);

export const PrimitiveKind = z.enum([
  "cube",
  "uv_sphere",
  "ico_sphere",
  "cylinder",
  "cone",
  "torus",
  "plane",
  "circle",
  "empty",
]);

export const ModifierType = z.enum([
  "BEVEL",
  "SUBSURF",
  "SOLIDIFY",
  "MIRROR",
  "ARRAY",
  "DECIMATE",
  "WELD",
  "BOOLEAN",
  "SIMPLE_DEFORM",
  "SCREW",
]);

export const LightType = z.enum(["POINT", "SUN", "SPOT", "AREA"]);

/** Mesh statistics returned by inspect.mesh - the raw input to the geometry gates. */
export const MeshStats = z.object({
  name: z.string(),
  verts: z.number(),
  edges: z.number(),
  faces: z.number(),
  tris: z.number(),
  ngons: z.number(),
  non_manifold_edges: z.number(),
  loose_verts: z.number(),
  has_uv: z.boolean(),
  uv_layers: z.array(z.string()),
  material_slots: z.number(),
  empty_material_slots: z.number(),
  dimensions: Vec3,
  bbox_min: Vec3,
  bbox_max: Vec3,
  scale: Vec3,
  transform_applied: z.boolean(),
  volume: z.number(),
});
export type MeshStats = z.infer<typeof MeshStats>;

export const ObjectSummary = z.object({
  name: z.string(),
  type: z.string(),
  location: Vec3,
  rotation_euler: Vec3,
  scale: Vec3,
  dimensions: Vec3,
  tris: z.number(),
  materials: z.array(z.string()),
  parent: z.string().nullable(),
  collection: z.string().nullable(),
  visible: z.boolean(),
});
export type ObjectSummary = z.infer<typeof ObjectSummary>;

export const SceneInfo = z.object({
  blender_version: z.string(),
  python_version: z.string(),
  engine: z.string(),
  scene_name: z.string(),
  objects: z.array(ObjectSummary),
  counts: z.object({
    objects: z.number(),
    meshes: z.number(),
    cameras: z.number(),
    lights: z.number(),
    materials: z.number(),
    orphan_meshes: z.number(),
    orphan_materials: z.number(),
    total_tris: z.number(),
  }),
});
export type SceneInfo = z.infer<typeof SceneInfo>;

export const MaterialSpec = z.object({
  name: z.string(),
  base_color: RGBA.default([0.8, 0.8, 0.8, 1]),
  metallic: z.number().min(0).max(1).default(0),
  roughness: z.number().min(0).max(1).default(0.5),
  ior: z.number().optional(),
  alpha: z.number().min(0).max(1).optional(),
  emission_color: RGB.optional(),
  emission_strength: z.number().optional(),
});
export type MaterialSpec = z.infer<typeof MaterialSpec>;

const okResult = z.object({ ok: z.literal(true) });
const namedResult = z.object({ name: z.string() });

/** The single source of truth for command names, inputs and outputs. */
export const COMMANDS = {
  ping: {
    params: z.object({}).default({}),
    result: z.object({
      pong: z.literal(true),
      blender_version: z.string(),
      python_version: z.string(),
      binary: z.string(),
    }),
  },
  "scene.info": {
    params: z.object({}).default({}),
    result: SceneInfo,
  },
  "scene.reset": {
    params: z.object({
      keep_camera: z.boolean().default(false),
      keep_lights: z.boolean().default(false),
    }),
    result: okResult,
  },
  "object.create": {
    params: z.object({
      kind: PrimitiveKind,
      name: z.string(),
      location: Vec3.default([0, 0, 0]),
      rotation_euler: Vec3.default([0, 0, 0]),
      scale: Vec3.default([1, 1, 1]),
      /** When set, the object is rescaled so its bounding box matches these sizes. */
      dimensions: Vec3.optional(),
      options: z.record(z.union([z.number(), z.boolean(), z.string()])).default({}),
      parent: z.string().optional(),
      collection: z.string().optional(),
      shade_smooth: z.boolean().default(false),
    }),
    result: namedResult.extend({ dimensions: Vec3 }),
  },
  "object.transform": {
    params: z.object({
      name: z.string(),
      location: Vec3.optional(),
      rotation_euler: Vec3.optional(),
      scale: Vec3.optional(),
      delta_location: Vec3.optional(),
      apply: z.boolean().default(false),
      origin_to: z.enum(["geometry", "bounds", "world"]).optional(),
    }),
    result: namedResult.extend({ dimensions: Vec3 }),
  },
  "object.delete": {
    params: z.object({ names: z.array(z.string()) }),
    result: z.object({ deleted: z.array(z.string()) }),
  },
  "object.modifier": {
    params: z.object({
      object: z.string(),
      type: ModifierType,
      name: z.string().optional(),
      settings: z.record(z.union([z.number(), z.boolean(), z.string(), Vec3])).default({}),
      apply: z.boolean().default(false),
    }),
    result: namedResult.extend({ applied: z.boolean() }),
  },
  "object.boolean": {
    params: z.object({
      object: z.string(),
      cutter: z.string(),
      operation: z.enum(["DIFFERENCE", "UNION", "INTERSECT"]).default("DIFFERENCE"),
      apply: z.boolean().default(true),
      delete_cutter: z.boolean().default(true),
    }),
    result: namedResult.extend({ applied: z.boolean() }),
  },
  "object.join": {
    params: z.object({ objects: z.array(z.string()).min(2), into: z.string() }),
    result: namedResult,
  },
  "material.assign": {
    params: z.object({
      object: z.string(),
      material: MaterialSpec,
      slot: z.number().int().min(0).default(0),
    }),
    result: namedResult.extend({ material: z.string(), slot: z.number() }),
  },
  "light.create": {
    params: z.object({
      name: z.string(),
      type: LightType.default("AREA"),
      location: Vec3,
      rotation_euler: Vec3.optional(),
      look_at: Vec3.optional(),
      energy: z.number().default(100),
      color: RGB.default([1, 1, 1]),
      size: z.number().optional(),
      angle: z.number().optional(),
    }),
    result: namedResult,
  },
  "camera.set": {
    params: z.object({
      name: z.string().default("Camera"),
      location: Vec3,
      look_at: Vec3.optional(),
      rotation_euler: Vec3.optional(),
      lens: z.number().default(50),
      sensor_width: z.number().default(36),
      type: z.enum(["PERSP", "ORTHO"]).default("PERSP"),
      ortho_scale: z.number().optional(),
      make_active: z.boolean().default(true),
    }),
    result: namedResult,
  },
  "camera.frame": {
    params: z.object({
      name: z.string().default("Camera"),
      /** Objects to fit in frame; empty means every visible mesh. */
      targets: z.array(z.string()).default([]),
      /** Azimuth/elevation in degrees, orbiting the target bounding sphere. */
      azimuth: z.number().default(35),
      elevation: z.number().default(20),
      margin: z.number().default(1.15),
      lens: z.number().default(50),
      make_active: z.boolean().default(true),
    }),
    result: namedResult.extend({ location: Vec3, distance: z.number() }),
  },
  "world.set": {
    params: z.object({
      color: RGB.default([0.05, 0.05, 0.05]),
      strength: z.number().default(1),
      transparent: z.boolean().default(false),
    }),
    result: okResult,
  },
  "render.still": {
    params: z.object({
      output: z.string(),
      resolution: z.tuple([z.number().int(), z.number().int()]).default([800, 800]),
      samples: z.number().int().default(32),
      engine: z.enum(["EEVEE", "CYCLES", "WORKBENCH"]).default("EEVEE"),
      film_transparent: z.boolean().default(false),
      camera: z.string().optional(),
    }),
    result: z.object({
      output: z.string(),
      engine: z.string(),
      width: z.number(),
      height: z.number(),
    }),
  },
  "render.views": {
    params: z.object({
      output_dir: z.string(),
      views: z
        .array(z.enum(["front", "back", "left", "right", "top", "three_quarter"]))
        .default(["front", "right", "three_quarter", "top"]),
      targets: z.array(z.string()).default([]),
      resolution: z.tuple([z.number().int(), z.number().int()]).default([512, 512]),
      samples: z.number().int().default(32),
      engine: z.enum(["EEVEE", "CYCLES", "WORKBENCH"]).default("EEVEE"),
      margin: z.number().default(1.15),
    }),
    result: z.object({ images: z.array(z.object({ view: z.string(), path: z.string() })) }),
  },
  "render.contact_sheet": {
    params: z.object({
      output: z.string(),
      images: z.array(z.object({ path: z.string(), label: z.string() })).min(1),
      columns: z.number().int().min(1).default(3),
      cell: z.number().int().default(512),
    }),
    result: z.object({ output: z.string(), width: z.number(), height: z.number() }),
  },
  "inspect.mesh": {
    params: z.object({ object: z.string() }),
    result: MeshStats,
  },
  "inspect.all": {
    params: z.object({ objects: z.array(z.string()).default([]) }),
    result: z.object({ meshes: z.array(MeshStats) }),
  },
  "optimize.decimate": {
    params: z.object({
      objects: z.array(z.string()).default([]),
      target_tris: z.number().int().positive(),
      min_ratio: z.number().min(0.01).max(1).default(0.1),
    }),
    result: z.object({ before_tris: z.number(), after_tris: z.number(), ratio: z.number() }),
  },
  "uv.unwrap": {
    params: z.object({
      objects: z.array(z.string()).default([]),
      method: z.enum(["SMART", "UNWRAP"]).default("SMART"),
      angle_limit: z.number().default(66),
      island_margin: z.number().default(0.02),
    }),
    result: z.object({ unwrapped: z.array(z.string()) }),
  },
  "export.glb": {
    params: z.object({
      output: z.string(),
      objects: z.array(z.string()).default([]),
      apply_modifiers: z.boolean().default(true),
      y_up: z.boolean().default(true),
    }),
    result: z.object({
      output: z.string(),
      size_bytes: z.number(),
      exported: z.array(z.string()),
    }),
  },
  "import.glb": {
    params: z.object({ path: z.string(), reset_scene: z.boolean().default(true) }),
    result: z.object({ objects: z.array(z.string()), total_tris: z.number() }),
  },
  "python.exec": {
    params: z.object({ code: z.string() }),
    result: z.object({ stdout: z.string(), value: z.string().nullable() }),
  },
} as const;

export type CommandName = keyof typeof COMMANDS;
export type CommandParams<K extends CommandName> = z.input<(typeof COMMANDS)[K]["params"]>;
export type CommandResult<K extends CommandName> = z.output<(typeof COMMANDS)[K]["result"]>;

export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[];

export function isCommandName(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name);
}

/** A request as it travels over the wire. */
export interface BridgeRequest {
  id: string;
  cmd: CommandName;
  params: unknown;
}

export const BridgeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  traceback: z.string().optional(),
});

export const BridgeResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: BridgeErrorSchema.optional(),
  logs: z.array(z.string()).default([]),
  duration_ms: z.number().default(0),
});
export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

/** Where a headless invocation actually spent its time - startup usually dominates. */
export const JobTimingsSchema = z.object({
  job_read_ms: z.number(),
  scene_open_ms: z.number(),
  handlers_import_ms: z.number(),
  batch_ms: z.number(),
  save_ms: z.number(),
});
export type JobTimings = z.infer<typeof JobTimingsSchema>;

export const JobResultSchema = z.object({
  ok: z.boolean(),
  responses: z.array(BridgeResponseSchema),
  blender_version: z.string().optional(),
  python_version: z.string().optional(),
  saved_blend: z.string().nullable().optional(),
  timings: JobTimingsSchema.optional(),
  fatal: BridgeErrorSchema.optional(),
});
export type JobResult = z.infer<typeof JobResultSchema>;
