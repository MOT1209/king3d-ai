/**
 * Measures what this machine actually costs, since the numbers drive design
 * decisions (daemon vs one-shot, which render engine, what resolution budget)
 * and differ by an order of magnitude between machines.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { paths, loadConfig } from "../core/config.ts";
import { errorMessage } from "../core/errors.ts";
import { acquireBackend, Batch, HeadlessBackend, runOne } from "../integrations/blender/index.ts";

interface Sample {
  label: string;
  ms: number;
  note?: string;
}

export async function runBench(asJson: boolean): Promise<number> {
  const config = loadConfig();
  const outDir = join(paths.runs, "bench");
  await mkdir(outDir, { recursive: true });
  const samples: Sample[] = [];

  // 1. One-shot cold start: the cost the daemon exists to avoid.
  const coldStart = Date.now();
  try {
    await runOne(new HeadlessBackend({ timeoutMs: 400_000 }), "ping", {}, { cwd: paths.root });
    samples.push({ label: "headless cold start (ping)", ms: Date.now() - coldStart });
  } catch (e) {
    samples.push({ label: "headless cold start (ping)", ms: -1, note: errorMessage(e) });
  }

  // 2. Daemon round trip: what every batch costs once Blender is warm.
  const { backend, coldStart: started } = await acquireBackend(config, {
    onProgress: (m) => process.stderr.write(`  ${m}\n`),
  });
  if (started) samples.push({ label: "daemon start", ms: -1, note: "started for this run" });

  const warm = Date.now();
  await new Batch().add("ping", {}).run(backend, { cwd: paths.root });
  samples.push({ label: "daemon round trip (ping)", ms: Date.now() - warm });

  // 3. Build a small scene, then render it with each engine.
  const build = new Batch();
  build.add("scene.reset", { keep_camera: false, keep_lights: false });
  build.add("object.create", {
    kind: "uv_sphere",
    name: "bench_sphere",
    location: [0, 0, 0],
    options: { radius: 1, segments: 32, ring_count: 16 },
    shade_smooth: true,
  });
  build.add("material.assign", {
    object: "bench_sphere",
    material: { name: "bench_mat", base_color: [0.8, 0.3, 0.2, 1], metallic: 0, roughness: 0.4 },
  });
  build.add("light.create", { name: "bench_key", type: "AREA", location: [3, -3, 4], look_at: [0, 0, 0], energy: 300, size: 3 });
  build.add("world.set", { color: [0.05, 0.05, 0.06], strength: 1, transparent: false });
  build.add("camera.frame", { targets: ["bench_sphere"], azimuth: 35, elevation: 20, margin: 1.2 });

  const buildStart = Date.now();
  const buildOutcome = await build.run(backend, { cwd: paths.root });
  if (!buildOutcome.ok) {
    process.stderr.write("bench scene build failed\n");
    for (const [i, r] of buildOutcome.responses.entries()) {
      if (!r.ok) process.stderr.write(`  ${build.requests[i]?.cmd}: ${r.error?.message}\n`);
    }
    await backend.close();
    return 1;
  }
  samples.push({ label: "build 6-command scene", ms: Date.now() - buildStart });

  for (const engine of ["WORKBENCH", "EEVEE", "CYCLES"] as const) {
    const batch = new Batch().add("render.still", {
      output: join(outDir, `bench_${engine.toLowerCase()}.png`),
      resolution: [384, 384],
      samples: 16,
      engine,
    });
    const t = Date.now();
    try {
      const outcome = await batch.run(backend, { cwd: paths.root });
      const result = batch.resultAt(outcome, 0, "render.still");
      samples.push({ label: `render 384px ${engine}`, ms: Date.now() - t, note: result.engine });
    } catch (e) {
      samples.push({ label: `render 384px ${engine}`, ms: -1, note: errorMessage(e).slice(0, 160) });
    }
    // A second render shows the warm cost once the engine has initialised.
    const t2 = Date.now();
    try {
      await new Batch()
        .add("render.still", {
          output: join(outDir, `bench_${engine.toLowerCase()}_warm.png`),
          resolution: [384, 384],
          samples: 16,
          engine,
        })
        .run(backend, { cwd: paths.root });
      samples.push({ label: `render 384px ${engine} (warm)`, ms: Date.now() - t2 });
    } catch {
      /* the cold attempt already recorded the failure */
    }
  }

  await backend.close();

  if (asJson) {
    process.stdout.write(JSON.stringify({ samples }, null, 2) + "\n");
  } else {
    const width = Math.max(...samples.map((s) => s.label.length));
    process.stdout.write("king3d bench\n");
    for (const s of samples) {
      const value = s.ms < 0 ? "     n/a" : `${(s.ms / 1000).toFixed(1)}s`.padStart(8);
      process.stdout.write(`  ${s.label.padEnd(width)}  ${value}${s.note ? `  ${s.note}` : ""}\n`);
    }
  }
  return 0;
}
