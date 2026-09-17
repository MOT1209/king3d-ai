/**
 * `king3d review` - the judgement half of the loop.
 *
 * Called once to emit a request, and again to consume the answer. That split is
 * what makes the pipeline resumable instead of blocking, and it keeps the model
 * spending tokens only on the visual comparison.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ai3dError } from "../core/errors.ts";
import { loadConfig } from "../core/config.ts";
import { formatGateReport, withSimilarity, type GateReport } from "../pipeline/gates.ts";
import { applyRepairs, buildReviewRequest, type Defect } from "../pipeline/review.ts";
import { buildFromSpec, runPaths } from "../pipeline/run.ts";
import { createReviewProvider } from "../providers/index.ts";
import { NeedsModelInput } from "../providers/provider.ts";
import { safeParseSceneSpec, type SceneSpec } from "../spec/scene-spec.ts";

export interface ReviewCommandOptions {
  runId: string;
  /** Rebuild immediately from the repaired spec instead of only writing it. */
  rebuild?: boolean;
  referenceImage?: string;
  asJson?: boolean;
}

interface StoredReport {
  scores?: GateReport["scores"];
  gates?: GateReport["gates"];
  passed?: boolean;
  review?: unknown;
}

async function loadSpec(path: string): Promise<SceneSpec> {
  const parsed = safeParseSceneSpec(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    throw new Ai3dError("SPEC_INVALID", `the spec at ${path} is not valid`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

export async function runReview(options: ReviewCommandOptions): Promise<number> {
  const rp = runPaths(options.runId);
  if (!existsSync(rp.spec)) {
    throw new Ai3dError("RUN_NOT_FOUND", `no run named "${options.runId}" (looked for ${rp.spec})`, {
      runId: options.runId,
    });
  }
  if (!existsSync(rp.sheet)) {
    throw new Ai3dError("RUN_STATE_INVALID", `run "${options.runId}" has no contact sheet; build it first`, {
      expected: rp.sheet,
    });
  }

  const spec = await loadSpec(rp.spec);
  const stored: StoredReport = existsSync(rp.report) ? JSON.parse(await readFile(rp.report, "utf8")) : {};
  const gates: GateReport = {
    gates: stored.gates ?? [],
    scores: stored.scores ?? { geometry: 0, material: 0, optimization: 0, export: 0, overall: 0 },
    passed: stored.passed ?? false,
  };

  // A run copies its reference in, so it knows what it was built from without
  // being told again. Only fall back to the flag for a run that has none.
  const reference = options.referenceImage ?? findRunReference(rp.dir);

  const provider = createReviewProvider(loadConfig(), rp.prompts);
  const request = buildReviewRequest({
    spec,
    sheetPath: rp.sheet,
    ...(reference ? { referencePath: reference } : {}),
    gates,
    cycle: 0,
  });

  let verdict;
  try {
    verdict = await provider.ask(request);
  } catch (e) {
    if (e instanceof NeedsModelInput) {
      process.stdout.write(
        `\nThis run needs a visual judgement before it can continue.\n\n` +
          `  read   ${e.requestPath}\n` +
          `  look   ${rp.sheet}\n` +
          `  write  ${e.responsePath}\n\n` +
          `Then run:  king3d review ${options.runId}\n`,
      );
      return 2;
    }
    throw e;
  }

  // Fold the reviewed similarity into the measured scores. The build already
  // computed the deterministic ones; this only adds the dimension that needed eyes.
  const merged = withSimilarity(gates.scores, verdict.similarity);

  const p0 = verdict.defects.filter((d) => d.severity === "P0");
  const repair = applyRepairs(spec, verdict.defects as Defect[]);

  const repairedPath = join(rp.dir, "spec.repaired.json");
  if (repair.applied.length > 0) {
    await writeFile(repairedPath, JSON.stringify(repair.spec, null, 2), "utf8");
  }

  await writeFile(
    rp.report,
    JSON.stringify(
      {
        ...stored,
        scores: merged,
        review: {
          similarity: verdict.similarity,
          verdict: verdict.verdict,
          observations: verdict.observations,
          defects: verdict.defects,
          applied: repair.applied,
          skipped: repair.skipped,
          repaired_spec: repair.applied.length > 0 ? repairedPath : null,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  if (options.asJson) {
    process.stdout.write(
      JSON.stringify({ verdict: verdict.verdict, scores: merged, defects: verdict.defects, repair }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(`\nreview of ${options.runId}\n\n`);
    process.stdout.write(`  similarity ${verdict.similarity.toFixed(2)}   verdict: ${verdict.verdict}\n`);
    process.stdout.write(`  OVERALL ${merged.overall.toFixed(2)}\n\n`);
    process.stdout.write(`  ${verdict.observations.trim().replace(/\n/g, "\n  ")}\n\n`);

    if (verdict.defects.length === 0) {
      process.stdout.write("  no defects reported\n");
    } else {
      for (const defect of verdict.defects) {
        process.stdout.write(`  ${defect.severity}  ${defect.id}: ${defect.problem}\n`);
      }
    }
    if (repair.applied.length > 0) {
      process.stdout.write(`\n  applied ${repair.applied.length} fix(es):\n`);
      for (const fix of repair.applied) {
        process.stdout.write(`    ${fix.path}  ${JSON.stringify(fix.from)} -> ${JSON.stringify(fix.to)}\n`);
      }
      process.stdout.write(`\n  repaired spec: ${repairedPath}\n`);
    }
    for (const skip of repair.skipped) {
      process.stdout.write(`    skipped ${skip.defect}: ${skip.reason}\n`);
    }
  }

  if (options.rebuild && repair.applied.length > 0) {
    const nextId = `${options.runId}_r${Date.now().toString(36).slice(-4)}`;
    process.stderr.write(`\nrebuilding from the repaired spec as ${nextId}\n`);
    const result = await buildFromSpec(repair.spec, {
      runId: nextId,
      ...(reference ? { referenceImage: reference } : {}),
      onStage: (name, detail) => process.stderr.write(`  ${name.padEnd(10)} ${detail}\n`),
    });
    process.stdout.write(`\n${formatGateReport(result.report)}`);
    process.stdout.write(`  contact sheet  ${result.paths.sheet}\n`);
    return result.report.passed ? 0 : 1;
  }

  return p0.length === 0 ? 0 : 1;
}

/** The reference image a run was built from, if it kept one. */
function findRunReference(dir: string): string | undefined {
  for (const name of ["reference.png", "reference.jpg", "reference.jpeg"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
