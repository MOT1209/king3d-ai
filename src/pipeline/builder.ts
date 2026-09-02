/**
 * SceneSpec -> Blender command batches.
 *
 * Entirely deterministic: no model is consulted here. The spec decides what the
 * object is, and this file decides only how to say that to Blender. Keeping the
 * translation mechanical is what makes a repair reproducible - re-running the
 * same spec produces the same scene.
 */
import { Batch } from "../integrations/blender/backend.ts";
import type { CommandParams } from "../integrations/blender/protocol.ts";
import {
  componentsInBuildOrder,
  objectScale,
  type ComponentSpec,
  type MaterialSpecEntry,
  type SceneSpec,
} from "../spec/scene-spec.ts";

const DEG = Math.PI / 180;

function toRadians(degrees: readonly [number, number, number]): [number, number, number] {
  return [degrees[0] * DEG, degrees[1] * DEG, degrees[2] * DEG];
}

function materialParams(material: MaterialSpecEntry): CommandParams<"material.assign">["material"] {
  const out: CommandParams<"material.assign">["material"] = {
    name: material.id,
    base_color: material.base_color,
    metallic: material.metallic,
    roughness: material.roughness,
  };
  if (material.ior !== undefined) out.ior = material.ior;
  if (material.alpha !== undefined) out.alpha = material.alpha;
  if (material.emission_color !== undefined) out.emission_color = material.emission_color;
  if (material.emission_strength !== undefined) out.emission_strength = material.emission_strength;
  return out;
}

/** Cutter name for a component; kept unique so a failed batch is diagnosable. */
function cutterName(componentId: string, index: number): string {
  return `${componentId}__cut${index}`;
}

/**
 * Blockout: every component as a plain box at its stated size and place.
 *
 * The point is to test proportion and layout before any detail exists, so a
 * wrong overall shape is caught while it is still cheap to fix.
 */
export function buildBlockoutBatch(spec: SceneSpec): Batch {
  const batch = new Batch();
  batch.add("scene.reset", { keep_camera: false, keep_lights: false });

  for (const component of componentsInBuildOrder(spec)) {
    batch.add("object.create", {
      kind: "cube",
      name: component.id,
      location: component.position_m.value,
      rotation_euler: toRadians(component.rotation_deg.value),
      dimensions: component.dimensions_m.value,
      ...(component.parent ? { parent: component.parent } : {}),
    });
  }
  return batch;
}

/** Full geometry for one component, including any boolean cutting. */
function addComponent(batch: Batch, component: ComponentSpec): void {
  const { geometry } = component;
  const dimensions = component.dimensions_m.value;
  const location = component.position_m.value;
  const rotation = toRadians(component.rotation_deg.value);

  switch (geometry.kind) {
    case "primitive": {
      batch.add("object.create", {
        kind: geometry.primitive,
        name: component.id,
        location,
        rotation_euler: rotation,
        dimensions,
        options: geometry.options,
        shade_smooth: geometry.shade_smooth,
        ...(component.parent ? { parent: component.parent } : {}),
      });
      break;
    }

    case "hollow": {
      const t = geometry.wall_thickness_m;
      batch.add("object.create", {
        kind: geometry.primitive,
        name: component.id,
        location,
        rotation_euler: rotation,
        dimensions,
        options: geometry.options,
        shade_smooth: geometry.shade_smooth,
        ...(component.parent ? { parent: component.parent } : {}),
      });

      // The cavity is the same primitive inset by the wall thickness. When the
      // object is open on a face, the cavity is shifted so it pierces that face
      // and leaves a floor of exactly `t` on the opposite one.
      const cavity: [number, number, number] = [
        Math.max(dimensions[0] - 2 * t, t * 0.1),
        Math.max(dimensions[1] - 2 * t, t * 0.1),
        Math.max(dimensions[2] - 2 * t, t * 0.1),
      ];
      const offset: [number, number, number] = [0, 0, 0];
      switch (geometry.open) {
        case "top":
          cavity[2] = dimensions[2];
          offset[2] = t;
          break;
        case "bottom":
          cavity[2] = dimensions[2];
          offset[2] = -t;
          break;
        case "front":
          cavity[1] = dimensions[1];
          offset[1] = -t;
          break;
        case "none":
          break;
      }

      const cutter = cutterName(component.id, 0);
      batch.add("object.create", {
        kind: geometry.primitive,
        name: cutter,
        location: [location[0] + offset[0], location[1] + offset[1], location[2] + offset[2]],
        rotation_euler: rotation,
        dimensions: cavity,
        options: geometry.options,
      });
      batch.add("object.boolean", {
        object: component.id,
        cutter,
        operation: "DIFFERENCE",
        apply: true,
        delete_cutter: true,
      });
      break;
    }

    case "cut": {
      batch.add("object.create", {
        kind: geometry.primitive,
        name: component.id,
        location,
        rotation_euler: rotation,
        dimensions,
        options: geometry.options,
        shade_smooth: geometry.shade_smooth,
        ...(component.parent ? { parent: component.parent } : {}),
      });
      geometry.cutters.forEach((cut, index) => {
        const name = cutterName(component.id, index);
        batch.add("object.create", {
          kind: cut.primitive,
          name,
          location: [
            location[0] + cut.offset_m[0],
            location[1] + cut.offset_m[1],
            location[2] + cut.offset_m[2],
          ],
          rotation_euler: toRadians(cut.rotation_deg),
          dimensions: cut.dimensions_m,
          options: cut.options,
        });
        batch.add("object.boolean", {
          object: component.id,
          cutter: name,
          operation: "DIFFERENCE",
          apply: true,
          delete_cutter: true,
        });
      });
      break;
    }

    case "array": {
      batch.add("object.create", {
        kind: geometry.primitive,
        name: component.id,
        location,
        rotation_euler: rotation,
        dimensions,
        options: geometry.options,
        shade_smooth: geometry.shade_smooth,
        ...(component.parent ? { parent: component.parent } : {}),
      });
      batch.add("object.modifier", {
        object: component.id,
        type: "ARRAY",
        name: "ai3d_array",
        settings: {
          count: geometry.count,
          use_relative_offset: false,
          use_constant_offset: true,
          constant_offset_displace: geometry.step_m,
        },
        apply: true,
      });
      break;
    }
  }
}

