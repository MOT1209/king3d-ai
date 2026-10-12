/**
 * Installing Blender for King3D.
 *
 * Blender is neither vendored in git nor bundled in the app: it is downloaded
 * once, from a URL and a SHA-256 *pinned in releases.json*, into King3D's own
 * directory. The download is streamed to disk while being hashed; nothing is
 * extracted unless the hash matches, and an install only counts once a marker
 * file is written, so an interrupted run can never be mistaken for a good one.
 *
 * The hashes are written by `npm run blender:pin` (scripts/pin-blender.mjs), which
 * reads the official .sha256 files. They are never typed by hand, and an install
 * with no pinned hash is refused rather than trusting whatever the network returns.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Ai3dError } from "../../core/errors.ts";
import {
  blenderExecutableName,
  findExecutableIn,
  INSTALL_MARKER,
  kingHome,
  managedBlenderDirName,
} from "../../core/home.ts";

export interface ReleaseFile {
  url: string;
  /** Lower-case hex SHA-256 of the archive, from the official .sha256 file. */
  sha256: string;
  /** Archive size in bytes, when known; checked after download. */
  size?: number;
}

export interface BlenderRelease {
  schema: 1;
  /** null until `npm run blender:pin` has been run. */
  version: string | null;
  /** Keyed by `${process.platform}-${process.arch}`, e.g. "win32-x64". */
  files: Record<string, ReleaseFile>;
}

export type InstallProgress =
  | { phase: "download"; received: number; total: number | null }
  | { phase: "verify" }
  | { phase: "extract" }
  | { phase: "done" };

export interface InstallOptions {
  release?: BlenderRelease;
  home?: string;
  /** Defaults to the running platform; injectable for tests. */
  platform?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (event: InstallProgress) => void;
}

export interface InstallResult {
  version: string;
  dir: string;
  executable: string;
  alreadyInstalled: boolean;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function currentPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function loadReleases(path = new URL("./releases.json", import.meta.url)): BlenderRelease {
  return JSON.parse(readFileSync(path, "utf8")) as BlenderRelease;
}

function fail(message: string, details: Record<string, unknown> = {}): Ai3dError {
  return new Ai3dError("BLENDER_INSTALL_FAILED", message, details);
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** Reject anything that is not clearly allowed before a byte is downloaded. */
function validate(release: BlenderRelease, key: string): { version: string; file: ReleaseFile } {
  if (!release.version) {
    throw fail("no Blender release is pinned yet; run `npm run blender:pin` on a machine that can reach blender.org");
  }
  const file = release.files[key];
  if (!file) {
    throw fail(
      `King3D cannot install Blender automatically on ${key}; install Blender 4.2+ yourself and set KING3D_BLENDER_PATH`,
      { platform: key },
    );
  }
  if (!SHA256.test(file.sha256 ?? "")) {
    throw fail("the pinned release has no valid SHA-256; refusing to download an unverifiable file", { platform: key });
  }
  let url: URL;
  try {
    url = new URL(file.url);
  } catch {
    throw fail(`the pinned URL is not valid: ${file.url}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw fail(`refusing a non-HTTPS download URL: ${url.protocol}//${url.hostname}`);
  }
  return { version: release.version, file };
}

function extractWithTar(archive: string, dest: string): Promise<void> {
  // GNU tar and bsdtar (Windows 10+) both detect gzip/xz compression and read zip (bsdtar).
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", archive, "-C", dest], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with ${code}: ${stderr.slice(0, 300).trim()}`)),
    );
  });
}

export async function installBlender(options: InstallOptions = {}): Promise<InstallResult> {
  const release = options.release ?? loadReleases();
  const platform = options.platform ?? currentPlatformKey();
  const home = options.home ?? kingHome();
  const fetchImpl = options.fetchImpl ?? fetch;
  const progress = options.onProgress ?? (() => undefined);

  const { version, file } = validate(release, platform);
  const exeName = blenderExecutableName(platform.split("-")[0]);
  const finalDir = join(home, managedBlenderDirName(version));

  if (existsSync(join(finalDir, INSTALL_MARKER))) {
    const executable = findExecutableIn(finalDir, exeName);
    if (executable) return { version, dir: finalDir, executable, alreadyInstalled: true };
  }

  await mkdir(join(home, "downloads"), { recursive: true });
  const archive = join(home, "downloads", `${randomBytes(4).toString("hex")}-${basename(new URL(file.url).pathname)}.part`);
  const staging = join(home, `.staging-${version}-${randomBytes(4).toString("hex")}`);

  try {
    // ---- download, hashing as it streams -------------------------------
    let response: Response;
    try {
      response = await fetchImpl(file.url, { redirect: "follow" });
    } catch (e) {
      throw fail(`could not reach ${new URL(file.url).hostname}`, { cause: e instanceof Error ? e.message : String(e) });
    }
    if (!response.ok || !response.body) throw fail(`download failed: HTTP ${response.status}`, { status: response.status });

    const total = Number(response.headers.get("content-length")) || file.size || null;
    const hash = createHash("sha256");
    let received = 0;
    let lastReport = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        received += chunk.length;
        if (received - lastReport >= 512 * 1024) {
          lastReport = received;
          progress({ phase: "download", received, total });
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), tap, createWriteStream(archive));
    progress({ phase: "download", received, total });

    // ---- verify BEFORE anything is extracted ---------------------------
    progress({ phase: "verify" });
    if (file.size !== undefined && received !== file.size) {
      throw fail(`size mismatch: expected ${file.size} bytes, got ${received}`);
    }
    const actual = hash.digest("hex");
    if (actual !== file.sha256) {
      throw fail("checksum mismatch: the download does not match the pinned SHA-256 and was discarded", {
        expected: file.sha256,
        actual,
      });
    }

    // ---- extract into staging, then move into place --------------------
    progress({ phase: "extract" });
    await mkdir(staging, { recursive: true });
    try {
      await extractWithTar(archive, staging);
    } catch (e) {
      throw fail(`could not extract the archive: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!findExecutableIn(staging, exeName)) throw fail(`the archive did not contain ${exeName}`);
    await writeFile(join(staging, INSTALL_MARKER), JSON.stringify({ version, sha256: file.sha256, installed_at: new Date().toISOString() }));

    await rm(finalDir, { recursive: true, force: true }); // a previous partial attempt, never a marked install
    await rename(staging, finalDir);

    const executable = findExecutableIn(finalDir, exeName);
    if (!executable) throw fail(`${exeName} disappeared after install`);
    progress({ phase: "done" });
    return { version, dir: finalDir, executable, alreadyInstalled: false };
  } catch (e) {
    throw e instanceof Ai3dError ? e : fail(e instanceof Error ? e.message : String(e));
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

/** For `king3d blender status`: what is installed, without touching the network. */
export async function installedVersions(home: string = kingHome()): Promise<string[]> {
  if (!existsSync(home)) return [];
  const out: string[] = [];
  for (const name of await readdir(home)) {
    if (!name.startsWith("blender-")) continue;
    if (existsSync(join(home, name, INSTALL_MARKER)) && (await stat(join(home, name))).isDirectory()) {
      out.push(name.slice("blender-".length));
    }
  }
  return out;
}
