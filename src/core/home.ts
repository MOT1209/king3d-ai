/**
 * Where King3D keeps what it downloads, and how to find a Blender it installed.
 *
 * Kept free of other project imports so config.ts can use it to locate Blender
 * without a cycle.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Written last, after verification and extraction: its presence means "complete". */
export const INSTALL_MARKER = ".king3d-installed";

export function kingHome(): string {
  const override = process.env["KING3D_HOME"];
  if (override) return override;
  if (process.platform === "win32") {
    return join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "King3D");
  }
  return join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "king3d");
}

export function blenderExecutableName(platform: string = process.platform): string {
  return platform === "win32" ? "blender.exe" : "blender";
}

/** Breadth-first search, so `blender` at the top of the archive wins over a nested copy. */
export function findExecutableIn(dir: string, name: string, maxDepth = 3): string | null {
  let level = [dir];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const current of level) {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name === name) return join(current, entry.name);
        if (entry.isDirectory()) next.push(join(current, entry.name));
      }
    }
    level = next;
  }
  return null;
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function managedBlenderDirName(version: string): string {
  return `blender-${version}`;
}

/** Newest complete Blender that King3D installed itself, or null. */
export function managedBlenderPath(home: string = kingHome(), name: string = blenderExecutableName()): string | null {
  if (!existsSync(home)) return null;
  const versions = readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("blender-") && existsSync(join(home, d.name, INSTALL_MARKER)))
    .map((d) => d.name.slice("blender-".length))
    .sort(compareVersionsDesc);
  for (const version of versions) {
    const found = findExecutableIn(join(home, managedBlenderDirName(version)), name);
    if (found) return found;
  }
  return null;
}
