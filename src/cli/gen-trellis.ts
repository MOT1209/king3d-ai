/**
 * `king3d gen-trellis` - generative mode: image/prompt -> TRELLIS.2 base mesh ->
 * King3D repair/optimise/gates -> verified game-ready GLB.
 *
 * Unlike `king3d gen`, there is no analysis/spec judgement loop: the base mesh
 * comes from the TRELLIS.2 inference service (or the mock provider), so a run
 * completes in one invocation. Set KING3D_TRELLIS_MODE=mock to run without a GPU.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { paths } from "../core/config.ts";
import { Ai3dError } from "../core/errors.ts";
import { formatGateReport } from "../pipeline/gates.ts";
import { buildFromGenerated } from "../pipeline/generative-run.ts";
import { newRunId, runPaths } from "../pipeline/run.ts";
import { parseGenerativeSpec } from "../spec/generative-spec.ts";

export interface GenTrellisCommandOptions {
  imagePath?: string;
  prompt?: string;
  name?: string;
  runId?: string;
  skipExport?: boolean;
  asJson?: boolean;
}

function resolve(path: string): string {
  return isAbsolute(path) ? path : join(paths.root, path);
}

export async function runGenTrellis(options: GenTrellisCommandOptions): Promise<number> {
  if (!options.imagePath && !options.prompt) {
    throw new Ai3dError("CONFIG_INVALID", "gen-trellis needs --image or --prompt");
  }

  const runId = options.runId ?? newRunId("gen");
  const rp = runPaths(runId);
  await mkdir(rp.dir, { recursive: true });

  // Copy the reference into the run so it stays self-contained; store the
  // basename and let the orchestrator resolve it against the run directory.
  let imageBasename: string | undefined;
  if (options.imagePath) {
    const source = resolve(options.imagePath);
    if (!existsSync(source)) {
      throw new Ai3dError("CONFIG_INVALID", `no reference image at ${source}`, { path: source });
    }
    const copied = `reference${extname(source) || ".png"}`;
    await copyFile(source, join(rp.dir, copied));
    imageBasename = copied;
  }

  const objectName = options.name ?? options.prompt ?? (options.imagePath ? basename(options.imagePath) : "generated_asset");

  const spec = parseGenerativeSpec({
    id: runId,
    created_at: new Date().toISOString(),
    source: {
      ...(imageBasename ? { image: imageBasename } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    },
    generator: { name: "trellis2", model: "4B" },
    object: { name: objectName, category: "generated" },
  });

  process.stderr.write(`\ngenerating "${spec.object.name}" via TRELLIS.2\n`);
  const result = await buildFromGenerated(spec, {
    runId,
    skipExport: options.skipExport === true,
    onStage: (name, detail) => process.stderr.write(`  ${name.padEnd(10)} ${detail}\n`),
  });

  if (options.asJson) {
    process.stdout.write(
      JSON.stringify({ run_id: runId, passed: result.report.passed, scores: result.report.scores }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(`\nrun ${runId}\n\n`);
    process.stdout.write(formatGateReport(result.report));
    process.stdout.write(`\n  base mesh      ${result.baseMeshPath}\n`);
    if (result.exported) process.stdout.write(`  glb            ${result.paths.glb}\n`);
    process.stdout.write(`\nNext: king3d viewer ${runId}\n`);
  }
  return result.report.passed ? 0 : 1;
}
