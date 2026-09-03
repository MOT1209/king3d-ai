/**
 * Backend selection.
 *
 * Default is the daemon: Blender costs 30-90s to start and milliseconds to
 * command, so the pipeline keeps one alive rather than paying startup per batch.
 * `KING3D_BACKEND=headless` forces the one-shot path for CI or debugging.
 */
import { loadConfig, type Ai3dConfig } from "../../core/config.ts";
import { createLogger } from "../../core/logger.ts";
import type { BlenderBackend } from "./backend.ts";
import { ensureDaemon, type StartOptions } from "./daemon.ts";
import { HeadlessBackend } from "./headless.ts";

const log = createLogger("blender");

export interface AcquiredBackend {
  backend: BlenderBackend;
  /** True when this call had to start Blender, i.e. the slow path was taken. */
  coldStart: boolean;
}

export async function acquireBackend(
  config: Ai3dConfig = loadConfig(),
  options: StartOptions = {},
): Promise<AcquiredBackend> {
  if (config.backend === "headless") {
    log.debug("using one-shot headless backend");
    return { backend: new HeadlessBackend({}, config), coldStart: false };
  }
  const { backend, started } = await ensureDaemon(config, options);
  return { backend, coldStart: started };
}

export { Batch, parseResult, request, runOne } from "./backend.ts";
export type { BatchOutcome, BlenderBackend, JobContext } from "./backend.ts";
export { daemonStatus, ensureDaemon, startDaemon, stopDaemon, type DaemonState } from "./daemon.ts";
export { encodeFrame, FrameDecoder } from "./frame.ts";
export { HeadlessBackend } from "./headless.ts";
export * from "./protocol.ts";
export { isBridgeReachable, SocketBackend } from "./socket.ts";
