/**
 * `ai3d build` - run a SceneSpec through the deterministic pipeline.
 *
 * This is the half that needs no model: geometry, lighting, renders, gates and a
 * verified export. The image-to-spec and review stages wrap around it.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { paths } from "../core/config.ts";
import { Ai3dError } from "../core/errors.ts";
import { formatGateReport } from "../pipeline/gates.ts";
import { buildFromSpec } from "../pipeline/run.ts";
import { safeParseSceneSpec } from "../spec/scene-spec.ts";

export interface BuildCommandOptions {
  specPath?: string | undefined;
  referenceImage?: string;
  runId?: string;
  skipExport?: boolean;
  asJson?: boolean;
}

function resolve(path: string): string {
  return isAbsolute(path) ? path : join(paths.root, path);
}

export async function runBuild(options: BuildCommandOptions): Promise<number> {
  const specPath = options.specPath ?? join("src", "spec", "fixtures", "mug.json");
  const resolved = resolve(specPath);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolved, "utf8"));
  } catch (e) {
    throw new Ai3dError("SPEC_INVALID", `Could not read a spec at ${resolved}: ${String(e)}`, { path: resolved });
  }

  const parsed = safeParseSceneSpec(raw);
  if (!parsed.success) {
    process.stderr.write(`\nThe spec at ${resolved} is not valid:\n`);
    for (const issue of parsed.error.issues) {
      process.stderr.write(`  ${issue.path.join(".") || "(root)"}: ${issue.message}\n`);
    }
    return 1;
  }
  const spec = parsed.data;

  process.stderr.write(`building "${spec.object.name}" (${spec.components.length} components)\n`);
  const started = Date.now();

  const result = await buildFromSpec(spec, {
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.referenceImage ? { referenceImage: resolve(options.referenceImage) } : {}),
    skipExport: options.skipExport === true,
    onStage: (name, detail) => process.stderr.write(`  ${name.padEnd(10)} ${detail}\n`),
  });

  if (options.asJson) {
    process.stdout.write(
      JSON.stringify(
        { run_id: result.runId, passed: result.report.passed, scores: result.report.scores, gates: result.report.gates },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`\nrun ${result.runId}\n\n`);
    process.stdout.write(formatGateReport(result.report));
    process.stdout.write(`\n  contact sheet  ${result.paths.sheet}\n`);
    if (result.exported) process.stdout.write(`  glb            ${result.paths.glb}\n`);
    process.stdout.write(`  report         ${result.paths.report}\n`);

    const slowest = [...result.timings].sort((a, b) => b.ms - a.ms).slice(0, 3);
    process.stderr.write(
      `\ntotal ${((Date.now() - started) / 1000).toFixed(1)}s; slowest stages: ` +
        slowest.map((t) => `${t.stage} ${(t.ms / 1000).toFixed(1)}s`).join(", ") +
        "\n",
    );
  }

  return result.report.passed ? 0 : 1;
}
