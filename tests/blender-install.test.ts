import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSTALL_MARKER, managedBlenderPath } from "../src/core/home.ts";
import { isAi3dError } from "../src/core/errors.ts";
import { installBlender, installedVersions, type BlenderRelease, type InstallProgress } from "../src/integrations/blender/install.ts";

let work: string;
let server: Server | undefined;
let hits = 0;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "k3d-install-"));
  hits = 0;
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await rm(work, { recursive: true, force: true });
});

/** A tiny stand-in for a Blender archive: <root>/blender-9.9.9-linux-x64/blender */
function makeArchive(name = "blender-9.9.9-linux-x64.tar.gz", withExecutable = true): { path: string; sha256: string; size: number } {
  const src = join(work, "src");
  const root = join(src, "blender-9.9.9-linux-x64");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, withExecutable ? "blender" : "readme.txt"), "#!/bin/sh\necho fake blender\n");
  const path = join(work, name);
  execFileSync("tar", ["-czf", path, "-C", src, "blender-9.9.9-linux-x64"]);
  const bytes = readFileSync(path);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

async function serve(handler: (url: string) => { status?: number; body: Buffer | string }): Promise<string> {
  server = createServer((req, res) => {
    hits++;
    const out = handler(req.url ?? "");
    res.writeHead(out.status ?? 200, { "content-type": "application/octet-stream" });
    res.end(out.body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function releaseFor(url: string, archive: { sha256: string; size?: number }, over: Partial<BlenderRelease> = {}): BlenderRelease {
  return {
    schema: 1,
    version: "9.9.9",
    files: { "linux-x64": { url: `${url}/blender-9.9.9-linux-x64.tar.gz`, sha256: archive.sha256, ...(archive.size ? { size: archive.size } : {}) } },
    ...over,
  };
}

const home = () => join(work, "home");
const code = (e: unknown) => (isAi3dError(e) ? e.code : "other");

describe("installBlender", () => {
  it("downloads, verifies, extracts and marks the install complete", async () => {
    const archive = makeArchive();
    const url = await serve(() => ({ body: readFileSync(archive.path) }));
    const events: InstallProgress["phase"][] = [];

    const result = await installBlender({
      release: releaseFor(url, archive),
      home: home(),
      platform: "linux-x64",
      onProgress: (e) => events.push(e.phase),
    });

    expect(result.alreadyInstalled).toBe(false);
    expect(result.version).toBe("9.9.9");
    expect(result.executable.endsWith(join("blender-9.9.9-linux-x64", "blender"))).toBe(true);
    expect(existsSync(result.executable)).toBe(true);
    expect(existsSync(join(result.dir, INSTALL_MARKER))).toBe(true);
    expect(events).toEqual(expect.arrayContaining(["download", "verify", "extract", "done"]));
    // The archive and the staging directory are gone; only the finished install remains.
    expect(readdirSync(home()).filter((n) => n.startsWith(".staging"))).toEqual([]);
    expect(readdirSync(join(home(), "downloads"))).toEqual([]);
  });

  it("is idempotent: a second install does not touch the network", async () => {
    const archive = makeArchive();
    const url = await serve(() => ({ body: readFileSync(archive.path) }));
    const release = releaseFor(url, archive);
    await installBlender({ release, home: home(), platform: "linux-x64" });
    expect(hits).toBe(1);
    const again = await installBlender({ release, home: home(), platform: "linux-x64" });
    expect(again.alreadyInstalled).toBe(true);
    expect(hits).toBe(1);
  });

  it("discards a download whose checksum does not match, and installs nothing", async () => {
    const archive = makeArchive();
    const url = await serve(() => ({ body: readFileSync(archive.path) }));
    const wrong = { sha256: "0".repeat(64) };
    const err = await installBlender({ release: releaseFor(url, wrong), home: home(), platform: "linux-x64" }).catch((e) => e);

    expect(code(err)).toBe("BLENDER_INSTALL_FAILED");
    expect(err.message).toContain("checksum mismatch");
    expect(readdirSync(home()).filter((n) => n.startsWith("blender-"))).toEqual([]);
    expect(readdirSync(join(home(), "downloads"))).toEqual([]);
    expect(managedBlenderPath(home())).toBeNull();
  });

  it("rejects a size that differs from the pinned size", async () => {
    const archive = makeArchive();
    const url = await serve(() => ({ body: readFileSync(archive.path) }));
    const err = await installBlender({
      release: releaseFor(url, { sha256: archive.sha256, size: archive.size + 1 }),
      home: home(),
      platform: "linux-x64",
    }).catch((e) => e);
    expect(err.message).toContain("size mismatch");
  });

  it("refuses to run with nothing pinned, without any network call", async () => {
    const url = await serve(() => ({ body: "x" }));
    const err = await installBlender({ release: { schema: 1, version: null, files: {} }, home: home(), platform: "linux-x64" }).catch((e) => e);
    expect(err.message).toContain("npm run blender:pin");
    expect(hits).toBe(0);
    void url;
  });

  it("refuses a pinned file with no valid SHA-256", async () => {
    const url = await serve(() => ({ body: "x" }));
    for (const sha256 of ["", "abc", "Z".repeat(64), "A".repeat(64)]) {
      const err = await installBlender({
        release: { schema: 1, version: "9.9.9", files: { "linux-x64": { url: `${url}/a.tar.gz`, sha256 } } },
        home: home(),
        platform: "linux-x64",
      }).catch((e) => e);
      expect(err.message).toContain("no valid SHA-256");
    }
    expect(hits).toBe(0);
  });

  it("tells the user to install by hand on a platform it cannot handle", async () => {
    const archive = makeArchive();
    const url = await serve(() => ({ body: readFileSync(archive.path) }));
    const err = await installBlender({ release: releaseFor(url, archive), home: home(), platform: "darwin-arm64" }).catch((e) => e);
    expect(err.message).toContain("KING3D_BLENDER_PATH");
    expect(hits).toBe(0);
  });

  it("refuses a plain-HTTP URL that is not loopback", async () => {
    const err = await installBlender({
      release: { schema: 1, version: "9.9.9", files: { "linux-x64": { url: "http://example.com/blender.tar.xz", sha256: "a".repeat(64) } } },
      home: home(),
      platform: "linux-x64",
    }).catch((e) => e);
    expect(err.message).toContain("non-HTTPS");
  });

  it("reports an HTTP error and leaves nothing behind", async () => {
    const url = await serve(() => ({ status: 404, body: "nope" }));
    const err = await installBlender({ release: releaseFor(url, { sha256: "a".repeat(64) }), home: home(), platform: "linux-x64" }).catch((e) => e);
    expect(err.message).toContain("HTTP 404");
    expect(readdirSync(join(home(), "downloads"))).toEqual([]);
  });

  it("fails cleanly when the verified archive cannot be extracted", async () => {
    const garbage = Buffer.from("this is not a tar archive");
    const url = await serve(() => ({ body: garbage }));
    const err = await installBlender({
      release: releaseFor(url, { sha256: createHash("sha256").update(garbage).digest("hex") }),
      home: home(),
      platform: "linux-x64",
    }).catch((e) => e);
    expect(err.message).toContain("could not extract");
    expect(readdirSync(home()).filter((n) => n.startsWith("blender-") || n.startsWith(".staging"))).toEqual([]);
  });

  it("fails when the archive has no Blender executable in it", async () => {
    const archive = makeArchive("no-exe.tar.gz", false);
    const url = await serve(() => ({ body: readFileSync(archive.path) }));
    const err = await installBlender({ release: releaseFor(url, archive), home: home(), platform: "linux-x64" }).catch((e) => e);
    expect(err.message).toContain("did not contain");
    expect(managedBlenderPath(home())).toBeNull();
  });
});

describe("managedBlenderPath", () => {
  it("ignores a directory without the completion marker (an interrupted install)", () => {
    mkdirSync(join(home(), "blender-4.2.1"), { recursive: true });
    writeFileSync(join(home(), "blender-4.2.1", "blender"), "x");
    expect(managedBlenderPath(home())).toBeNull();
  });

  it("returns the newest complete version", () => {
    for (const version of ["4.2.9", "4.2.10", "4.1.0"]) {
      const dir = join(home(), `blender-${version}`, "inner");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "blender"), "x");
      writeFileSync(join(home(), `blender-${version}`, INSTALL_MARKER), "{}");
    }
    // 4.2.10 > 4.2.9 numerically (a string sort would get this wrong).
    expect(managedBlenderPath(home())).toContain("blender-4.2.10");
  });

  it("returns null when King3D has installed nothing", () => {
    expect(managedBlenderPath(join(work, "empty"))).toBeNull();
  });
});

describe("installedVersions", () => {
  it("lists only complete installs", async () => {
    mkdirSync(join(home(), "blender-1.0.0"), { recursive: true });
    writeFileSync(join(home(), "blender-1.0.0", INSTALL_MARKER), "{}");
    mkdirSync(join(home(), "blender-2.0.0"), { recursive: true });
    expect(await installedVersions(home())).toEqual(["1.0.0"]);
  });
});
