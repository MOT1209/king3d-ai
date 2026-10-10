import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.ts";
import { isAi3dError } from "../src/core/errors.ts";
import {
  acquireTrellis,
  HttpTrellisProvider,
  MockTrellisProvider,
} from "../src/integrations/trellis/client.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "trellis-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MockTrellisProvider", () => {
  it("copies the fixture bytes to the output path", async () => {
    const fixture = join(dir, "fixture.glb");
    const bytes = Buffer.from("glTF-fake-bytes");
    await writeFile(fixture, bytes);

    const provider = new MockTrellisProvider(fixture);
    expect(provider.kind).toBe("mock");
    expect(await provider.health()).toBe(true);

    const out = join(dir, "base.glb");
    const result = await provider.generate({ prompt: "a mug" }, out);

    expect(result.glbPath).toBe(out);
    expect(await readFile(out)).toEqual(bytes);
    expect(result.meta).toMatchObject({ source: "mock" });
  });

  it("reports unhealthy and fails cleanly when the fixture is missing", async () => {
    const provider = new MockTrellisProvider(join(dir, "nope.glb"));
    expect(await provider.health()).toBe(false);
    await expect(provider.generate({ prompt: "x" }, join(dir, "out.glb"))).rejects.toSatisfy(
      (e: unknown) => isAi3dError(e) && e.code === "TRELLIS_UNAVAILABLE",
    );
  });
});

describe("HttpTrellisProvider", () => {
  it("rejects a request with neither image nor prompt (before any network call)", async () => {
    const provider = new HttpTrellisProvider("http://127.0.0.1:1", 1000);
    await expect(provider.generate({}, join(dir, "out.glb"))).rejects.toSatisfy(
      (e: unknown) => isAi3dError(e) && e.code === "TRELLIS_GENERATE_FAILED",
    );
  });

  it("surfaces an unreachable service as TRELLIS_UNAVAILABLE", async () => {
    // Port 1 is never listening; the fetch fails fast.
    const provider = new HttpTrellisProvider("http://127.0.0.1:1", 1000);
    await expect(provider.generate({ prompt: "x" }, join(dir, "out.glb"))).rejects.toSatisfy(
      (e: unknown) => isAi3dError(e) && e.code === "TRELLIS_UNAVAILABLE",
    );
  });
});

describe("acquireTrellis", () => {
  it("returns the mock provider when configured for mock mode", () => {
    const config = loadConfig({ trellisMode: "mock", trellisMockGlb: join(dir, "f.glb") });
    expect(acquireTrellis(config).kind).toBe("mock");
  });

  it("returns the http provider in http mode", () => {
    const config = loadConfig({ trellisMode: "http", trellisUrl: "http://example.invalid" });
    expect(acquireTrellis(config).kind).toBe("http");
  });
});