/** The real model: full geometry plus materials, built from an empty scene. */
export function buildGeometryBatch(spec: SceneSpec): Batch {
  const batch = new Batch();
  batch.add("scene.reset", { keep_camera: false, keep_lights: false });

  for (const component of componentsInBuildOrder(spec)) {
    addComponent(batch, component);
  }

  const byId = new Map(spec.materials.map((m) => [m.id, m]));
  for (const component of spec.components) {
    const material = byId.get(component.material);
    if (!material) continue; // schema validation already rejected this case
    batch.add("material.assign", { object: component.id, material: materialParams(material), slot: 0 });
  }
  return batch;
}

/**
 * Lights placed on a sphere around the subject.
 *
 * Positions are relative to the object's size so the same lighting spec works
 * for a mug and a car without re-tuning energies by hand.
 */
export function buildLightingBatch(spec: SceneSpec): Batch {
  const batch = new Batch();
  batch.add("world.set", {
    color: spec.lighting.world_color,
    strength: spec.lighting.world_strength,
    transparent: false,
  });

  const scale = objectScale(spec);
  const centre = spec.object.overall_dimensions_m.value;
  const target: [number, number, number] = [0, 0, centre[2] / 2];

  const lights = spec.lighting.lights.length > 0 ? spec.lighting.lights : defaultThreePoint();
  for (const light of lights) {
    const distance = scale * light.distance_factor;
    const az = light.azimuth_deg * DEG;
    const el = light.elevation_deg * DEG;
    batch.add("light.create", {
      name: light.name,
      type: light.type,
      location: [
        target[0] + distance * Math.sin(az) * Math.cos(el),
        target[1] - distance * Math.cos(az) * Math.cos(el),
        target[2] + distance * Math.sin(el),
      ],
      look_at: target,
      // Inverse-square falloff means energy has to track the distance we placed it at.
      energy: light.energy * distance * distance,
      color: light.color,
      size: scale * light.size_factor,
    });
  }
  return batch;
}

/** Standard three-point rig, used when the spec does not name its own lights. */
function defaultThreePoint(): SceneSpec["lighting"]["lights"] {
  return [
    { name: "key", type: "AREA", azimuth_deg: 45, elevation_deg: 35, distance_factor: 2.5, energy: 90, color: [1, 0.98, 0.95], size_factor: 1.2 },
    { name: "fill", type: "AREA", azimuth_deg: -55, elevation_deg: 10, distance_factor: 3, energy: 30, color: [0.95, 0.97, 1], size_factor: 2 },
    { name: "rim", type: "AREA", azimuth_deg: 170, elevation_deg: 45, distance_factor: 2.5, energy: 55, color: [1, 1, 1], size_factor: 1 },
  ];
}

export interface RenderPaths {
  viewsDir: string;
  sheetPath: string;
  referencePath?: string;
}

/**
 * Render the standard views and composite them into one captioned sheet.
 *
 * The review stage looks at exactly one image, so the reference (when there is
 * one) is the first cell and the renders follow it.
 */
export function buildReviewRenderBatch(spec: SceneSpec, paths: RenderPaths, engine?: RenderProfileEngine): Batch {
  const batch = new Batch();
  const resolution: [number, number] = [spec.render.resolution, spec.render.resolution];

  batch.add("render.views", {
    output_dir: paths.viewsDir,
    views: spec.render.views,
    targets: [],
    resolution,
    samples: spec.render.samples,
    engine: engine ?? spec.render.review_engine,
    margin: spec.camera.margin,
  });

  const cells = [
    ...(paths.referencePath ? [{ path: paths.referencePath, label: "reference" }] : []),
    ...spec.render.views.map((view) => ({
      path: `${paths.viewsDir}/${view}.png`,
      label: view.replace("_", " "),
    })),
  ];
  batch.add("render.contact_sheet", {
    output: paths.sheetPath,
    images: cells,
    columns: cells.length <= 4 ? 2 : 3,
    cell: spec.render.resolution,
  });
  return batch;
}

type RenderProfileEngine = SceneSpec["render"]["review_engine"];

/** Measurements for the gates: per-mesh stats plus the whole-scene summary. */
export function buildInspectBatch(spec: SceneSpec): Batch {
  return new Batch()
    .add("inspect.all", { objects: spec.components.map((c) => c.id) })
    .add("scene.info", {});
}

/** Game-ready pass: unwrap, meet the triangle budget, write and verify a GLB. */
export function buildExportBatch(spec: SceneSpec, glbPath: string): Batch {
  const objects = spec.components.map((c) => c.id);
  const batch = new Batch();
  if (spec.quality.require_uv) {
    batch.add("uv.unwrap", { objects, method: "SMART", angle_limit: 66, island_margin: 0.02 });
  }
  batch.add("optimize.decimate", { objects, target_tris: spec.quality.target_tris, min_ratio: 0.1 });
  batch.add("export.glb", { output: glbPath, objects, apply_modifiers: true, y_up: true });
  return batch;
}

/** Re-import the exported file into a scratch scene to prove it actually loads. */
export function buildExportVerifyBatch(glbPath: string): Batch {
  return new Batch().add("import.glb", { path: glbPath, reset_scene: true }).add("scene.info", {});
}
