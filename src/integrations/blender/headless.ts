/**
 * Headless backend: one `blender -b` process per batch.
 *
 * Startup costs ~1-2s, so commands are sent as a batch and scene state is carried
 * between batches through a .blend file rather than a live process. This is the
 * default because it is deterministic, needs no GUI, and runs in CI.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, paths, requireBlenderExecutable, type Ai3dConfig } from "../../core/config.ts";
import { Ai3dError, errorMessage } from "../../core/errors.ts";
import { createLogger } from "../../core/logger.ts";
import type { BatchOutcome, BlenderBackend, JobContext } from "./backend.ts";
import { JobResultSchema, type BridgeRequest } from "./protocol.ts";

const log = createLogger("blender:headless");

export interface HeadlessOptions {
  blenderPath?: string;
  timeoutMs?: number;
  /** Keep the job/result JSON on disk for debugging. */
  keepJobFiles?: boolean;
  allowPythonExec?: boolean;
}

export class HeadlessBackend implements BlenderBackend {
  readonly kind = "headless" as const;
  readonly #blenderPath: string;
  readonly #timeoutMs: number;
  readonly #keepJobFiles: boolean;
  readonly #allowPythonExec: boolean;

  constructor(options: HeadlessOptions = {}, config: Ai3dConfig = loadConfig()) {
    this.#blenderPath = options.blenderPath ?? requireBlenderExecutable();
    this.#timeoutMs = options.timeoutMs ?? config.blenderTimeoutMs;
    this.#keepJobFiles = options.keepJobFiles ?? process.env["AI3D_KEEP_JOBS"] === "1";
    this.#allowPythonExec = options.allowPythonExec ?? config.allowPythonExec;
  }

  get blenderPath(): string {
    return this.#blenderPath;
  }

  async execute(requests: BridgeRequest[], context: JobContext = {}): Promise<BatchOutcome> {
    if (requests.length === 0) return { responses: [], ok: true };

    const startedAt = Date.now();
    const workDir = await mkdtemp(join(tmpdir(), "ai3d-job-"));
    const jobPath = join(workDir, "job.json");
    const resultPath = join(workDir, "result.json");

    const job = {
      commands: requests,
      context: {
        load_blend: context.loadBlend ?? null,
        save_blend: context.saveBlend ?? null,
        cwd: context.cwd ?? paths.root,
      },
      options: { allow_python_exec: this.#allowPythonExec },
    };

    try {
      await writeFile(jobPath, JSON.stringify(job, null, 2), "utf8");
      if (context.saveBlend) await mkdir(dirname(context.saveBlend), { recursive: true });

      const { code, stderr } = await this.#spawnBlender(jobPath, resultPath);

      let raw: string;
      try {
        raw = await readFile(resultPath, "utf8");
      } catch {
        throw new Ai3dError(
          "BLENDER_LAUNCH_FAILED",
          `Blender exited (code ${code}) without writing a result file. This usually means the runner script itself failed to start.`,
          { exitCode: code, stderr: tail(stderr, 4000), jobPath },
        );
      }

      const parsed = JobResultSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Ai3dError("BRIDGE_PROTOCOL_ERROR", "Blender result file has an unexpected shape", {
          issues: parsed.error.issues,
          preview: raw.slice(0, 500),
        });
      }
      const jobResult = parsed.data;

      if (jobResult.fatal) {
        throw new Ai3dError("BLENDER_COMMAND_FAILED", `Blender job aborted: ${jobResult.fatal.message}`, {
          error: jobResult.fatal,
          stderr: tail(stderr, 2000),
        });
      }

      const wallMs = Date.now() - startedAt;
      const outcome: BatchOutcome = {
        responses: jobResult.responses,
        ok: jobResult.ok,
        savedBlend: jobResult.saved_blend ?? null,
        wallMs,
      };
      if (jobResult.blender_version) outcome.blenderVersion = jobResult.blender_version;
      if (jobResult.python_version) outcome.pythonVersion = jobResult.python_version;
      if (jobResult.timings) {
        outcome.timings = jobResult.timings;
        const inside =
          jobResult.timings.scene_open_ms +
          jobResult.timings.handlers_import_ms +
          jobResult.timings.batch_ms +
          jobResult.timings.save_ms;
        outcome.overheadMs = Math.max(0, wallMs - inside);
      }
      return outcome;
    } finally {
      if (this.#keepJobFiles) {
        log.debug("job files kept", { workDir });
      } else {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  #spawnBlender(jobPath: string, resultPath: string): Promise<{ code: number | null; stderr: string }> {
    const args = [
      "--background",
      "--factory-startup", // ignore user addons (incl. third-party blender-mcp) for determinism
      "-noaudio", // single dash: Blender rejects "--noaudio" as an unknown argument
      "--python-exit-code",
      "42",
      "--python",
      paths.blenderRunner,
      "--",
      "--job",
      jobPath,
      "--result",
      resultPath,
    ];
    log.debug("spawn", { blender: this.#blenderPath, jobPath });

    return new Promise((resolve, reject) => {
      const child = spawn(this.#blenderPath, args, { windowsHide: true });
      let stderr = "";
      let stdout = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.#timeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new Ai3dError("BLENDER_LAUNCH_FAILED", `Could not launch Blender: ${errorMessage(err)}`, {
            blenderPath: this.#blenderPath,
          }),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new Ai3dError("BRIDGE_TIMEOUT", `Blender exceeded the ${this.#timeoutMs}ms budget and was killed`, {
              stderr: tail(stderr, 2000),
            }),
          );
          return;
        }
        // Blender writes plenty to stdout; keep it only when something went wrong.
        if (code !== 0) log.debug("blender stdout", tail(stdout, 2000));
        resolve({ code, stderr });
      });
    });
  }

  async close(): Promise<void> {
    // Nothing to tear down: each batch owns its own process.
  }
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : "..." + text.slice(text.length - max);
}
