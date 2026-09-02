import { describe, expect, it } from "vitest";
import { Ai3dError } from "../src/core/errors.ts";
import { Batch, parseResult, request } from "../src/integrations/blender/backend.ts";
import { COMMAND_NAMES, COMMANDS, isCommandName } from "../src/integrations/blender/protocol.ts";
import type { BridgeResponse } from "../src/integrations/blender/protocol.ts";

function response(overrides: Partial<BridgeResponse> = {}): BridgeResponse {
  return { id: "x", ok: true, logs: [], duration_ms: 1, ...overrides };
}

describe("command registry", () => {
  it("declares a params and result schema for every command", () => {
    expect(COMMAND_NAMES.length).toBeGreaterThan(20);
    for (const name of COMMAND_NAMES) {
      const spec = COMMANDS[name];
      expect(spec.params, `${name} params`).toBeDefined();
      expect(spec.result, `${name} result`).toBeDefined();
    }
  });

  it("recognises only registered names", () => {
    expect(isCommandName("scene.info")).toBe(true);
    expect(isCommandName("scene.explode")).toBe(false);
  });
});

describe("request validation", () => {
  it("fills declared defaults so Python never guesses", () => {
    const req = request("object.create", { kind: "cube", name: "box" });
    expect(req.params).toMatchObject({
      kind: "cube",
      name: "box",
      location: [0, 0, 0],
      rotation_euler: [0, 0, 0],
      scale: [1, 1, 1],
      shade_smooth: false,
    });
  });

  it("gives each request a traceable id", () => {
    const req = request("ping", {});
    expect(req.id).toMatch(/^ping-[0-9a-f]{8}$/);
  });

  it("rejects an unknown primitive before it reaches Blender", () => {
    // @ts-expect-error - deliberately invalid to prove the guard fires
    expect(() => request("object.create", { kind: "dodecahedron", name: "d" })).toThrow(Ai3dError);
  });

  it("rejects a malformed vector", () => {
    // @ts-expect-error - two components instead of three
    expect(() => request("camera.set", { location: [1, 2] })).toThrow(/Invalid params/);
  });

  it("rejects an out-of-range material value", () => {
    expect(() =>
      request("material.assign", {
        object: "cube",
        material: { name: "m", metallic: 5 },
      }),
    ).toThrow(Ai3dError);
  });
});

describe("result validation", () => {
  it("returns the parsed result on success", () => {
    const parsed = parseResult(
      "ping",
      response({ result: { pong: true, blender_version: "5.2.0", python_version: "3.13.0", binary: "b" } }),
    );
    expect(parsed.blender_version).toBe("5.2.0");
  });

  it("turns a failed response into a typed error carrying the logs", () => {
    try {
      parseResult("scene.info", response({ ok: false, error: { code: "BOOM", message: "it broke" }, logs: ["a"] }));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Ai3dError);
      expect((e as Ai3dError).code).toBe("BLENDER_COMMAND_FAILED");
      expect((e as Ai3dError).details["logs"]).toEqual(["a"]);
    }
  });

  it("rejects a result whose shape drifted from the schema", () => {
    expect(() => parseResult("inspect.mesh", response({ result: { name: "cube" } }))).toThrow(/unexpected shape/);
  });
});

describe("batch", () => {
  it("reads results back by position with the expected type", () => {
    const batch = new Batch().add("scene.reset", { keep_camera: false, keep_lights: false }).add("ping", {});
    expect(batch.size).toBe(2);

    const outcome = {
      ok: true,
      responses: [
        response({ result: { ok: true } }),
        response({ result: { pong: true, blender_version: "5.2.0", python_version: "3.13.0", binary: "b" } }),
      ],
    };
    expect(batch.resultAt(outcome, 1, "ping").pong).toBe(true);
  });

  it("refuses to read a slot as the wrong command", () => {
    const batch = new Batch().add("ping", {});
    const outcome = { ok: true, responses: [response({ result: { ok: true } })] };
    expect(() => batch.resultAt(outcome, 0, "scene.reset")).toThrow(/is "ping", not "scene.reset"/);
  });

  it("reports a missing response rather than returning undefined", () => {
    const batch = new Batch().add("ping", {});
    expect(() => batch.resultAt({ ok: false, responses: [] }, 0, "ping")).toThrow(/no response/);
  });
});
