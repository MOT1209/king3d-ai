#!/usr/bin/env node
/**
 * ai3d-mcp-server - exposes the ai3d pipeline as MCP tools.
 *
 * Every tool here calls the exact same functions the CLI (src/cli/*.ts) and
 * the web dashboard (src/server/routes.ts) already call - buildFromSpec,
 * apiCreateRun, apiSpecAnswer, apiRequestReview, apiReviewAnswer, runDoctor -
 * so a run created from a coding agent, the dashboard, or `ai3d gen` are
 * indistinguishable on disk. No pipeline logic is duplicated here; this file
 * is only the MCP transport and tool-schema layer on top of it.
 *
 * Transport is stdio, which is what makes this work with "any coding agent":
 * it is what Claude Code, Claude Desktop, Cursor, Windsurf and most local MCP
 * clients expect - the client spawns this as a subprocess and talks to it over
 * stdin/stdout. Nothing may be written to stdout except protocol frames, which
 * is why every diagnostic goes through the project's logger (stderr-only).
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { paths } from "../core/config.ts";
import { Ai3dError, errorMessage } from "../core/errors.ts";
import { createLogger } from "../core/logger.ts";
import { formatDoctorReport, runDoctor } from "../cli/doctor.ts";
import { runBuildForMcp } from "./build-run.ts";
import {
  apiCreateRun,
  apiGetRun,
  apiListRuns,
  apiRequestReview,
  apiReviewAnswer,
  apiSpecAnswer,
  type JsonResult,
} from "../server/routes.ts";

const log = createLogger("mcp");

/** Keeps a single oversized tool response from blowing out an agent's context. */
const CHARACTER_LIMIT = 20_000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) return { text, truncated: false };
  return {
    text: text.slice(0, CHARACTER_LIMIT) + `\n\n... truncated at ${CHARACTER_LIMIT} characters ...`,
    truncated: true,
  };
}

/** A JsonResult's body, as MCP tool content - JSON text plus structuredContent. */
function toToolResult(result: JsonResult): { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } {
  const isError = result.status >= 400;
  const { text, truncated } = truncate(JSON.stringify(result.body, null, 2));
  const out: ReturnType<typeof toToolResult> = {
    content: [{ type: "text", text: isError ? `Error (HTTP ${result.status}): ${text}` : text }],
  };
  if (!isError && result.body && typeof result.body === "object" && !truncated) {
    out.structuredContent = result.body as Record<string, unknown>;
  }
  if (isError) out.isError = true;
  return out;
}

/** Every catch block in this file funnels through here. */
function toErrorResult(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  if (error instanceof Ai3dError) {
    return {
      content: [{ type: "text", text: `Error [${error.code}]: ${error.message}` }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: `Error: ${errorMessage(error)}` }], isError: true };
}

/** Accepts either a JSON string (as pasted) or an object (as an agent would construct it),
 *  and returns the raw text the file-based provider expects to find on disk. */
function toResponseText(value: string | Record<string, unknown>): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function resolveImageBase64(imagePath: string): Promise<{ base64: string; name: string }> {
  const resolved = isAbsolute(imagePath) ? imagePath : join(paths.root, imagePath);
  let buffer: Buffer;
  try {
    buffer = await readFile(resolved);
  } catch (e) {
    throw new Ai3dError("CONFIG_INVALID", `could not read image at ${resolved}: ${errorMessage(e)}`, {
      path: resolved,
    });
  }
  return { base64: buffer.toString("base64"), name: resolved.split(/[/\\]/).pop() ?? "reference.png" };
}

// --------------------------------------------------------------------- server

const server = new McpServer({
  name: "ai3d-mcp-server",
  version: "0.1.0",
});

// ---- ai3d_doctor -----------------------------------------------------------

