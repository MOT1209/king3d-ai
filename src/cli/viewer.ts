/**
 * `ai3d viewer <run-id>` - serve the exported GLB in a browser.
 *
 * A GLB that passes every gate can still be wrong in a way only looking at it
 * reveals, and the contact sheet shows four fixed angles. This serves the actual
 * file so it can be turned over.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { paths } from "../core/config.ts";
import { Ai3dError } from "../core/errors.ts";
import { runPaths } from "../pipeline/run.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
};

export interface ViewerOptions {
  runId: string;
  port?: number;
}

export async function runViewer(options: ViewerOptions): Promise<number> {
  const rp = runPaths(options.runId);
  if (!existsSync(rp.dir)) {
    throw new Ai3dError("RUN_NOT_FOUND", `no run named "${options.runId}"`, { expected: rp.dir });
  }
  if (!existsSync(rp.glb)) {
    throw new Ai3dError("RUN_STATE_INVALID", `run "${options.runId}" has no exported GLB`, { expected: rp.glb });
  }

  const spec = existsSync(rp.spec) ? JSON.parse(await readFile(rp.spec, "utf8")) : {};
  const manifest = {
    glb: "model.glb",
    title: spec?.object?.name ?? options.runId,
    subtitle: `run ${options.runId}`,
    bytes: statSync(rp.glb).size,
  };

  const page = (await readFile(join(paths.viewer, "index.html"), "utf8")).replace(
    "<script src=",
    `<script>window.__AI3D__ = ${JSON.stringify(manifest)};</script>\n    <script src=`,
  );

  const port = options.port ?? 5173;
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";

    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": MIME[".html"] as string });
      res.end(page);
      return;
    }
    // Only the run's own artefacts are reachable; nothing else is served.
    const allowed: Record<string, string> = {
      "/model.glb": rp.glb,
      "/contact_sheet.png": rp.sheet,
      "/spec.json": rp.spec,
      "/report.json": rp.report,
    };
    const file = allowed[url];
    if (!file || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": statSync(file).size,
    });
    createReadStream(file).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  process.stdout.write(`\nviewing ${options.runId} at http://127.0.0.1:${port}\n`);
  process.stdout.write(`  model  ${rp.glb}\n`);
  process.stderr.write("\npress Ctrl+C to stop\n");

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      server.close(() => resolve());
    });
  });
  return 0;
}
