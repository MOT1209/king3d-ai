/**
 * The deterministic half of the pipeline: SceneSpec in, verified GLB out.
 *
 * No model is consulted here. Given the same spec this produces the same scene,
 * the same renders and the same scores, which is what makes a repair loop
 * meaningful - a change in the report means a change in the spec, not noise.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, paths, type Ai3dConfig } from "../core/config.ts";
import { Ai3dError } from "../core/errors.ts";
import { createLogger } from "../core/logger.ts";
import { acquireBackend } from "../integrations/blender/index.ts";
import type { BatchOutcome, Batch, BlenderBackend, JobContext } from "../integrations/blender/backend.ts";
import type { SceneSpec } from "../spec/scene-spec.ts";
import {
  buildExportBatch,
  buildExportVerifyBatch,
  buildGeometryBatch,
  buildInspectBatch,
  buildLightingBatch,
  buildReviewRenderBatch,
} from "./builder.ts";
import { evaluateGates, type GateReport } from "./gates.ts";

const log = createLogger("pipeline");

export interface RunPaths {
  dir: string;
  spec: string;
  blend: string;
  views: string;
  sheet: string;
  glb: string;
  report: string;
  prompts: string;
}

export function runPaths(runId: string): RunPaths {
  const dir = join(paths.runs, runId);
  return {
    dir,
    spec: join(dir, "spec.json"),
    blend: join(dir, "scene.blend"),
    views: join(dir, "views"),
    sheet: join(dir, "contact_sheet.png"),
    glb: join(dir, "export", "model.glb"),
    report: join(dir, "report.json"),
    prompts: join(dir, "prompts"),
  };
}

export function newRunId(prefix = "run"): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  return `${prefix}_${stamp}`;
}

export interface BuildOptions {
  runId?: string;
  /** Placed as the first cell of the contact sheet when present. */
  referenceImage?: string;
  /** Skip the export stage when only the look is being iterated on. */
  skipExport?: boolean;
  config?: Ai3dConfig;
  onStage?: (name: string, detail: string) => void;
}

export interface StageTiming {
  stage: string;
  ms: number;
  blenderMs: number;
}

export interface BuildResult {
  runId: string;
  paths: RunPaths;
  report: GateReport;
  timings: StageTiming[];
  exported: boolean;
}

