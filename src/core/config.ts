import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Ai3dError } from "./errors.ts";

/** Walk up from this file until the directory containing package.json is found. */
function findProjectRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Ai3dError("CONFIG_INVALID", "Could not locate project root (no package.json found above src/)");
}

export const PROJECT_ROOT = findProjectRoot();

export const paths = {
  root: PROJECT_ROOT,
  blenderDir: join(PROJECT_ROOT, "blender"),
  blenderRunner: join(PROJECT_ROOT, "blender", "runner.py"),
  blenderLib: join(PROJECT_ROOT, "blender", "lib"),
  blenderAddon: join(PROJECT_ROOT, "blender", "addon", "ai3d_bridge"),
  blenderTests: join(PROJECT_ROOT, "blender", "tests", "run_tests.py"),
  runs: join(PROJECT_ROOT, "runs"),
  inputs: join(PROJECT_ROOT, "inputs"),
  fixtures: join(PROJECT_ROOT, "tests", "fixtures"),
  viewer: join(PROJECT_ROOT, "viewer"),
  web: join(PROJECT_ROOT, "web"),
} as const;

/** Windows install roots scanned for `Blender <version>/blender.exe`. */
const WINDOWS_BLENDER_ROOTS = [
  "C:/Program Files/Blender Foundation",
  "C:/Program Files (x86)/Blender Foundation",
];

const POSIX_BLENDER_CANDIDATES = [
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "/usr/bin/blender",
  "/usr/local/bin/blender",
  "/snap/bin/blender",
];

/** Compare "Blender 5.2" style folder names numerically, newest first. */
function compareVersionDesc(a: string, b: string): number {
  const pa = (a.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  const pb = (b.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
  for (let i = 0; i < 2; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return b.localeCompare(a);
}

/**
 * Locate the Blender executable.
 * Order: KING3D_BLENDER_PATH -> platform install roots (newest version) -> PATH.
 * Returns null instead of throwing so `doctor` can report a clean diagnosis.
 */
export function findBlenderExecutable(): string | null {
  const override = process.env["KING3D_BLENDER_PATH"];
  if (override && existsSync(override)) return override;
  if (override) {
    throw new Ai3dError("BLENDER_NOT_FOUND", `KING3D_BLENDER_PATH is set but does not exist: ${override}`, {
      path: override,
    });
  }

  if (process.platform === "win32") {
    for (const root of WINDOWS_BLENDER_ROOTS) {
      if (!existsSync(root)) continue;
      const versionDirs = readdirSync(root)
        .filter((d) => {
          try {
            return statSync(join(root, d)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort(compareVersionDesc);
      for (const d of versionDirs) {
        const exe = join(root, d, "blender.exe");
        if (existsSync(exe)) return exe;
      }
    }
  } else {
    for (const candidate of POSIX_BLENDER_CANDIDATES) {
      if (existsSync(candidate)) return candidate;
    }
  }

  // Last resort: rely on PATH resolution at spawn time.
  const pathDirs = (process.env["PATH"] ?? "").split(process.platform === "win32" ? ";" : ":");
  const exeName = process.platform === "win32" ? "blender.exe" : "blender";
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = join(dir, exeName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function requireBlenderExecutable(): string {
  const exe = findBlenderExecutable();
  if (!exe) {
    throw new Ai3dError(
      "BLENDER_NOT_FOUND",
      "Blender executable not found. Set KING3D_BLENDER_PATH to blender.exe (or blender).",
    );
  }
  return exe;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * "daemon": one long-lived Blender, batches over a socket. The default, because
 * starting Blender costs 30-90s here while a batch costs milliseconds.
 * "headless": a fresh `blender -b` per batch. Correct but slow; for CI and debugging.
 */
export type BackendKind = "daemon" | "headless";

export interface Ai3dConfig {
  backend: BackendKind;
  bridgeHost: string;
  bridgePort: number;
  /** Guarded arbitrary-python execution over the bridge. Off unless explicitly enabled. */
  allowPythonExec: boolean;
  /** Per-command budget for a headless Blender invocation. */
  blenderTimeoutMs: number;
}

export function loadConfig(overrides: Partial<Ai3dConfig> = {}): Ai3dConfig {
  const backendRaw = (process.env["KING3D_BACKEND"] ?? "daemon").toLowerCase();
  // "socket" is accepted as a synonym for "daemon": same transport either way.
  const backend: BackendKind = backendRaw === "socket" ? "daemon" : (backendRaw as BackendKind);
  if (backend !== "daemon" && backend !== "headless") {
    throw new Ai3dError("CONFIG_INVALID", `KING3D_BACKEND must be "daemon" or "headless", got "${backendRaw}"`);
  }
  return {
    backend,
    bridgeHost: process.env["KING3D_BRIDGE_HOST"] ?? "127.0.0.1",
    // 9876 belongs to the third-party blender-mcp addon; we deliberately sit beside it.
    bridgePort: envInt("KING3D_BRIDGE_PORT", 9877),
    allowPythonExec: process.env["KING3D_ALLOW_PYTHON_EXEC"] === "1",
    blenderTimeoutMs: envInt("KING3D_BLENDER_TIMEOUT_MS", 300_000),
    ...overrides,
  };
}

export function runDir(runId: string): string {
  return resolve(paths.runs, runId);
}
