/**
 * Length-prefixed JSON framing for the live socket bridge.
 *
 * blender-mcp accumulates bytes and retries JSON.parse until it succeeds, which
 * mis-splits payloads that contain valid JSON prefixes and silently truncates on
 * large results (screenshots, mesh dumps). A 4-byte big-endian length header makes
 * message boundaries explicit and O(1) to find.
 */
import { Ai3dError } from "../../core/errors.ts";

export const HEADER_BYTES = 4;
/** Refuse absurd frames rather than allocating on a corrupt header. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new Ai3dError("BRIDGE_PROTOCOL_ERROR", `Outgoing frame too large: ${body.length} bytes`, {
      bytes: body.length,
    });
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder: feed arbitrary chunks, get back whole messages. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const out: unknown[] = [];

    for (;;) {
      if (this.#buffer.length < HEADER_BYTES) break;
      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new Ai3dError("BRIDGE_PROTOCOL_ERROR", `Incoming frame claims ${length} bytes; refusing`, {
          bytes: length,
        });
      }
      if (this.#buffer.length < HEADER_BYTES + length) break;

      const body = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      try {
        out.push(JSON.parse(body.toString("utf8")));
      } catch (e) {
        throw new Ai3dError("BRIDGE_PROTOCOL_ERROR", `Frame body is not valid JSON: ${String(e)}`, {
          preview: body.subarray(0, 200).toString("utf8"),
        });
      }
    }
    return out;
  }

  /** Bytes held back waiting for more input; non-zero at close means a truncated frame. */
  get pending(): number {
    return this.#buffer.length;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }
}
