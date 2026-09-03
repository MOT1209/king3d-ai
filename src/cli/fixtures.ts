/**
 * `king3d fixtures:build` - render the reference image the vertical slice is tested against.
 *
 * Testing image-to-3D needs a reference, and any real photograph makes the test
 * depend on an asset we do not control and cannot check an answer against. So the
 * reference is rendered from a spec we already have: the ground truth is known
 * exactly, which means a rebuilt spec can be compared against it numerically
 * rather than only by eye.
 */
import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, paths } from "../core/config.ts";
import { Ai3dError } from "../core/errors.ts";
import { acquireBackend, Batch } from "../integrations/blender/index.ts";
import { buildGeometryBatch, buildLightingBatch } from "../pipeline/builder.ts";
import { safeParseSceneSpec } from "../spec/scene-spec.ts";

export interface FixturesOptions {
  engine?: "WORKBENCH" | "EEVEE" | "CYCLES";
  resolution?: number;
}

export async function runFixtures(options: FixturesOptions = {}): Promise<number> {
  const specPath = join(paths.root, "src", "spec", "fixtures", "mug.json");
  const parsed = safeParseSceneSpec(JSON.parse(await readFile(specPath, "utf8")));
  if (!parsed.success) {
    throw new Ai3dError("SPEC_INVALID", "the mug fixture does not validate", { issues: parsed.error.issues });
  }
  const spec = parsed.data;

  // Cycles by default: the reference should look like a photograph of the object
  // rather than a preview of it, or the analysis stage is being given an easier
  // problem than the real one.
  const engine = options.engine ?? "CYCLES";
  const resolution = options.resolution ?? 512;

  await mkdir(paths.fixtures, { recursive: true });
  const output = join(paths.fixtures, "mug_reference.png");
  const blend = join(paths.runs, "fixtures", "mug_reference.blend");

  process.stderr.write(`rendering the ground-truth reference (${engine}, ${resolution}px)\n`);
  if (engine === "CYCLES") process.stderr.write("  Cycles on CPU takes a while; this is a one-off\n");

  const { backend } = await acquireBackend(loadConfig(), {
    onProgress: (m) => process.stderr.write(`  ${m}\n`),
  });

  try {
    await buildGeometryBatch(spec).run(backend, { cwd: paths.root, saveBlend: blend });
    await buildLightingBatch(spec).run(backend, { cwd: paths.root, loadBlend: blend, saveBlend: blend });

    const render = new Batch()
      .add("world.set", { color: [0.18, 0.18, 0.2], strength: 1.2, transparent: false })
      .add("camera.frame", {
        targets: [],
        azimuth: spec.camera.azimuth_deg,
        elevation: spec.camera.elevation_deg,
        margin: spec.camera.margin,
        lens: spec.camera.lens_mm,
      })
      .add("render.still", {
        output,
        resolution: [resolution, resolution],
        samples: engine === "CYCLES" ? 32 : 8,
        engine,
        film_transparent: false,
      });

    const outcome = await render.run(backend, { cwd: paths.root, loadBlend: blend });
    if (!outcome.ok) {
      const failed = outcome.responses.find((r) => !r.ok);
      throw new Ai3dError("BLENDER_COMMAND_FAILED", `reference render failed: ${failed?.error?.message}`, {
        error: failed?.error,
      });
    }
    const still = render.resultAt(outcome, 2, "render.still");

    process.stdout.write(`\nreference written: ${still.output}\n`);
    process.stdout.write(`  ${still.width}x${still.height}, ${still.engine}\n\n`);
    process.stdout.write(`Now run the vertical slice against it:\n`);
    process.stdout.write(`  king3d gen --image tests/fixtures/mug_reference.png --run-id slice\n`);
    return 0;
  } finally {
    await backend.close();
  }
}
