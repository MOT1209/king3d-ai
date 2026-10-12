/**
 * The node:http adapter: parses requests, dispatches to routes.ts for JSON
 * endpoints, streams build progress as SSE, and serves the dashboard's static
 * assets plus each run's own files.
 *
 * Builds are serialised through a single queue because there is exactly one
 * Blender daemon behind every request - the same reason SocketBackend queues
 * individual commands (src/integrations/blender/socket.ts), one level up.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { paths } from "../core/config.ts";
import { Ai3dError, errorMessage } from "../core/errors.ts";
import { createLogger } from "../core/logger.ts";
import { buildFromSpec } from "../pipeline/run.ts";
import { safeParseSceneSpec } from "../spec/scene-spec.ts";
import {
  apiAiEdit,
  apiGenerators,
  apiLlmStatus,
  apiCreateGenerativeRun,
  apiEditRun,
  apiListRevisions,
  apiRevertRun,
  apiCreateRun,
  apiGetRun,
  apiListRuns,
  apiRequestReview,
  apiReviewAnswer,
  apiSpecAnswer,
  type AnswerInput,
  type AiEditInput,
  type CreateGenerativeRunInput,
  type CreateRunInput,
  type EditInput,
  type JsonResult,
} from "./routes.ts";
import { readRunSummary, runExists, runPaths } from "./runs-list.ts";

const log = createLogger("server:http");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
};

/** Serialises everything that touches the one Blender daemon behind this server. */
let buildQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = buildQueue.then(work, work);
  buildQueue = result.catch(() => undefined);
  return result;
}

