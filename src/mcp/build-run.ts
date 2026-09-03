/**
 * The build/rebuild workflow, shared by the MCP tools.
 *
 * Identical in substance to http.ts's streamBuild (src/server/http.ts) - same
 * buildFromSpec call, same spec-file selection - but returns a single result
 * instead of streaming SSE frames, since an MCP tool call is request/response.
 * The per-stage log is still collected and returned, so the calling agent sees
 * what happened even without a live stream.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Ai3dError } from "../core/errors.ts";
import { buildFromSpec, runPaths } from "../pipeline/run.ts";
import type { GateReport } from "../pipeline/gates.ts";
import { safeParseSceneSpec } from "../spec/scene-spec.ts";

export interface BuildRunResult {
  runId: string;
  passed: boolean;
  scores: GateReport["scores"];
  gates: GateReport["gates"];
  exported: boolean;
  stages: Array<{ name: string; detail: string }>;
  artifacts: {
    spec: string;
    blend: string;
    contact_sheet: string;
    glb: string | null;
  };
}

export async function runBuildForMcp(runId: string, useRepaired: boolean): Promise<BuildRunResult> {
  const rp = runPaths(runId);
  if (!existsSync(rp.dir)) {
    throw new Ai3dError("RUN_NOT_FOUND", `no run named "${runId}"`, { runId });
  }

  const specPath = useRepaired ? join(rp.dir, "spec.repaired.json") : rp.spec;
  if (!existsSync(specPath)) {
    throw new Ai3dError(
      "RUN_STATE_INVALID",
      `run "${runId}" has no ${useRepaired ? "repaired " : ""}spec yet` +
        (useRepaired ? " - a review must propose an applicable fix first" : " - submit a spec answer first"),
      { expected: specPath },
    );
  }
  const parsed = safeParseSceneSpec(JSON.parse(await readFile(specPath, "utf8")));
  if (!parsed.success) {
    throw new Ai3dError("SPEC_INVALID", "the spec does not validate", { issues: parsed.error.issues });
  }

  const reference = findReferenceFile(rp.dir);
  const targetRunId = useRepaired ? `${runId}_r${Date.now().toString(36).slice(-4)}` : runId;
  const stages: Array<{ name: string; detail: string }> = [];

  const result = await buildFromSpec(parsed.data, {
    runId: targetRunId,
    ...(reference ? { referenceImage: reference } : {}),
    onStage: (name, detail) => stages.push({ name, detail }),
  });

  const outPaths = runPaths(result.runId);
  return {
    runId: result.runId,
    passed: result.report.passed,
    scores: result.report.scores,
    gates: result.report.gates,
    exported: result.exported,
    stages,
    artifacts: {
      spec: outPaths.spec,
      blend: outPaths.blend,
      contact_sheet: outPaths.sheet,
      glb: result.exported ? outPaths.glb : null,
    },
  };
}

function findReferenceFile(dir: string): string | undefined {
  for (const name of ["reference.png", "reference.jpg", "reference.jpeg"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
