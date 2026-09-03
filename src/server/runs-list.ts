/**
 * Run discovery for the dashboard.
 *
 * A run's status is derived entirely from which files exist on disk - the same
 * facts the CLI already prints - rather than tracked separately, so the
 * dashboard can never drift from what actually happened to a run.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../core/config.ts";
import { runPaths, type RunPaths } from "../pipeline/run.ts";

export type RunStatus =
  | "needs_spec" // a spec request is waiting, or no spec attempt has been made yet
  | "spec_ready" // a spec exists but the build has not run (or failed) yet
  | "built" // gates evaluated, no review yet
  | "needs_review" // a review request is waiting
  | "reviewed"; // a review verdict has been recorded

export interface RunSummary {
  id: string;
  status: RunStatus;
  name?: string;
  passed?: boolean;
  overall?: number;
  hasGlb: boolean;
  hasReference: boolean;
  createdAt: string;
}

interface StoredReport {
  passed?: boolean;
  scores?: { overall?: number };
  review?: { verdict?: string };
}

function hasReference(dir: string): boolean {
  return ["reference.png", "reference.jpg", "reference.jpeg"].some((n) => existsSync(join(dir, n)));
}

/** Read one run's status from disk. Never throws - a partially-written run
 *  (mid-build, or a crashed process) is reported as best it can be, not hidden. */
export async function readRunSummary(id: string): Promise<RunSummary> {
  const rp = runPaths(id);
  const dir = rp.dir;
  const stat = statSync(dir);

  const specExists = existsSync(rp.spec);
  const specRequestPending =
    existsSync(join(rp.prompts, "spec.request.md")) && !existsSync(join(rp.prompts, "spec.response.json"));
  const reportExists = existsSync(rp.report);
  const reviewRequestPending =
    existsSync(join(rp.prompts, "review.request.md")) && !existsSync(join(rp.prompts, "review.response.json"));

  let report: StoredReport = {};
  if (reportExists) {
    try {
      report = JSON.parse(await readFile(rp.report, "utf8"));
    } catch {
      // A report that fails to parse is treated as absent rather than crashing
      // the whole list; the run detail view will surface the real error.
    }
  }

  let name: string | undefined;
  if (specExists) {
    try {
      const spec = JSON.parse(await readFile(rp.spec, "utf8"));
      name = spec?.object?.name;
    } catch {
      /* fall through with no name */
    }
  }

  let status: RunStatus;
  if (report.review) status = "reviewed";
  else if (reviewRequestPending) status = "needs_review";
  else if (reportExists) status = "built";
  else if (specExists) status = "spec_ready";
  else if (specRequestPending) status = "needs_spec";
  else status = "needs_spec";

  const summary: RunSummary = {
    id,
    status,
    hasGlb: existsSync(rp.glb),
    hasReference: hasReference(dir),
    createdAt: stat.birthtime.toISOString(),
  };
  if (name) summary.name = name;
  if (report.passed !== undefined) summary.passed = report.passed;
  if (report.scores?.overall !== undefined) summary.overall = report.scores.overall;
  return summary;
}

/** A directory under runs/ counts as a run only if ai3d itself put a run's own
 *  marker there - `runs/fixtures/` (the fixtures:build ground-truth cache) and
 *  any other incidental subdirectory must not show up as a phantom run. */
function looksLikeARun(dir: string): boolean {
  return existsSync(join(dir, "prompts")) || existsSync(join(dir, "spec.json")) || existsSync(join(dir, "report.json"));
}

export async function listRuns(): Promise<RunSummary[]> {
  if (!existsSync(paths.runs)) return [];
  const entries = readdirSync(paths.runs, { withFileTypes: true })
    // ".daemon.json" and "daemon.log" live in the same directory as run
    // directories; only directories that carry ai3d's own run markers count.
    .filter((e) => e.isDirectory() && looksLikeARun(join(paths.runs, e.name)));

  const summaries = await Promise.all(entries.map((e) => readRunSummary(e.name)));
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function runExists(id: string): boolean {
  return existsSync(runPaths(id).dir);
}

export { runPaths, type RunPaths };
