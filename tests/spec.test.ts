import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "../src/core/config.ts";
import {
  componentsInBuildOrder,
  inferredFields,
  objectScale,
  safeParseSceneSpec,
  type SceneSpec,
} from "../src/spec/scene-spec.ts";
import {
  buildBlockoutBatch,
  buildExportBatch,
  buildGeometryBatch,
  buildLightingBatch,
} from "../src/pipeline/builder.ts";

const mugJson = JSON.parse(readFileSync(join(paths.root, "src", "spec", "fixtures", "mug.json"), "utf8"));

function mugSpec(): SceneSpec {
  const parsed = safeParseSceneSpec(mugJson);
  if (!parsed.success) throw new Error(`fixture invalid: ${parsed.error.message}`);
  return parsed.data;
}

describe("scene spec", () => {
  it("accepts the mug fixture and fills defaults", () => {
    const spec = mugSpec();
    expect(spec.components).toHaveLength(2);
    // Defaults the fixture does not state.
    expect(spec.lighting.preset).toBe("studio_three_point");
    expect(spec.components[0]?.identity_defining).toBe(true);
    expect(spec.components[1]?.rotation_deg.value).toEqual([90, 0, 0]);
  });

  it("rejects a component pointing at a material that does not exist", () => {
    const broken = structuredClone(mugJson);
    broken.components[0].material = "not_a_material";
    const result = safeParseSceneSpec(broken);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("unknown material");
  });

  it("rejects duplicate component ids", () => {
    const broken = structuredClone(mugJson);
    broken.components[1].id = broken.components[0].id;
    const result = safeParseSceneSpec(broken);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("duplicate component id");
  });

  it("rejects an unused material, which signals an inconsistent edit", () => {
    const broken = structuredClone(mugJson);
    broken.materials.push({
      id: "orphan",
      name: "Unused",
      base_color: [1, 0, 0, 1],
      metallic: 0,
      roughness: 0.5,
    });
    const result = safeParseSceneSpec(broken);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("not used by any component");
  });

  it("rejects an id that would be unsafe as a Blender object name", () => {
    const broken = structuredClone(mugJson);
    broken.components[0].id = "Mug Body!";
    expect(safeParseSceneSpec(broken).success).toBe(false);
  });

  it("orders parents before their children", () => {
    const nested = structuredClone(mugJson);
    nested.components[1].parent = "body";
    const spec = safeParseSceneSpec(nested);
    expect(spec.success).toBe(true);
    const order = componentsInBuildOrder(spec.data!).map((c) => c.id);
    expect(order.indexOf("body")).toBeLessThan(order.indexOf("handle"));
  });

  it("rejects a parent that does not exist", () => {
    const broken = structuredClone(mugJson);
    broken.components[1].parent = "ghost";
    expect(JSON.stringify(safeParseSceneSpec(broken).error?.issues)).toContain("unknown parent");
  });

  it("reports the object scale from its longest side", () => {
    expect(objectScale(mugSpec())).toBeCloseTo(0.116, 5);
  });

  it("lists inferred fields so the review can weigh them differently", () => {
    const spec = mugSpec();
    const inferred = inferredFields(spec);
    // Everything in the fixture is observed except the defaulted rotation of the body.
    expect(inferred).toContain("body.rotation_deg");
    expect(inferred).not.toContain("handle.position_m");
  });
});

describe("builder", () => {
  it("blocks out one box per component", () => {
    const batch = buildBlockoutBatch(mugSpec());
    const commands = batch.requests.map((r) => r.cmd);
    expect(commands[0]).toBe("scene.reset");
    expect(commands.filter((c) => c === "object.create")).toHaveLength(2);
    const created = batch.requests.filter((r) => r.cmd === "object.create");
    for (const request of created) {
      expect((request.params as { kind: string }).kind).toBe("cube");
    }
  });

  it("cuts a cavity for a hollow component and cleans up the cutter", () => {
    const batch = buildGeometryBatch(mugSpec());
    const commands = batch.requests.map((r) => r.cmd);
    expect(commands).toContain("object.boolean");

    const boolean = batch.requests.find((r) => r.cmd === "object.boolean");
    const params = boolean?.params as { object: string; cutter: string; delete_cutter: boolean };
    expect(params.object).toBe("body");
    expect(params.cutter).toBe("body__cut0");
    expect(params.delete_cutter).toBe(true);
  });

  it("leaves a floor of exactly one wall thickness on a top-open vessel", () => {
    const batch = buildGeometryBatch(mugSpec());
    const cutter = batch.requests.find(
      (r) => r.cmd === "object.create" && (r.params as { name: string }).name === "body__cut0",
    );
    const params = cutter?.params as { dimensions: number[]; location: number[] };
    // Body is 100mm tall at z=50mm with 5mm walls: the cavity is full height,
    // lifted by one wall thickness so it pierces the top and floors the bottom.
    expect(params.dimensions[2]).toBeCloseTo(0.1, 6);
    expect(params.location[2]).toBeCloseTo(0.055, 6);
    expect(params.dimensions[0]).toBeCloseTo(0.07, 6);
  });

  it("converts spec degrees into Blender radians", () => {
    const batch = buildGeometryBatch(mugSpec());
    const handle = batch.requests.find(
      (r) => r.cmd === "object.create" && (r.params as { name: string }).name === "handle",
    );
    const rotation = (handle?.params as { rotation_euler: number[] }).rotation_euler;
    expect(rotation[0]).toBeCloseTo(Math.PI / 2, 9);
  });

  it("assigns a material to every component", () => {
    const batch = buildGeometryBatch(mugSpec());
    const assigns = batch.requests.filter((r) => r.cmd === "material.assign");
    expect(assigns.map((r) => (r.params as { object: string }).object).sort()).toEqual(["body", "handle"]);
  });

  it("scales light distance and energy to the object size", () => {
    const batch = buildLightingBatch(mugSpec());
    const lights = batch.requests.filter((r) => r.cmd === "light.create");
    expect(lights).toHaveLength(3);

    const key = lights[0]?.params as { location: number[]; energy: number };
    // A 116mm object: lights sit centimetres away, not metres.
    const distance = Math.hypot(key.location[0]!, key.location[1]!, key.location[2]! - 0.05);
    expect(distance).toBeLessThan(0.5);
    // Energy compensates for inverse-square falloff at that distance.
    expect(key.energy).toBeGreaterThan(0);
    expect(key.energy).toBeLessThan(90);
  });

  it("unwraps, decimates to budget, then exports", () => {
    const batch = buildExportBatch(mugSpec(), "/tmp/out.glb");
    expect(batch.requests.map((r) => r.cmd)).toEqual(["uv.unwrap", "optimize.decimate", "export.glb"]);
    expect((batch.requests[1]?.params as { target_tris: number }).target_tris).toBe(8000);
  });

  it("skips unwrapping when the spec does not require UVs", () => {
    const spec = mugSpec();
    spec.quality.require_uv = false;
    expect(buildExportBatch(spec, "/tmp/out.glb").requests.map((r) => r.cmd)).toEqual([
      "optimize.decimate",
      "export.glb",
    ]);
  });
});
