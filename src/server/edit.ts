/**
 * Editor edits, as repairs.
 *
 * A manual edit in the editor and an AI-proposed edit are the same thing the
 * review stage already produces: a `{ path, value }` fix on the SceneSpec. So
 * they go through the same `Defect` schema (which restricts `path` to sizes,
 * placements, rotations and material values - never structure) and the same
 * `applyRepairs`. That keeps the guarantee the rest of the pipeline relies on:
 * the spec is edited, not the scene, and every result is reproducible from one
 * JSON file.
 *
 * Edits accumulate in `spec.repaired.json` (the file `rebuild` already builds).
 * Each edit also snapshots the resulting spec under `revisions/`, which is what
 * makes undo possible.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ai3dError } from "../core/errors.ts";
import { applyRepairs, Defect, type RepairOutcome } from "../pipeline/review.ts";
import { safeParseSceneSpec, type SceneSpec } from "../spec/scene-spec.ts";
import type { RunPaths } from "./runs-list.ts";

export interface EditFix {
  path: string;
  value: number | number[];
}

export interface Revision {
  rev: number;
  created_at: string;
  fixes: EditFix[];
}

const REVISION_FILE = /^rev-(\d+)\.json$/;

function revisionsDir(rp: RunPaths): string {
  return join(rp.dir, "revisions");
}

function repairedPath(rp: RunPaths): string {
  return join(rp.dir, "spec.repaired.json");
}

async function readSpec(path: string): Promise<SceneSpec> {
  const parsed = safeParseSceneSpec(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    throw new Ai3dError("SPEC_INVALID", "the spec does not validate", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** The spec edits build on: earlier edits if there are any, else the built spec. */
async function workingSpec(rp: RunPaths): Promise<SceneSpec> {
  if (existsSync(repairedPath(rp))) return readSpec(repairedPath(rp));
  if (!existsSync(rp.spec)) {
    throw new Ai3dError("RUN_STATE_INVALID", "this run has no spec to edit yet");
  }
  return readSpec(rp.spec);
}

async function nextRevision(rp: RunPaths): Promise<number> {
  const dir = revisionsDir(rp);
  if (!existsSync(dir)) return 1;
  const numbers = (await readdir(dir)).map((f) => REVISION_FILE.exec(f)?.[1]).filter((n): n is string => !!n);
  return numbers.length === 0 ? 1 : Math.max(...numbers.map(Number)) + 1;
}

export interface EditResult {
  rev: number;
  outcome: RepairOutcome;
}

/**
 * Apply edits to the working spec. Every fix is validated against the same
 * schema the review stage uses, so an out-of-vocabulary path is a 400, not a
 * silent no-op. Nothing is written unless at least one fix applied.
 */
export async function applyEdit(rp: RunPaths, fixes: EditFix[]): Promise<EditResult> {
  if (!Array.isArray(fixes) || fixes.length === 0) {
    throw new Ai3dError("CONFIG_INVALID", "an edit needs at least one fix");
  }

  const defects: Defect[] = [];
  for (const [i, fix] of fixes.entries()) {
    const parsed = Defect.safeParse({
      id: `edit_${i + 1}`,
      severity: "P1",
      problem: "manual edit",
      fix: { path: fix?.path, value: fix?.value, reason: "edited in the editor" },
    });
    if (!parsed.success) {
      throw new Ai3dError("CONFIG_INVALID", `fix ${i + 1} is not an allowed edit`, { issues: parsed.error.issues });
    }
    defects.push(parsed.data);
  }

  const outcome = applyRepairs(await workingSpec(rp), defects);
  if (outcome.applied.length === 0) {
    throw new Ai3dError("CONFIG_INVALID", "no edit could be applied", { skipped: outcome.skipped });
  }

  const rev = await nextRevision(rp);
  await mkdir(revisionsDir(rp), { recursive: true });
  const record = { rev, created_at: new Date().toISOString(), fixes, spec: outcome.spec };
  await writeFile(join(revisionsDir(rp), `rev-${rev}.json`), JSON.stringify(record, null, 2), "utf8");
  await writeFile(repairedPath(rp), JSON.stringify(outcome.spec, null, 2), "utf8");
  return { rev, outcome };
}

export async function listRevisions(rp: RunPaths): Promise<Revision[]> {
  const dir = revisionsDir(rp);
  if (!existsSync(dir)) return [];
  const out: Revision[] = [];
  for (const file of await readdir(dir)) {
    const match = REVISION_FILE.exec(file);
    if (!match) continue;
    const record = JSON.parse(await readFile(join(dir, file), "utf8")) as Revision;
    out.push({ rev: Number(match[1]), created_at: record.created_at, fixes: record.fixes });
  }
  return out.sort((a, b) => a.rev - b.rev);
}

/**
 * Undo: make `rev` (or, for rev 0, the original built spec) the working spec
 * again. Later revisions are kept, so the user can still redo by reverting to
 * a higher number.
 */
export async function revertTo(rp: RunPaths, rev: number): Promise<SceneSpec> {
  if (!Number.isInteger(rev) || rev < 0) throw new Ai3dError("CONFIG_INVALID", "rev must be a non-negative integer");

  if (rev === 0) {
    const original = await readSpec(rp.spec);
    await writeFile(repairedPath(rp), JSON.stringify(original, null, 2), "utf8");
    return original;
  }

  const file = join(revisionsDir(rp), `rev-${rev}.json`);
  if (!existsSync(file)) throw new Ai3dError("RUN_STATE_INVALID", `no revision ${rev} for this run`, { rev });
  const record = JSON.parse(await readFile(file, "utf8")) as { spec: unknown };
  const parsed = safeParseSceneSpec(record.spec);
  if (!parsed.success) {
    throw new Ai3dError("SPEC_INVALID", `revision ${rev} no longer validates`, { issues: parsed.error.issues });
  }
  await writeFile(repairedPath(rp), JSON.stringify(parsed.data, null, 2), "utf8");
  return parsed.data;
}
