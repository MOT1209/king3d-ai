/**
 * `king3d gen` - the whole pipeline, from a reference image or a prompt.
 *
 * Runs until it needs a judgement, then stops and says what it needs. Re-running
 * the same command resumes, so the loop is:
 *
 *     king3d gen --image ref.png --run-id chair
 *     (answer the spec request)
 *     king3d gen --run-id chair          -> builds, then asks for a review
 *     (answer the review request)
 *     king3d review chair --rebuild
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { paths } from "../core/config.ts";
import { Ai3dError } from "../core/errors.ts";
import { buildSpecRequest } from "../pipeline/analyze.ts";
import { formatGateReport } from "../pipeline/gates.ts";
import { buildFromSpec, newRunId, runPaths } from "../pipeline/run.ts";
import { AgentInLoopProvider } from "../providers/agent-in-loop.ts";
import { NeedsModelInput } from "../providers/provider.ts";
import { completeDraft, safeParseSceneSpec, type SceneSpec } from "../spec/scene-spec.ts";

export interface GenCommandOptions {
  imagePath?: string;
  prompt?: string;
  hints?: string;
  runId?: string;
  skipExport?: boolean;
  asJson?: boolean;
}

function resolve(path: string): string {
  return isAbsolute(path) ? path : join(paths.root, path);
}

export async function runGen(options: GenCommandOptions): Promise<number> {
  if (!options.imagePath && !options.prompt && !options.runId) {
    throw new Ai3dError("CONFIG_INVALID", "gen needs --image, --prompt, or a --run-id to resume");
  }

  const runId = options.runId ?? newRunId("gen");
  const rp = runPaths(runId);
  await mkdir(rp.dir, { recursive: true });

  // The reference is copied into the run so the run stays self-contained and
  // reviewable long after the original file has moved.
  let reference: string | undefined;
  if (options.imagePath) {
    const source = resolve(options.imagePath);
    if (!existsSync(source)) {
      throw new Ai3dError("CONFIG_INVALID", `no reference image at ${source}`, { path: source });
    }
    reference = join(rp.dir, `reference${extname(source) || ".png"}`);
    await copyFile(source, reference);
  } else {
    for (const candidate of ["reference.png", "reference.jpg", "reference.jpeg"]) {
      if (existsSync(join(rp.dir, candidate))) {
        reference = join(rp.dir, candidate);
        break;
      }
    }
  }

  const spec = await obtainSpec(runId, rp, reference, options);
  if (spec === null) return 2; // waiting for the spec answer

  process.stderr.write(`\nbuilding "${spec.object.name}" (${spec.components.length} components)\n`);
  const result = await buildFromSpec(spec, {
    runId,
    ...(reference ? { referenceImage: reference } : {}),
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
    process.stdout.write(`\n  contact sheet  ${result.paths.sheet}\n`);
    if (result.exported) process.stdout.write(`  glb            ${result.paths.glb}\n`);
    process.stdout.write(`\nNext: king3d review ${runId}\n`);
  }
  return result.report.passed ? 0 : 1;
}

/** Load an existing spec, or ask for one. Returns null when waiting for an answer. */
async function obtainSpec(
  runId: string,
  rp: ReturnType<typeof runPaths>,
  reference: string | undefined,
  options: GenCommandOptions,
): Promise<SceneSpec | null> {
  if (existsSync(rp.spec)) {
    const parsed = safeParseSceneSpec(JSON.parse(await readFile(rp.spec, "utf8")));
    if (parsed.success) {
      process.stderr.write(`reusing the spec already in ${rp.spec}\n`);
      return parsed.data;
    }
    process.stderr.write(`the spec in ${rp.spec} no longer validates; asking for a new one\n`);
  }

  const provider = new AgentInLoopProvider({ promptDir: rp.prompts });
  const example = JSON.parse(await readFile(join(paths.root, "src", "spec", "fixtures", "mug.json"), "utf8"));

  const request = buildSpecRequest({
    ...(reference ? { imagePath: reference } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.hints ? { hints: options.hints } : {}),
    example,
  });

  let draft;
  try {
    draft = await provider.ask(request);
  } catch (e) {
    if (e instanceof NeedsModelInput) {
      process.stdout.write(
        `\nThis run needs a specification before it can build.\n\n` +
          (reference ? `  look   ${reference}\n` : "") +
          `  read   ${e.requestPath}\n` +
          `  write  ${e.responsePath}\n\n` +
          `Then run:  king3d gen --run-id ${runId}\n`,
      );
      return null;
    }
    throw e;
  }

  const spec = completeDraft(draft, {
    id: runId,
    source: {
      ...(reference ? { image: basename(reference) } : {}),
      ...(options.prompt ? { prompt: options.prompt } : {}),
    },
  });
  await writeFile(rp.spec, JSON.stringify(spec, null, 2), "utf8");
  process.stderr.write(`spec accepted and written to ${rp.spec}\n`);
  return spec;
}