async function readBody(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Ai3dError("CONFIG_INVALID", `request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new Ai3dError("CONFIG_INVALID", `request body is not valid JSON: ${errorMessage(e)}`);
  }
}

function sendJson(res: ServerResponse, result: JsonResult): void {
  const body = JSON.stringify(result.body);
  res.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

/** SSE event: named, JSON-encoded data. */
function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Run a build (fresh spec or the repaired one) and stream its stages as SSE. */
function streamBuild(res: ServerResponse, runId: string, useRepaired: boolean): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  enqueue(async () => {
    try {
      const rp = runPaths(runId);
      const specPath = useRepaired ? join(rp.dir, "spec.repaired.json") : rp.spec;
      if (!existsSync(specPath)) {
        throw new Ai3dError("RUN_STATE_INVALID", `no ${useRepaired ? "repaired " : ""}spec for run "${runId}"`, {
          expected: specPath,
        });
      }
      const parsed = safeParseSceneSpec(JSON.parse(await readFile(specPath, "utf8")));
      if (!parsed.success) {
        throw new Ai3dError("SPEC_INVALID", "the spec does not validate", { issues: parsed.error.issues });
      }

      const reference = findReferenceFile(rp.dir);
      const targetRunId = useRepaired ? `${runId}_r${Date.now().toString(36).slice(-4)}` : runId;

      const result = await buildFromSpec(parsed.data, {
        runId: targetRunId,
        ...(reference ? { referenceImage: reference } : {}),
        onStage: (name, detail) => sendEvent(res, "stage", { name, detail }),
      });

      sendEvent(res, "done", {
        runId: result.runId,
        passed: result.report.passed,
        scores: result.report.scores,
        gates: result.report.gates,
        exported: result.exported,
      });
    } catch (e) {
      const message = e instanceof Ai3dError ? e.message : errorMessage(e);
      sendEvent(res, "error", { message });
    } finally {
      res.end();
    }
  }).catch(() => undefined);
}

function findReferenceFile(dir: string): string | undefined {
  for (const name of ["reference.png", "reference.jpg", "reference.jpeg"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Serve a file, but only when it resolves inside `baseDir` - blocks traversal
 *  (../, absolute overrides) regardless of how the URL was encoded. */
function serveWithinDir(res: ServerResponse, baseDir: string, relative: string): void {
  const base = resolvePath(baseDir);
  // Strip any leading slashes so a "/etc/passwd"-shaped relative path is
  // joined under base rather than being treated as its own absolute root.
  const cleaned = normalize(relative).replace(/^[/\\]+/, "");
  const target = resolvePath(base, cleaned);

  const isInside = target === base || target.startsWith(base + sep);
  if (!isInside) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return;
  }
  if (!existsSync(target) || statSync(target).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "content-length": statSync(target).size,
  });
  createReadStream(target).pipe(res);
}

export interface ServerOptions {
  port: number;
  host?: string;
}

export function startServer(options: ServerOptions): ReturnType<typeof createServer> {
  const host = options.host ?? "127.0.0.1";

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      log.error("unhandled request error", errorMessage(e));
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "INTERNAL", message: errorMessage(e) }));
      } else {
        res.end();
      }
    });
  });

  server.listen(options.port, host);
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";
  const path = url.pathname;
  const parts = path.split("/").filter(Boolean); // e.g. ["api","runs","web_123","build"]

  // ---- API ----------------------------------------------------------
  if (parts[0] === "api") {
    if (parts[1] === "runs" && parts.length === 2) {
      if (method === "GET") return sendJson(res, await apiListRuns());
      if (method === "POST") return sendJson(res, await apiCreateRun((await readJsonBody(req)) as CreateRunInput));
    }

    if (parts[1] === "generators" && parts.length === 2 && method === "GET") {
      return sendJson(res, await apiGenerators());
    }
    if (parts[1] === "llm" && parts.length === 2 && method === "GET") {
      return sendJson(res, await apiLlmStatus());
    }

    // Generative mode (TRELLIS.2): one synchronous call, no spec/review loop.
    if (parts[1] === "generate" && parts.length === 2 && method === "POST") {
      return sendJson(res, await apiCreateGenerativeRun((await readJsonBody(req)) as CreateGenerativeRunInput));
    }

    const runId = parts[2];
    if (parts[1] === "runs" && runId && parts.length === 3 && method === "GET") {
      return sendJson(res, await apiGetRun(runId));
    }

    if (parts[1] === "runs" && runId && parts.length === 4) {
      const action = parts[3];

      if (action === "spec-answer" && method === "POST") {
        return sendJson(res, await apiSpecAnswer(runId, (await readJsonBody(req)) as AnswerInput));
      }
      if (action === "edit" && method === "POST") {
        return sendJson(res, await apiEditRun(runId, (await readJsonBody(req)) as EditInput));
      }
      if (action === "ai-edit" && method === "POST") {
        return sendJson(res, await apiAiEdit(runId, (await readJsonBody(req)) as AiEditInput));
      }
      if (action === "revisions" && method === "GET") {
        return sendJson(res, await apiListRevisions(runId));
      }
      if (action === "revert" && method === "POST") {
        const body = (await readJsonBody(req)) as { rev?: number };
        return sendJson(res, await apiRevertRun(runId, Number(body?.rev)));
      }
      if (action === "review" && method === "POST") {
        return sendJson(res, await apiRequestReview(runId));
      }
      if (action === "review-answer" && method === "POST") {
        return sendJson(res, await apiReviewAnswer(runId, (await readJsonBody(req)) as AnswerInput));
      }
      if (action === "build" && method === "POST") {
        if (!runExists(runId)) return sendJson(res, { status: 404, body: { error: "RUN_NOT_FOUND" } });
        return streamBuild(res, runId, false);
      }
      if (action === "rebuild" && method === "POST") {
        if (!runExists(runId)) return sendJson(res, { status: 404, body: { error: "RUN_NOT_FOUND" } });
        return streamBuild(res, runId, true);
      }
      if (action === "status" && method === "GET") {
        if (!runExists(runId)) return sendJson(res, { status: 404, body: { error: "RUN_NOT_FOUND" } });
        return sendJson(res, { status: 200, body: await readRunSummary(runId) });
      }
    }

    if (parts[1] === "runs" && runId && parts[3] === "files" && method === "GET") {
      if (!runExists(runId)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const relative = parts.slice(4).join("/");
      return serveWithinDir(res, runPaths(runId).dir, relative);
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND", message: `no route for ${method} ${path}` }));
    return;
  }

  // ---- static dashboard assets ---------------------------------------
  if (path === "/" || path === "/index.html") {
    return serveWithinDir(res, paths.web, "index.html");
  }
  return serveWithinDir(res, paths.web, path);
}
