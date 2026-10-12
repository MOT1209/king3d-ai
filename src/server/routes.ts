/**
 * Pure API handlers for the dashboard.
 *
 * Each function takes plain data and returns {status, body} - no node:http
 * objects, no side channel. That makes every route testable with vitest by
 * calling it directly, and keeps http.ts a thin adapter that only has to worry
 * about parsing a request and writing a response.
 *
 * These call the same pipeline/provider functions the CLI calls
 * (buildSpecRequest, buildReviewRequest, AgentInLoopProvider.ask, applyRepairs,
 * withSimilarity, completeDraft) so there is exactly one implementation of what
 * a spec answer or a review answer means. gen.ts, review.ts and build.ts are
 * untouched - this is a second, JSON-shaped front end onto the same library.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { paths, loadConfig } from "../core/config.ts";
import { Ai3dError, errorMessage } from "../core/errors.ts";
import { buildSpecRequest } from "../pipeline/analyze.ts";
import { formatGateReport, withSimilarity, type GateReport } from "../pipeline/gates.ts";
import {
  applyRepairs,
  buildReviewRequest,
  type Defect,
  type RepairOutcome,
  type ReviewVerdict,
} from "../pipeline/review.ts";
import { newRunId } from "../pipeline/run.ts";
import { buildFromGenerated } from "../pipeline/generative-run.ts";
import { applyEdit, listRevisions, revertTo, type EditFix } from "./edit.ts";
import { proposeEdit } from "./ai-edit.ts";
import { createChatClient, llmStatus } from "../providers/llm/index.ts";
import { LlmModelProvider } from "../providers/llm/llm-provider.ts";
import type { ModelProvider } from "../providers/provider.ts";
import { parseGenerativeSpec } from "../spec/generative-spec.ts";
import { AgentInLoopProvider } from "../providers/agent-in-loop.ts";
import { createReviewProvider } from "../providers/index.ts";
import { NeedsModelInput } from "../providers/provider.ts";
import { completeDraft, safeParseSceneSpec, type SceneSpec } from "../spec/scene-spec.ts";
import { listRuns, readRunSummary, runExists, runPaths, type RunPaths } from "./runs-list.ts";

export interface JsonResult {
  status: number;
  body: unknown;
}

function ok(body: unknown, status = 200): JsonResult {
  return { status, body };
}

function errorResult(e: unknown): JsonResult {
  if (e instanceof Ai3dError) {
    const status =
      e.code === "RUN_NOT_FOUND"
        ? 404
        : e.code === "SPEC_INVALID" ||
            e.code === "TOOL_OUTPUT_INVALID" ||
            e.code === "CONFIG_INVALID" ||
            e.code === "RUN_STATE_INVALID"
          ? 400
          : e.code === "LLM_UNAVAILABLE" || e.code === "LLM_FAILED" || e.code === "LLM_INVALID_OUTPUT"
            ? 502
            : 500;
    return ok({ error: e.code, message: e.message, details: e.details }, status);
  }
  return ok({ error: "INTERNAL", message: errorMessage(e) }, 500);
}

/** Wrap a handler so any thrown error becomes a proper JSON error response. */
async function guarded(fn: () => Promise<JsonResult>): Promise<JsonResult> {
  try {
    return await fn();
  } catch (e) {
    return errorResult(e);
  }
}

function requireRun(id: string): RunPaths {
  if (!runExists(id)) {
    throw new Ai3dError("RUN_NOT_FOUND", `no run named "${id}"`, { runId: id });
  }
  return runPaths(id);
}

