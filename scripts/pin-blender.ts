/**
 * Pin a Blender release: read the official SHA-256 file from blender.org and write
 * src/integrations/blender/releases.json.
 *
 *   node scripts/pin-blender.ts                  newest 4.2.x that has both archives
 *   node scripts/pin-blender.ts --version 4.2.3  a specific release
 *   node scripts/pin-blender.ts --series 4.2 --dry-run
 *
 * Run this on a machine that can reach download.blender.org (or in CI). Hashes are only
 * ever taken from Blender's own checksum file - never typed by hand - and the script
 * refuses to write anything it could not read a hash for.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BlenderRelease } from "../src/integrations/blender/install.ts";

const BASE = "https://download.blender.org/release";
const OUT = fileURLToPath(new URL("../src/integrations/blender/releases.json", import.meta.url));

/** What King3D can install by itself. macOS ships a .dmg and is left to the user. */
export const TARGETS: Record<string, (version: string) => string> = {
  "win32-x64": (v) => `blender-${v}-windows-x64.zip`,
  "linux-x64": (v) => `blender-${v}-linux-x64.tar.xz`,
};

const compare = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/** Versions in a directory listing that offer every archive King3D needs, newest last. */
export function versionsInListing(html: string, series: string): string[] {
  const escaped = series.replace(/\./g, "\\.");
  const found = new Set<string>();
  for (const m of html.matchAll(new RegExp(`blender-(${escaped}\\.\\d+)-`, "g"))) found.add(m[1]!);
  return [...found]
    .filter((v) => Object.values(TARGETS).every((name) => html.includes(name(v))))
    .sort(compare);
}

/** Parse `sha256sum`-style text: "<64 hex>  <filename>" (a leading * on the name is allowed). */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

export function buildRelease(
  version: string,
  series: string,
  checksums: Map<string, string>,
  sizes: Record<string, number | undefined> = {},
): BlenderRelease {
  const files: BlenderRelease["files"] = {};
  for (const [platform, nameFor] of Object.entries(TARGETS)) {
    const name = nameFor(version);
    const sha256 = checksums.get(name);
    if (!sha256) throw new Error(`the checksum file has no entry for ${name}; refusing to pin without a hash`);
    files[platform] = {
      url: `${BASE}/Blender${series}/${name}`,
      sha256,
      ...(sizes[platform] ? { size: sizes[platform] as number } : {}),
    };
  }
  return { schema: 1, version, files };
}

async function get(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

async function size(url: string): Promise<number | undefined> {
  const res = await fetch(url, { method: "HEAD" });
  const n = Number(res.headers.get("content-length"));
  return res.ok && n > 0 ? n : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const series = flag("--series") ?? "4.2";
  let version = flag("--version");

  if (!version) {
    const listing = await get(`${BASE}/Blender${series}/`);
    const candidates = versionsInListing(listing, series);
    if (candidates.length === 0) throw new Error(`no ${series}.x release with all required archives was found`);
    version = candidates[candidates.length - 1]!;
  }

  // Blender publishes blender-<version>.sha256 beside the archives.
  const checksums = parseChecksums(await get(`${BASE}/Blender${series}/blender-${version}.sha256`));
  const sizes: Record<string, number | undefined> = {};
  for (const [platform, nameFor] of Object.entries(TARGETS)) {
    sizes[platform] = await size(`${BASE}/Blender${series}/${nameFor(version)}`);
  }
  const release = buildRelease(version, series, checksums, sizes);
  const json = JSON.stringify(release, null, 2) + "\n";

  if (args.includes("--dry-run")) {
    process.stdout.write(json);
    return;
  }
  writeFileSync(OUT, json);
  process.stdout.write(`pinned Blender ${version} in ${OUT}\n`);
  for (const [platform, file] of Object.entries(release.files)) {
    process.stdout.write(`  ${platform.padEnd(10)} ${file.sha256}\n`);
  }
  process.stdout.write("Review the diff and commit it.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : "";
    process.stderr.write(`pin-blender failed: ${e instanceof Error ? e.message : String(e)}${cause}\n`);
    process.exitCode = 1;
  });
}