server.registerTool(
  "ai3d_doctor",
  {
    title: "Check ai3d Environment",
    description: `Check whether the ai3d pipeline can actually run on this machine right now.

Verifies the Blender executable is found, the Blender-side bridge files exist, whether the
persistent Blender daemon is running (and starts a one-off cold-start timing check if not -
this can take 30-90s on modest hardware, which is normal), and reports memory pressure that
would slow the first build after an idle period.

Call this first when a build or run creation is failing in a way that looks environmental
rather than input-related (e.g. "Blender not found", timeouts, or unexpectedly slow runs).

Returns: a list of checks, each either "ok", "warn", or "fail", plus an overall pass/fail.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const report = await runDoctor();
      return {
        content: [{ type: "text", text: formatDoctorReport(report) }],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    } catch (e) {
      return toErrorResult(e);
    }
  },
);

// ---- ai3d_list_runs ---------------------------------------------------------

const ListRunsInputSchema = z
  .object({
    status: z
      .enum(["needs_spec", "spec_ready", "built", "needs_review", "reviewed"])
      .optional()
      .describe("Only return runs in this status."),
    limit: z.number().int().min(1).max(200).default(50).describe("Maximum runs to return."),
    offset: z.number().int().min(0).default(0).describe("Number of runs to skip, for pagination."),
  })
  .strict();

server.registerTool(
  "ai3d_list_runs",
  {
    title: "List ai3d Runs",
    description: `List generation runs, newest first, with their current status and scores.

Status values: "needs_spec" (waiting on a spec answer), "spec_ready" (spec accepted, not yet
built), "built" (gates evaluated, no review yet), "needs_review" (waiting on a review verdict),
"reviewed" (a verdict has been recorded).

Args:
  - status (optional): filter to one status
  - limit (number, 1-200, default 50)
  - offset (number, default 0)

Returns JSON: { total, count, offset, runs: [{ id, status, name, passed, overall, hasGlb,
hasReference, createdAt }], has_more, next_offset }`,
    inputSchema: ListRunsInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params) => {
    try {
      const result = await apiListRuns();
      const body = result.body as { runs: Array<Record<string, unknown>> };
      const all = params.status ? body.runs.filter((r) => r["status"] === params.status) : body.runs;
      const page = all.slice(params.offset, params.offset + params.limit);
      const output = {
        total: all.length,
        count: page.length,
        offset: params.offset,
        runs: page,
        has_more: all.length > params.offset + page.length,
        ...(all.length > params.offset + page.length ? { next_offset: params.offset + page.length } : {}),
      };
      const { text } = truncate(JSON.stringify(output, null, 2));
      return { content: [{ type: "text", text }], structuredContent: output };
    } catch (e) {
      return toErrorResult(e);
    }
  },
);

// ---- ai3d_get_run -----------------------------------------------------------

const GetRunInputSchema = z
  .object({
    run_id: z.string().min(1).describe("The run id, e.g. as returned by ai3d_create_run or ai3d_list_runs."),
  })
  .strict();

server.registerTool(
  "ai3d_get_run",
  {
    title: "Get ai3d Run Detail",
    description: `Get full detail for one run: its status, the accepted spec (if any), the repaired
spec (if a review proposed applicable fixes), the gate report and scores (if built), and the
full text of any pending judgement request (a spec or review question waiting for an answer).

Use this to check what a run needs next: if pending.spec or pending.review is present in the
response, answer it with ai3d_submit_spec_answer or ai3d_submit_review_answer respectively.

Args:
  - run_id (string): the run to inspect

Returns JSON: { summary, spec, repairedSpec, report, pending: { spec?, review? }, reference }

Error Handling:
  - Returns an error if no run exists with that id (use ai3d_list_runs to find valid ids)`,
    inputSchema: GetRunInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ run_id }) => {
    try {
      return toToolResult(await apiGetRun(run_id));
    } catch (e) {
      return toErrorResult(e);
    }
  },
);

// ---- ai3d_create_run --------------------------------------------------------

const CreateRunInputSchema = z
  .object({
    image_path: z
      .string()
      .optional()
      .describe(
        "Path to a local reference image (PNG/JPEG), absolute or relative to the project root. " +
          "The file is copied into the run so the run stays self-contained.",
      ),
    prompt: z.string().optional().describe("A text description of the object, used instead of or alongside an image."),
    hints: z.string().optional().describe("Extra context for the analysis stage: intended scale, use, material."),
  })
  .strict();

server.registerTool(
  "ai3d_create_run",
  {
    title: "Create ai3d Run",
    description: `Start a new run from a reference image, a text prompt, or both.

This does not build anything yet: it prepares an analysis question (a "spec request") and
returns immediately with status "needs_spec" and the full request text. To continue:

  1. Read the returned "request" text - it explains the modelling vocabulary and what to answer.
  2. If an image was given, look at it (its path is included in the request text).
  3. Call ai3d_submit_spec_answer with a JSON answer matching the described schema.
  4. Call ai3d_build to build the accepted spec.

Args:
  - image_path (string, optional): local path to a PNG/JPEG reference image
  - prompt (string, optional): text description, used if there is no image or to supplement one
  - hints (string, optional): extra context (scale, use, material)
  (at least one of image_path or prompt is required)

Returns JSON: { runId, status: "needs_spec", request: "<the full analysis question>" }`,
    inputSchema: CreateRunInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (params) => {
    try {
      if (!params.image_path && !params.prompt) {
        throw new Ai3dError("CONFIG_INVALID", "at least one of image_path or prompt is required");
      }
      const image = params.image_path ? await resolveImageBase64(params.image_path) : null;
      const result = await apiCreateRun({
        ...(params.prompt ? { prompt: params.prompt } : {}),
        ...(params.hints ? { hints: params.hints } : {}),
        ...(image ? { imageBase64: image.base64, imageName: image.name } : {}),
      });
      return toToolResult(result);
    } catch (e) {
      return toErrorResult(e);
    }
  },
);

// ---- ai3d_submit_spec_answer -------------------------------------------------

const SubmitSpecAnswerInputSchema = z
  .object({
    run_id: z.string().min(1).describe("The run this answer is for."),
    spec: z
      .union([z.string(), z.record(z.unknown())])
      .describe(
        "The spec draft answering the request from ai3d_create_run - either a JSON object " +
          "or a JSON string (a markdown code fence around it is tolerated).",
      ),
  })
  .strict();

server.registerTool(
  "ai3d_submit_spec_answer",
  {
    title: "Submit ai3d Spec Answer",
    description: `Answer a pending spec request for a run (see ai3d_get_run's "pending.spec" field or
the request returned by ai3d_create_run).

The answer is validated against the SpecDraft schema described in the original request. An
invalid answer (missing fields, wrong types, an unknown geometry strategy) is rejected with the
specific validation errors rather than accepted partially.

Args:
  - run_id (string): the run to answer
  - spec (object or string): the spec draft

Returns JSON: { status: "spec_ready", spec: <the completed SceneSpec> } on success.

Error Handling:
  - Returns validation errors (field path + message) if the draft does not match the schema
  - Returns "not valid JSON" if a string answer cannot be parsed at all`,
    inputSchema: SubmitSpecAnswerInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ run_id, spec }) => {
    try {
      return toToolResult(await apiSpecAnswer(run_id, { text: toResponseText(spec) }));
    } catch (e) {
      return toErrorResult(e);
    }
  },
);

// ---- ai3d_build --------------------------------------------------------------

const BuildInputSchema = z
  .object({
    run_id: z.string().min(1).describe("The run to build. Must have an accepted spec (status spec_ready or later)."),
    from_repaired: z
      .boolean()
      .default(false)
      .describe(
        "Build from spec.repaired.json (the fixes a review proposed) instead of the original spec. " +
          "Writes a new run rather than overwriting this one; the new run id is in the response.",
      ),
  })
  .strict();

server.registerTool(
  "ai3d_build",
  {
    title: "Build ai3d Run",
    description: `Run the deterministic pipeline for a run's accepted spec: geometry, lighting,
renders, 11 quality gates, and (unless the run was created to skip it) a GLB export verified by
re-import. This call blocks until the build finishes or fails - on a machine without a warm
Blender daemon already running, first use of this tool can take 30-90+ seconds; subsequent
builds are much faster (milliseconds to low seconds of actual work, plus render time).

Call ai3d_get_run afterwards, or read this result's "artifacts.contact_sheet" path directly, to
look at the render before deciding whether to request a review.

Args:
  - run_id (string): the run to build
  - from_repaired (boolean, default false): build the review-repaired spec instead, producing a
    new run id

Returns JSON: { runId, passed, scores: { geometry, material, optimization, export, similarity?,
overall }, gates: [{ id, passed, severity, message }], exported, stages: [{ name, detail }],
artifacts: { spec, blend, contact_sheet, glb } }

Error Handling:
  - Returns an error if the run (or its repaired spec, with from_repaired) has no spec to build
  - A failing gate does not raise an error: check "passed" and "gates" in the result`,
    inputSchema: BuildInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ run_id, from_repaired }) => {
    try {
      const result = await runBuildForMcp(run_id, from_repaired);
      const { text, truncated } = truncate(JSON.stringify(result, null, 2));
      return {
        content: [{ type: "text", text }],
        ...(truncated ? {} : { structuredContent: result as unknown as Record<string, unknown> }),
      };
    } catch (e) {
      return toErrorResult(e);
    }
  },
);

// ---- ai3d_request_review -----------------------------------------------------

const RunIdInputSchema = z.object({ run_id: z.string().min(1).describe("The run to review.") }).strict();

server.registerTool(
  "ai3d_request_review",
  {
    title: "Request ai3d Review",
    description: `Ask for a judgement on a built run: how well the render matches the reference (or,
with no reference, whether the object is internally coherent), and any defects worth fixing.

Returns immediately with status "needs_review" and the full request text - it names the contact
sheet image to look at (get its path from ai3d_get_run's report.artifacts, or the build result)
and the JSON schema the verdict must follow. Answer it with ai3d_submit_review_answer.

If a review has already been recorded for this run, returns status "review_ready" instead of a
new request - see ai3d_get_run's report.review for the existing verdict.

Args:
  - run_id (string): the run to review (must already be built)

Returns JSON: { status: "needs_review", request: "<the full review question>" } or
{ status: "review_ready" }

Error Handling:
  - Returns an error if the run has no contact sheet yet (build it first) or no spec`,
    inputSchema: RunIdInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ run_id }) => {
    try {
      return toToolResult(await apiRequestReview(run_id));
    } catch (e) {
      return toErrorResult(e);
    }
  },
);

// ---- ai3d_submit_review_answer -----------------------------------------------

const SubmitReviewAnswerInputSchema = z
  .object({
    run_id: z.string().min(1).describe("The run this verdict is for."),
    verdict: z
      .union([z.string(), z.record(z.unknown())])
      .describe(
        "The review verdict answering the request from ai3d_request_review - either a JSON " +
          "object or a JSON string (a markdown code fence around it is tolerated).",
      ),
  })
  .strict();

server.registerTool(
  "ai3d_submit_review_answer",
  {
    title: "Submit ai3d Review Answer",
    description: `Answer a pending review request for a run (see ai3d_get_run's "pending.review" field).

Any defect in the verdict that carries a machine-applicable fix (a path into the spec plus a new
value - sizes, placements, rotations, or material colour/metallic/roughness only, never
structure) is applied to a copy of the spec and written to spec.repaired.json. Nothing is
rebuilt automatically: call ai3d_build with from_repaired: true to see the result.

Args:
  - run_id (string): the run to answer
  - verdict (object or string): the review verdict

Returns JSON: { verdict: <the recorded verdict>, scores: <scores with similarity merged in>,
repair: { applied: [...], skipped: [...] } }

Error Handling:
  - Returns validation errors if the verdict does not match the ReviewVerdict schema
  - A skipped fix (wrong shape, unknown target) is reported in "repair.skipped" with a reason,
    not as a tool error - the rest of the verdict is still recorded`,
    inputSchema: SubmitReviewAnswerInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ run_id, verdict }) => {
    try {
      return toToolResult(await apiReviewAnswer(run_id, { text: toResponseText(verdict) }));
    } catch (e) {
      return toErrorResult(e);
    }
  },
);

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("ai3d-mcp-server running on stdio");
}

main().catch((error: unknown) => {
  log.error("fatal error starting ai3d-mcp-server", errorMessage(error));
  process.exit(1);
});