/** The reference image a run was built from, if it kept one. */
function findReference(dir: string): string | undefined {
  for (const name of ["reference.png", "reference.jpg", "reference.jpeg"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

interface GenContext {
  prompt?: string;
  hints?: string;
}

/** Persisted alongside the request so a second call (the answer) can rebuild
 *  the exact same VisionRequest - the CLI gets this for free from --image/--prompt
 *  flags the user retypes; the dashboard remembers it instead. */
function genContextPath(rp: RunPaths): string {
  return join(rp.prompts, "gen-context.json");
}

const EXAMPLE_SPEC_PATH = join(paths.root, "src", "spec", "fixtures", "mug.json");
async function loadExampleSpec(): Promise<unknown> {
  return JSON.parse(await readFile(EXAMPLE_SPEC_PATH, "utf8"));
}

// ---------------------------------------------------------------- run list

export async function apiListRuns(): Promise<JsonResult> {
  return guarded(async () => ok({ runs: await listRuns() }));
}

export async function apiGetRun(id: string): Promise<JsonResult> {
  return guarded(async () => {
    const rp = requireRun(id);
    const summary = await readRunSummary(id);
    const spec = await readJsonIfExists<SceneSpec>(rp.spec);
    const repairedSpec = await readJsonIfExists<SceneSpec>(join(rp.dir, "spec.repaired.json"));
    const report = await readJsonIfExists<Record<string, unknown>>(rp.report);

    const pending: Record<string, string> = {};
    for (const stage of ["spec", "review"] as const) {
      const requestPath = join(rp.prompts, `${stage}.request.md`);
      const responsePath = join(rp.prompts, `${stage}.response.json`);
      if (existsSync(requestPath) && !existsSync(responsePath)) {
        pending[stage] = await readFile(requestPath, "utf8");
      }
    }

    return ok({
      summary,
      spec,
      repairedSpec,
      report,
      pending,
      reference: findReference(rp.dir) ? "reference" : null,
    });
  });
}

// ---------------------------------------------------------------- create + spec

export interface CreateRunInput {
  prompt?: string;
  hints?: string;
  /** Raw file bytes, base64-encoded; simpler and just as correct as multipart
   *  for the small reference images this pipeline works with. */
  imageBase64?: string;
  imageName?: string;
}

export async function apiCreateRun(input: CreateRunInput): Promise<JsonResult> {
  return guarded(async () => {
    if (!input.prompt && !input.imageBase64) {
      throw new Ai3dError("CONFIG_INVALID", "a new run needs an image or a text prompt");
    }
    const runId = newRunId("web");
    const rp = runPaths(runId);
    await mkdir(rp.dir, { recursive: true });
    await mkdir(rp.prompts, { recursive: true });

    let imagePath: string | undefined;
    if (input.imageBase64) {
      const ext = input.imageName ? extname(input.imageName) || ".png" : ".png";
      imagePath = join(rp.dir, `reference${ext}`);
      await writeFile(imagePath, Buffer.from(input.imageBase64, "base64"));
    }

    const context: GenContext = {};
    if (input.prompt) context.prompt = input.prompt;
    if (input.hints) context.hints = input.hints;
    await writeFile(genContextPath(rp), JSON.stringify(context, null, 2), "utf8");

    const requestText = await requestSpecAnswer(rp, imagePath, context);
    return ok({ runId, status: "needs_spec", request: requestText }, 202);
  });
}

// ---------------------------------------------------------------- editor

export interface EditInput {
  fixes: EditFix[];
}

/** Apply editor edits to the run's working spec. Rebuilding is a separate step. */
export async function apiEditRun(id: string, input: EditInput): Promise<JsonResult> {
  return guarded(async () => {
    const rp = requireRun(id);
    const result = await applyEdit(rp, input?.fixes ?? []);
    return ok({
      rev: result.rev,
      applied: result.outcome.applied,
      skipped: result.outcome.skipped,
      spec: result.outcome.spec,
    });
  });
}

export async function apiListRevisions(id: string): Promise<JsonResult> {
  return guarded(async () => ok({ revisions: await listRevisions(requireRun(id)) }));
}

/** rev 0 returns to the originally built spec. */
export async function apiRevertRun(id: string, rev: number): Promise<JsonResult> {
  return guarded(async () => ok({ rev, spec: await revertTo(requireRun(id), rev) }));
}

/** Which in-app model is configured. Never includes the key. */
export async function apiLlmStatus(): Promise<JsonResult> {
  return guarded(async () => ok(llmStatus(loadConfig())));
}

export interface AiEditInput {
  instruction: string;
}

/**
 * Ask the configured model to propose edits for a run. Returns a proposal only;
 * nothing is written until the person applies it through /edit.
 * `deps.provider` lets tests substitute a fake model.
 */
export async function apiAiEdit(
  id: string,
  input: AiEditInput,
  deps: { provider?: ModelProvider } = {},
): Promise<JsonResult> {
  return guarded(async () => {
    const rp = requireRun(id);
    let provider = deps.provider;
    if (!provider) {
      const client = createChatClient(loadConfig());
      if (!client) {
        throw new Ai3dError(
          "CONFIG_INVALID",
          "no AI model is configured. Set KING3D_LLM_PROVIDER (anthropic or openai-compatible) and its key; see docs/ai.md",
        );
      }
      provider = new LlmModelProvider(client);
    }
    const proposal = await proposeEdit(rp, input?.instruction ?? "", provider);
    return ok({ ...proposal, model: provider.name });
  });
}

// ---------------------------------------------------------------- generative mode

export interface CreateGenerativeRunInput {
  prompt?: string;
  name?: string;
  imageBase64?: string;
  imageName?: string;
}

/**
 * Generative mode: one synchronous call that generates a TRELLIS.2 base mesh and
 * runs it through repair/optimise/gates. Unlike apiCreateRun there is no spec
 * judgement loop - the mesh comes from the model, so the run completes here.
 */
export async function apiCreateGenerativeRun(input: CreateGenerativeRunInput): Promise<JsonResult> {
  return guarded(async () => {
    if (!input.prompt && !input.imageBase64) {
      throw new Ai3dError("CONFIG_INVALID", "a generative run needs an image or a text prompt");
    }
    const runId = newRunId("gen");
    const rp = runPaths(runId);
    await mkdir(rp.dir, { recursive: true });

    let imageName: string | undefined;
    if (input.imageBase64) {
      const ext = input.imageName ? extname(input.imageName) || ".png" : ".png";
      imageName = `reference${ext}`;
      await writeFile(join(rp.dir, imageName), Buffer.from(input.imageBase64, "base64"));
    }

    const objectName = input.name ?? input.prompt ?? "generated_asset";
    const spec = parseGenerativeSpec({
      id: runId,
      created_at: new Date().toISOString(),
      source: {
        ...(imageName ? { image: imageName } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
      },
      generator: { name: "trellis2", model: "4B" },
      object: { name: objectName, category: "generated" },
    });

    const result = await buildFromGenerated(spec, { runId });
    return ok({
      runId: result.runId,
      mode: "generative",
      passed: result.report.passed,
      scores: result.report.scores,
      gates: result.report.gates,
      exported: result.exported,
    });
  });
}

/** Build the spec request, write it to disk, and return its text - or, on the
 *  rare synchronous provider, complete the spec directly and return null. */
async function requestSpecAnswer(
  rp: RunPaths,
  imagePath: string | undefined,
  context: GenContext,
): Promise<string> {
  const provider = new AgentInLoopProvider({ promptDir: rp.prompts });
  const request = buildSpecRequest({
    ...(imagePath ? { imagePath } : {}),
    ...(context.prompt ? { prompt: context.prompt } : {}),
    ...(context.hints ? { hints: context.hints } : {}),
    example: await loadExampleSpec(),
  });

  try {
    await provider.ask(request);
    // A provider that answers synchronously would let this fall through; the
    // agent-in-loop provider always throws on the first call, so this branch
    // exists only to keep the type honest for a future provider.
    return await readFile(provider.requestPath("spec"), "utf8");
  } catch (e) {
    if (e instanceof NeedsModelInput) {
      return readFile(e.requestPath, "utf8");
    }
    throw e;
  }
}

export interface AnswerInput {
  /** Exactly what the CLI's response file would contain: raw pasted text,
   *  a code fence around it is fine, the provider strips it. */
  text: string;
}

export async function apiSpecAnswer(id: string, input: AnswerInput): Promise<JsonResult> {
  return guarded(async () => {
    const rp = requireRun(id);
    const provider = new AgentInLoopProvider({ promptDir: rp.prompts });
    await writeFile(provider.responsePath("spec"), input.text, "utf8");

    const context = (await readJsonIfExists<GenContext>(genContextPath(rp))) ?? {};
    const imagePath = findReference(rp.dir);
    const request = buildSpecRequest({
      ...(imagePath ? { imagePath } : {}),
      ...(context.prompt ? { prompt: context.prompt } : {}),
      ...(context.hints ? { hints: context.hints } : {}),
      example: await loadExampleSpec(),
    });

    const draft = await provider.ask(request); // throws Ai3dError(TOOL_OUTPUT_INVALID) on a bad answer
    const spec = completeDraft(draft, {
      id,
      source: {
        ...(imagePath ? { image: "reference" } : {}),
        ...(context.prompt ? { prompt: context.prompt } : {}),
      },
    });
    await writeFile(rp.spec, JSON.stringify(spec, null, 2), "utf8");
    return ok({ status: "spec_ready", spec });
  });
}

// ---------------------------------------------------------------- review

/**
 * Fold a review verdict into the run: merge similarity into the scores, apply
 * any machine-applicable fixes to a repaired spec, and persist the report.
 *
 * Shared by the request path (when a provider answers synchronously, as the
 * deterministic one does) and the answer path (when a human wrote the verdict
 * to disk), so both produce the same on-disk result.
 */
async function recordReview(
  rp: RunPaths,
  spec: SceneSpec,
  stored: Record<string, unknown>,
  storedScores: GateReport["scores"],
  verdict: ReviewVerdict,
): Promise<{ merged: GateReport["scores"]; repair: RepairOutcome }> {
  const merged = withSimilarity(storedScores, verdict.similarity);
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

  return { merged, repair };
}

export async function apiRequestReview(id: string): Promise<JsonResult> {
  return guarded(async () => {
    const rp = requireRun(id);
    if (!existsSync(rp.sheet)) {
      throw new Ai3dError("RUN_STATE_INVALID", `run "${id}" has no contact sheet yet; build it first`, {
        expected: rp.sheet,
      });
    }
    const spec = await readJsonIfExists<SceneSpec>(rp.spec);
    if (!spec) throw new Ai3dError("RUN_STATE_INVALID", `run "${id}" has no spec`, {});

    const stored = (await readJsonIfExists<{ scores?: GateReport["scores"]; gates?: GateReport["gates"] }>(
      rp.report,
    )) ?? {};
    const gates: GateReport = {
      gates: stored.gates ?? [],
      scores: stored.scores ?? { geometry: 0, material: 0, optimization: 0, export: 0, overall: 0 },
      passed: false,
    };

    const provider = createReviewProvider(loadConfig(), rp.prompts);
    const reference = findReference(rp.dir);
    const request = buildReviewRequest({
      spec,
      sheetPath: rp.sheet,
      ...(reference ? { referencePath: reference } : {}),
      gates,
      cycle: 0,
    });

    try {
      // A provider that answers synchronously (the deterministic one) returns
      // here; one that needs a judgement throws NeedsModelInput instead.
      const verdict = await provider.ask(request);
      const { merged, repair } = await recordReview(rp, spec, stored, gates.scores, verdict);
      return ok({ status: "review_ready", verdict, scores: merged, repair });
    } catch (e) {
      if (e instanceof NeedsModelInput) {
        return ok({ status: "needs_review", request: await readFile(e.requestPath, "utf8") }, 202);
      }
      throw e;
    }
  });
}

export async function apiReviewAnswer(id: string, input: AnswerInput): Promise<JsonResult> {
  return guarded(async () => {
    const rp = requireRun(id);
    const spec = await readJsonIfExists<SceneSpec>(rp.spec);
    if (!spec) throw new Ai3dError("RUN_STATE_INVALID", `run "${id}" has no spec`, {});

    const provider = createReviewProvider(loadConfig(), rp.prompts);
    await writeFile(provider.responsePath("review"), input.text, "utf8");

    const stored = (await readJsonIfExists<Record<string, unknown>>(rp.report)) ?? {};
    const storedScores = (stored["scores"] as GateReport["scores"] | undefined) ?? {
      geometry: 0,
      material: 0,
      optimization: 0,
      export: 0,
      overall: 0,
    };
    const gates: GateReport = {
      gates: (stored["gates"] as GateReport["gates"] | undefined) ?? [],
      scores: storedScores,
      passed: (stored["passed"] as boolean | undefined) ?? false,
    };
    const reference = findReference(rp.dir);
    const request = buildReviewRequest({
      spec,
      sheetPath: rp.sheet,
      ...(reference ? { referencePath: reference } : {}),
      gates,
      cycle: 0,
    });

    const verdict = await provider.ask(request); // throws on a bad answer

    const { merged, repair } = await recordReview(rp, spec, stored, storedScores, verdict);
    return ok({ verdict, scores: merged, repair });
  });
}

export { formatGateReport };
