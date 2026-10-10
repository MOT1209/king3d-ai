/** Error taxonomy. Every failure carries a stable code so callers can branch on it. */
export type Ai3dErrorCode =
  | "BLENDER_NOT_FOUND"
  | "BLENDER_LAUNCH_FAILED"
  | "BLENDER_COMMAND_FAILED"
  | "BRIDGE_PROTOCOL_ERROR"
  | "BRIDGE_UNAVAILABLE"
  | "BRIDGE_TIMEOUT"
  | "TOOL_NOT_FOUND"
  | "TOOL_INPUT_INVALID"
  | "TOOL_OUTPUT_INVALID"
  | "TOOL_DENIED"
  | "SPEC_INVALID"
  | "GATE_FAILED"
  | "NEEDS_MODEL_INPUT"
  | "RUN_NOT_FOUND"
  | "RUN_STATE_INVALID"
  | "CONFIG_INVALID"
  | "TRELLIS_UNAVAILABLE"
  | "TRELLIS_GENERATE_FAILED";

export class Ai3dError extends Error {
  readonly code: Ai3dErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: Ai3dErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "Ai3dError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { name: string; code: Ai3dErrorCode; message: string; details: Record<string, unknown> } {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export function isAi3dError(e: unknown): e is Ai3dError {
  return e instanceof Ai3dError;
}

/** Narrow an unknown catch value to a readable message without losing the original. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
