/**
 * Socket backend: talks to a long-lived Blender running our command server.
 *
 * This is the primary execution path. Blender takes 30-90s to start on modest
 * hardware while the commands themselves take milliseconds, so the pipeline pays
 * that cost once per session instead of once per batch.
 *
 * The peer is either a headless daemon we own (blender/daemon.py) or a GUI
 * Blender the user has open with the ai3d_bridge addon - identical protocol.
 */
import { connect, type Socket } from "node:net";
import { Ai3dError, errorMessage } from "../../core/errors.ts";
import { createLogger } from "../../core/logger.ts";
import type { BatchOutcome, BlenderBackend, JobContext } from "./backend.ts";
import { encodeFrame, FrameDecoder } from "./frame.ts";
import { JobResultSchema, type BridgeRequest } from "./protocol.ts";

const log = createLogger("blender:socket");

export interface ServerHello {
  protocol: number;
  pid: number;
  blender_version: string;
  python_version: string;
  binary: string;
}

export interface SocketOptions {
  host?: string;
  port?: number;
  /** Budget for one request/response round trip, not for the connection. */
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  allowPythonExec?: boolean;
}

/** Open a connection, or reject if nothing is listening. */
function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Ai3dError("BRIDGE_UNAVAILABLE", `Timed out connecting to the Blender bridge at ${host}:${port}`, {
          host,
          port,
        }),
      );
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(
        new Ai3dError("BRIDGE_UNAVAILABLE", `No Blender bridge at ${host}:${port}: ${errorMessage(err)}`, {
          host,
          port,
        }),
      );
    });
  });
}

/** True when something is accepting connections on the port. */
export async function isBridgeReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const socket = await openSocket(host, port, timeoutMs);
    // end() sends FIN so the server sees a clean EOF; destroy() would send RST,
    // which is a far nastier thing to hand a single-threaded accept loop.
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export class SocketBackend implements BlenderBackend {
  readonly kind = "socket" as const;
  readonly host: string;
  readonly port: number;
  readonly #requestTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #allowPythonExec: boolean;
  #socket: Socket | null = null;
  /** Serialises requests: one Blender, one main thread, one batch at a time. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SocketOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 9877;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 900_000;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.#allowPythonExec = options.allowPythonExec ?? false;
  }

  async #connection(): Promise<Socket> {
    if (this.#socket && !this.#socket.destroyed) return this.#socket;
    this.#socket = await openSocket(this.host, this.port, this.#connectTimeoutMs);
    this.#socket.once("close", () => {
      this.#socket = null;
    });
    return this.#socket;
  }

  /** Send one message and await exactly one framed reply. */
  #send(message: unknown): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      const socket = await this.#connection();
      return new Promise((resolve, reject) => {
        const decoder = new FrameDecoder();
        let settled = false;

        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.off("data", onData);
          socket.off("error", onError);
          socket.off("close", onClose);
          fn();
        };

        const onData = (chunk: Buffer): void => {
          let frames: unknown[];
          try {
            frames = decoder.push(chunk);
          } catch (e) {
            finish(() => reject(e));
            return;
          }
          if (frames.length > 0) finish(() => resolve(frames[0]));
        };
        const onError = (err: Error): void => {
          finish(() =>
            reject(new Ai3dError("BRIDGE_PROTOCOL_ERROR", `Bridge connection error: ${errorMessage(err)}`)),
          );
        };
        const onClose = (): void => {
          finish(() =>
            reject(
              new Ai3dError("BRIDGE_UNAVAILABLE", "Blender closed the bridge connection before replying", {
                pendingBytes: decoder.pending,
              }),
            ),
          );
        };
        const timer = setTimeout(() => {
          finish(() =>
            reject(
              new Ai3dError("BRIDGE_TIMEOUT", `Blender did not reply within ${this.#requestTimeoutMs}ms`, {
                host: this.host,
                port: this.port,
              }),
            ),
          );
        }, this.#requestTimeoutMs);

        socket.on("data", onData);
        socket.once("error", onError);
        socket.once("close", onClose);
        socket.write(encodeFrame(message));
      });
    };

    // Chain onto the queue so concurrent callers cannot interleave frames.
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async hello(): Promise<ServerHello> {
    const reply = (await this.#send({ type: "hello" })) as Record<string, unknown>;
    if (reply?.["ok"] !== true) {
      throw new Ai3dError("BRIDGE_PROTOCOL_ERROR", "Bridge did not answer the hello handshake", { reply });
    }
    return {
      protocol: Number(reply["protocol"] ?? 0),
      pid: Number(reply["pid"] ?? 0),
      blender_version: String(reply["blender_version"] ?? ""),
      python_version: String(reply["python_version"] ?? ""),
      binary: String(reply["binary"] ?? ""),
    };
  }

  async execute(requests: BridgeRequest[], context: JobContext = {}): Promise<BatchOutcome> {
    if (requests.length === 0) return { responses: [], ok: true };

    const startedAt = Date.now();
    const reply = await this.#send({
      type: "batch",
      job: {
        commands: requests,
        context: {
          load_blend: context.loadBlend ?? null,
          save_blend: context.saveBlend ?? null,
          cwd: context.cwd ?? null,
        },
        options: { allow_python_exec: this.#allowPythonExec },
      },
    });

    const parsed = JobResultSchema.safeParse(reply);
    if (!parsed.success) {
      throw new Ai3dError("BRIDGE_PROTOCOL_ERROR", "Bridge returned an unexpected batch reply", {
        issues: parsed.error.issues,
        reply,
      });
    }
    const jobResult = parsed.data;
    if (jobResult.fatal) {
      throw new Ai3dError("BLENDER_COMMAND_FAILED", `Blender job aborted: ${jobResult.fatal.message}`, {
        error: jobResult.fatal,
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
  }

  /** Ask the server to exit. Only meaningful for a daemon we own. */
  async shutdownServer(): Promise<void> {
    try {
      await this.#send({ type: "shutdown" });
    } catch (e) {
      log.debug("shutdown request failed (server may already be gone)", errorMessage(e));
    }
    await this.close();
  }

  async close(): Promise<void> {
    if (this.#socket && !this.#socket.destroyed) {
      this.#socket.end();
      this.#socket.destroy();
    }
    this.#socket = null;
  }
}
