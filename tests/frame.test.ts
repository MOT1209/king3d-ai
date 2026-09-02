import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, HEADER_BYTES, MAX_FRAME_BYTES } from "../src/integrations/blender/frame.ts";
import { Ai3dError } from "../src/core/errors.ts";

describe("frame codec", () => {
  it("round-trips a message", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame({ hello: "world", n: 42 }));
    expect(frames).toEqual([{ hello: "world", n: 42 }]);
    expect(decoder.pending).toBe(0);
  });

  it("writes a 4-byte big-endian length header", () => {
    const buffer = encodeFrame({ a: 1 });
    const body = JSON.stringify({ a: 1 });
    expect(buffer.readUInt32BE(0)).toBe(Buffer.byteLength(body));
    expect(buffer.length).toBe(HEADER_BYTES + Buffer.byteLength(body));
  });

  it("reassembles a message split across chunks", () => {
    const buffer = encodeFrame({ big: "x".repeat(500) });
    const decoder = new FrameDecoder();
    // Deliver one byte at a time: nothing should surface until the last byte.
    for (let i = 0; i < buffer.length - 1; i++) {
      expect(decoder.push(buffer.subarray(i, i + 1))).toEqual([]);
    }
    const frames = decoder.push(buffer.subarray(buffer.length - 1));
    expect(frames).toHaveLength(1);
    expect((frames[0] as { big: string }).big).toHaveLength(500);
  });

  it("returns several messages arriving in one chunk", () => {
    const chunk = Buffer.concat([encodeFrame({ i: 1 }), encodeFrame({ i: 2 }), encodeFrame({ i: 3 })]);
    expect(new FrameDecoder().push(chunk)).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
  });

  it("keeps a partial trailing message buffered", () => {
    const complete = encodeFrame({ i: 1 });
    const partial = encodeFrame({ i: 2 }).subarray(0, 5);
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.concat([complete, partial]))).toEqual([{ i: 1 }]);
    expect(decoder.pending).toBe(partial.length);
  });

  it("does not mis-split a payload that itself contains JSON", () => {
    // The failure mode of parse-until-it-works framing: an embedded JSON string
    // gives a valid parse at the wrong boundary.
    const message = { code: '{"trap": true}', tail: "after" };
    expect(new FrameDecoder().push(encodeFrame(message))).toEqual([message]);
  });

  it("refuses an oversized declared length instead of allocating", () => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(header)).toThrow(Ai3dError);
  });

  it("reports a body that is not JSON", () => {
    const body = Buffer.from("not json at all", "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);
    expect(() => new FrameDecoder().push(Buffer.concat([header, body]))).toThrow(/not valid JSON/);
  });

  it("handles multi-byte UTF-8 without truncation", () => {
    const message = { arabic: "مرحبا بالعالم", emoji: "🧊", mixed: "café" };
    const buffer = encodeFrame(message);
    const decoder = new FrameDecoder();
    // Split mid-character to prove length framing counts bytes, not characters.
    const mid = Math.floor(buffer.length / 2);
    expect(decoder.push(buffer.subarray(0, mid))).toEqual([]);
    expect(decoder.push(buffer.subarray(mid))).toEqual([message]);
  });

  it("resets cleanly", () => {
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame({ i: 1 }).subarray(0, 3));
    expect(decoder.pending).toBe(3);
    decoder.reset();
    expect(decoder.pending).toBe(0);
  });
});
