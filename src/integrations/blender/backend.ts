/**
 * Backend-agnostic Blender access.
 *
 * Two implementations share this interface and, crucially, the same Python code
 * under blender/lib: HeadlessBackend spawns `blender -b`, SocketBackend talks to
 * our addon inside a running Blender. Callers never branch on which is in use.
 */
import { randomUUID } from "node:crypto";
import { Ai3dError } from "../../core/errors.ts";
import {
  COMMANDS,
  type BridgeRequest,
  type BridgeResponse,
  type CommandName,
  type CommandParams,
  type CommandResult,
  type JobTimings,
} from "./protocol.ts";

export interface JobContext {
  /** .blend to open before the batch runs. Absent means a factory-fresh scene. */
  loadBlend?: string;
  /** .blend to write after the batch succeeds; this is how headless keeps state. */
  saveBlend?: string;
  /** Working directory relative paths in params resolve against. */
  cwd?: string;
}

export interface BatchOutcome {
  responses: BridgeResponse[];
  ok: boolean;
  blenderVersion?: string;
  pythonVersion?: string;
  savedBlend?: string | null;
  /** Wall time for the whole call, including process startup for headless. */
  wallMs?: number;
  /** Wall time not attributable to the batch itself - i.e. Blender starting up. */
  overheadMs?: number;
  timings?: JobTimings;
}

export interface BlenderBackend {
  readonly kind: "headless" | "socket";
  /** Run commands in order. A failing command aborts the rest of the batch. */
  execute(requests: BridgeRequest[], context?: JobContext): Promise<BatchOutcome>;
  close(): Promise<void>;
}

/** Validate params against the command schema and stamp a request id. */
export function request<K extends CommandName>(cmd: K, params: CommandParams<K>): BridgeRequest {
  const schema = COMMANDS[cmd].params;
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new Ai3dError("TOOL_INPUT_INVALID", `Invalid params for "${cmd}": ${parsed.error.message}`, {
      cmd,
      issues: parsed.error.issues,
    });
  }
  return { id: `${cmd}-${randomUUID().slice(0, 8)}`, cmd, params: parsed.data };
}

/** Validate a response payload against the command result schema. */
export function parseResult<K extends CommandName>(cmd: K, response: BridgeResponse): CommandResult<K> {
  if (!response.ok) {
    throw new Ai3dError(
      "BLENDER_COMMAND_FAILED",
      `Blender command "${cmd}" failed: ${response.error?.message ?? "unknown error"}`,
      { cmd, error: response.error, logs: response.logs },
    );
  }
  const parsed = COMMANDS[cmd].result.safeParse(response.result);
  if (!parsed.success) {
    throw new Ai3dError("TOOL_OUTPUT_INVALID", `Blender returned an unexpected shape for "${cmd}"`, {
      cmd,
      issues: parsed.error.issues,
      received: response.result,
    });
  }
  return parsed.data as CommandResult<K>;
}

/**
 * Convenience wrapper: run a single command and get its typed result.
 * Prefer batching in hot paths - a headless invocation costs a Blender startup.
 */
export async function runOne<K extends CommandName>(
  backend: BlenderBackend,
  cmd: K,
  params: CommandParams<K>,
  context?: JobContext,
): Promise<CommandResult<K>> {
  const req = request(cmd, params);
  const outcome = await backend.execute([req], context);
  const response = outcome.responses[0];
  if (!response) {
    throw new Ai3dError("BRIDGE_PROTOCOL_ERROR", `No response returned for "${cmd}"`, { cmd });
  }
  return parseResult(cmd, response);
}

/** Accumulates a validated batch, then reads results back by position. */
export class Batch {
  readonly requests: BridgeRequest[] = [];
  readonly #commands: CommandName[] = [];

  add<K extends CommandName>(cmd: K, params: CommandParams<K>): this {
    this.requests.push(request(cmd, params));
    this.#commands.push(cmd);
    return this;
  }

  get size(): number {
    return this.requests.length;
  }

  async run(backend: BlenderBackend, context?: JobContext): Promise<BatchOutcome> {
    return backend.execute(this.requests, context);
  }

  /** Typed accessor for one slot of a completed batch. */
  resultAt<K extends CommandName>(outcome: BatchOutcome, index: number, cmd: K): CommandResult<K> {
    const expected = this.#commands[index];
    if (expected !== cmd) {
      throw new Ai3dError("BRIDGE_PROTOCOL_ERROR", `Batch slot ${index} is "${expected}", not "${cmd}"`, {
        index,
        expected,
        cmd,
      });
    }
    const response = outcome.responses[index];
    if (!response) {
      throw new Ai3dError("BRIDGE_PROTOCOL_ERROR", `Batch slot ${index} has no response`, { index, cmd });
    }
    return parseResult(cmd, response);
  }
}
