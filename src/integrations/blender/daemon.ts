/**
 * Lifecycle for the persistent headless Blender.
 *
 * Starting Blender is the single most expensive thing the pipeline does, so the
 * daemon outlives individual CLI invocations: state lives in a small file under
 * runs/, and any later command reuses a daemon that is still answering.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, paths, requireBlenderExecutable, type Ai3dConfig } from "../../core/config.ts";
import { Ai3dError, errorMessage } from "../../core/errors.ts";
import { createLogger } from "../../core/logger.ts";
import { isBridgeReachable, SocketBackend } from "./socket.ts";

const log = createLogger("blender:daemon");

const STATE_FILE = join(paths.runs, ".daemon.json");
const LOG_FILE = join(paths.runs, "daemon.log");

export interface DaemonState {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  blenderPath: string;
}

async function readState(): Promise<DaemonState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

async function writeState(state: DaemonState): Promise<void> {
  await mkdir(paths.runs, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

async function clearState(): Promise<void> {
  await rm(STATE_FILE, { force: true }).catch(() => undefined);
}

export interface StartOptions {
  /** How long to wait for Blender to finish starting. Startup is 30-90s here. */
  readyTimeoutMs?: number;
  blenderPath?: string;
  onProgress?: (message: string) => void;
}

/**
 * Start a daemon and wait until it is answering.
 *
 * Readiness is confirmed by an actual connection, not just the stdout marker,
 * so a daemon reported as ready really is one.
 */
export async function startDaemon(config: Ai3dConfig = loadConfig(), options: StartOptions = {}): Promise<DaemonState> {
  const blenderPath = options.blenderPath ?? requireBlenderExecutable();
  const readyTimeoutMs = options.readyTimeoutMs ?? 300_000;
  const { bridgeHost: host, bridgePort: port } = config;

  if (await isBridgeReachable(host, port)) {
    throw new Ai3dError("CONFIG_INVALID", `Port ${port} is already in use on ${host}`, { host, port });
  }

  const args = [
    "--background",
    "--factory-startup",
    "-noaudio",
    "--python",
    join(paths.blenderDir, "daemon.py"),
    "--",
    "--host",
    host,
    "--port",
    String(port),
    "--cwd",
    paths.root,
  ];
  if (config.allowPythonExec) args.push("--allow-python-exec");

  log.debug("starting daemon", { blenderPath, host, port });
  await mkdir(paths.runs, { recursive: true });

  // The daemon must outlive this CLI invocation, so it gets its own process group
  // and writes straight to a log file by descriptor. Piping to JS streams instead
  // would keep our event loop alive and tie the daemon's lifetime to ours.
  const logFd = openSync(LOG_FILE, "a");
  let child;
  try {
    child = spawn(blenderPath, args, {
      windowsHide: true,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }

  let exited: { code: number | null } | null = null;
  child.once("exit", (code) => {
    exited = { code };
  });

  const deadline = Date.now() + readyTimeoutMs;
  let lastReport = 0;
  while (Date.now() < deadline) {
    // Read through a local: the assignment happens in a callback, which the
    // control-flow analysis cannot see, so `exited` narrows to never inline.
    const exitInfo = exited as { code: number | null } | null;
    if (exitInfo) {
      throw new Ai3dError(
        "BLENDER_LAUNCH_FAILED",
        `Blender daemon exited during startup (code ${exitInfo.code}). Log tail: ${tailLog()}`,
        { exitCode: exitInfo.code, logFile: LOG_FILE },
      );
    }
    if (await isBridgeReachable(host, port, 1000)) {
      const state: DaemonState = {
        pid: child.pid ?? -1,
        host,
        port,
        startedAt: new Date().toISOString(),
        blenderPath,
      };
      await writeState(state);
      // Detach for real: the daemon is meant to serve later CLI runs too.
      child.unref();
      log.info(`daemon ready on ${host}:${port} (pid ${state.pid})`);
      return state;
    }
    const elapsed = Math.round((Date.now() - (deadline - readyTimeoutMs)) / 1000);
    if (options.onProgress && elapsed >= lastReport + 5) {
      lastReport = elapsed;
      options.onProgress(`waiting for Blender to start (${elapsed}s elapsed)`);
    }
    await sleep(500);
  }

  child.kill("SIGKILL");
  throw new Ai3dError("BRIDGE_TIMEOUT", `Blender daemon did not become ready within ${readyTimeoutMs}ms`, {
    logFile: LOG_FILE,
    logTail: tailLog(),
  });
}

/** Last few hundred bytes of the daemon log, for error messages. */
function tailLog(bytes = 600): string {
  try {
    const text = readFileSync(LOG_FILE, "utf8");
    return text.length <= bytes ? text.trim() : "..." + text.slice(-bytes).trim();
  } catch {
    return "(no daemon log)";
  }
}

/** Return a connected backend, starting a daemon only if one is not already up. */
export async function ensureDaemon(
  config: Ai3dConfig = loadConfig(),
  options: StartOptions = {},
): Promise<{ backend: SocketBackend; state: DaemonState; started: boolean }> {
  const { bridgeHost: host, bridgePort: port } = config;

  if (await isBridgeReachable(host, port)) {
    const existing = await readState();
    const state: DaemonState = existing ?? {
      pid: -1,
      host,
      port,
      startedAt: "unknown",
      blenderPath: "(external)",
    };
    return {
      backend: new SocketBackend({ host, port, allowPythonExec: config.allowPythonExec }),
      state,
      started: false,
    };
  }

  const state = await startDaemon(config, options);
  return {
    backend: new SocketBackend({ host, port, allowPythonExec: config.allowPythonExec }),
    state,
    started: true,
  };
}

export async function stopDaemon(config: Ai3dConfig = loadConfig()): Promise<boolean> {
  const { bridgeHost: host, bridgePort: port } = config;
  if (!(await isBridgeReachable(host, port))) {
    await clearState();
    return false;
  }
  const backend = new SocketBackend({ host, port });
  try {
    await backend.shutdownServer();
  } catch (e) {
    log.warn("graceful shutdown failed", errorMessage(e));
  }
  const state = await readState();
  await clearState();
  // Give the process a moment to release the port before reporting success.
  for (let i = 0; i < 20; i++) {
    if (!(await isBridgeReachable(host, port, 500))) return true;
    await sleep(250);
  }
  if (state?.pid && state.pid > 0) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return true;
}

export async function daemonStatus(config: Ai3dConfig = loadConfig()): Promise<{
  running: boolean;
  state: DaemonState | null;
}> {
  const running = await isBridgeReachable(config.bridgeHost, config.bridgePort);
  return { running, state: running ? await readState() : null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