export async function buildFromSpec(spec: SceneSpec, options: BuildOptions = {}): Promise<BuildResult> {
  const runId = options.runId ?? newRunId();
  const rp = runPaths(runId);
  const config = options.config ?? loadConfig();
  const timings: StageTiming[] = [];
  const stage = options.onStage ?? (() => undefined);

  await mkdir(rp.dir, { recursive: true });
  await mkdir(rp.views, { recursive: true });
  await writeFile(rp.spec, JSON.stringify(spec, null, 2), "utf8");

  const { backend, coldStart } = await acquireBackend(config, {
    onProgress: (m) => stage("daemon", m),
  });
  if (coldStart) stage("daemon", "started a new Blender daemon");

  try {
    // --- geometry ---------------------------------------------------------
    stage("geometry", `building ${spec.components.length} components`);
    await run(backend, buildGeometryBatch(spec), { saveBlend: rp.blend }, timings, "geometry");

    // --- lighting ---------------------------------------------------------
    stage("lighting", `${spec.lighting.lights.length || 3} lights`);
    await run(backend, buildLightingBatch(spec), { loadBlend: rp.blend, saveBlend: rp.blend }, timings, "lighting");

    // --- review renders ---------------------------------------------------
    stage("render", `${spec.render.views.length} views at ${spec.render.resolution}px (${spec.render.review_engine})`);
    const renderBatch = buildReviewRenderBatch(spec, {
      viewsDir: rp.views,
      sheetPath: rp.sheet,
      ...(options.referenceImage ? { referencePath: options.referenceImage } : {}),
    });
    await run(backend, renderBatch, { loadBlend: rp.blend }, timings, "render");

    // --- measurement ------------------------------------------------------
    stage("inspect", "measuring geometry");
    const inspectBatch = buildInspectBatch(spec);
    const inspectOutcome = await run(backend, inspectBatch, { loadBlend: rp.blend }, timings, "inspect");
    const meshes = inspectBatch.resultAt(inspectOutcome, 0, "inspect.all").meshes;
    const scene = inspectBatch.resultAt(inspectOutcome, 1, "scene.info");

    let exported: { tris: number; objects: number; sizeBytes: number } | undefined;

    if (!options.skipExport) {
      // --- export ---------------------------------------------------------
      stage("export", `unwrap, decimate to ${spec.quality.target_tris} tris, write GLB`);
      await mkdir(join(rp.dir, "export"), { recursive: true });
      const exportBatch = buildExportBatch(spec, rp.glb);
      const exportOutcome = await run(
        backend,
        exportBatch,
        { loadBlend: rp.blend, saveBlend: rp.blend },
        timings,
        "export",
      );
      const glb = exportBatch.resultAt(exportOutcome, exportBatch.size - 1, "export.glb");

      // --- verify ---------------------------------------------------------
      // An exporter reporting success proves nothing; load the file back and
      // compare. This runs in a throwaway scene and is deliberately not saved.
      stage("verify", "re-importing the GLB to prove it loads");
      const verifyBatch = buildExportVerifyBatch(rp.glb);
      const verifyOutcome = await run(backend, verifyBatch, { loadBlend: rp.blend }, timings, "verify");
      const imported = verifyBatch.resultAt(verifyOutcome, 0, "import.glb");

      exported = { tris: imported.total_tris, objects: imported.objects.length, sizeBytes: glb.size_bytes };
    }

    // Measure after export so the gates score the mesh that was actually shipped.
    const finalMeshes = options.skipExport
      ? meshes
      : inspectBatch.resultAt(
          await run(backend, buildInspectBatch(spec), { loadBlend: rp.blend }, timings, "inspect_final"),
          0,
          "inspect.all",
        ).meshes;

    const report = evaluateGates({
      spec,
      meshes: finalMeshes,
      scene,
      ...(exported ? { exported } : {}),
    });

    await writeFile(
      rp.report,
      JSON.stringify(
        {
          run_id: runId,
          spec_id: spec.id,
          created_at: new Date().toISOString(),
          passed: report.passed,
          scores: report.scores,
          gates: report.gates,
          timings,
          artifacts: {
            spec: rp.spec,
            blend: rp.blend,
            contact_sheet: rp.sheet,
            views: spec.render.views.map((v) => join(rp.views, `${v}.png`)),
            ...(exported ? { glb: rp.glb } : {}),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    return { runId, paths: rp, report, timings, exported: exported !== undefined };
  } finally {
    await backend.close();
  }
}

/** Run one batch, record its timing, and fail loudly with the offending command. */
async function run(
  backend: BlenderBackend,
  batch: Batch,
  context: JobContext,
  timings: StageTiming[],
  name: string,
): Promise<BatchOutcome> {
  const started = Date.now();
  const outcome = await batch.run(backend, { ...context, cwd: paths.root });
  timings.push({ stage: name, ms: Date.now() - started, blenderMs: outcome.timings?.batch_ms ?? -1 });

  if (!outcome.ok) {
    const index = outcome.responses.findIndex((r) => !r.ok);
    const failed = outcome.responses[index];
    throw new Ai3dError("BLENDER_COMMAND_FAILED", `stage "${name}" failed at ${batch.requests[index]?.cmd}: ${failed?.error?.message}`, {
      stage: name,
      command: batch.requests[index]?.cmd,
      error: failed?.error,
      logs: failed?.logs,
    });
  }
  log.debug(`stage ${name} done`, { ms: Date.now() - started });
  return outcome;
}
