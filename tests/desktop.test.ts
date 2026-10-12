import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// lib.cjs is plain CommonJS used by the Electron shell; it has no Electron dependency.
const lib = createRequire(import.meta.url)("../apps/desktop/lib.cjs");

/** safeStorage stand-in: reversible "encryption" so tests can see what was stored. */
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => {
    const t = b.toString();
    if (!t.startsWith("enc:")) throw new Error("bad ciphertext");
    return t.slice(4);
  },
});

describe("JsonLines", () => {
  it("parses JSON events across chunk boundaries and ignores other output", () => {
    const events: unknown[] = [];
    const lines = new lib.JsonLines((e: unknown) => events.push(e));
    lines.push('{"event":"progress","pha');
    lines.push('se":"download"}\nsome log line\n{"event":"done"}\n{broken\n');
    expect(events).toEqual([{ event: "progress", phase: "download" }, { event: "done" }]);
  });
});

describe("validateSettings", () => {
  it("accepts an empty form as 'no AI model'", () => {
    const r = lib.validateSettings({});
    expect(r.ok).toBe(true);
    expect(r.clean.llmProvider).toBe("agent");
  });

  it("requires a base URL and model for openai-compatible, and http(s) URLs everywhere", () => {
    const r = lib.validateSettings({ llmProvider: "openai-compatible", trellisUrl: "ftp://x", hunyuan3dUrl: "javascript:alert(1)" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/base URL/);
    expect(r.errors.join(" ")).toMatch(/model/);
    expect(r.errors.join(" ")).toMatch(/trellisUrl/);
    expect(r.errors.join(" ")).toMatch(/hunyuan3dUrl/);
  });

  it("rejects an unknown provider and drops unknown fields, so the page cannot set arbitrary env vars", () => {
    expect(lib.validateSettings({ llmProvider: "evil" }).ok).toBe(false);
    const r = lib.validateSettings({ llmProvider: "anthropic", NODE_OPTIONS: "--require evil.js", PATH: "/x" });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.clean)).not.toContain("NODE_OPTIONS");
    expect(Object.keys(lib.settingsToEnv(r.clean, ""))).not.toContain("NODE_OPTIONS");
  });
});

describe("settingsToEnv", () => {
  it("maps settings to KING3D_* variables and omits empty ones", () => {
    const env = lib.settingsToEnv(
      { llmProvider: "openai-compatible", llmModel: "llama3.2", llmBaseUrl: "http://127.0.0.1:11434/v1", trellisUrl: "", hunyuan3dUrl: "http://gpu:8901", blenderPath: "C:\\Blender\\blender.exe" },
      "sk-key",
    );
    expect(env).toEqual({
      KING3D_LLM_PROVIDER: "openai-compatible",
      KING3D_LLM_MODEL: "llama3.2",
      KING3D_LLM_BASE_URL: "http://127.0.0.1:11434/v1",
      KING3D_LLM_API_KEY: "sk-key",
      KING3D_GEN_HUNYUAN3D_URL: "http://gpu:8901",
      KING3D_BLENDER_PATH: "C:\\Blender\\blender.exe",
    });
  });

  it("sets nothing for provider 'agent'", () => {
    expect(lib.settingsToEnv({ llmProvider: "agent" }, "")).toEqual({});
  });
});

describe("secrets", () => {
  it("never exposes the stored key to the page, only whether one exists", () => {
    const shown = lib.publicSettings({ llmProvider: "anthropic", apiKeyEnc: "c2VjcmV0" });
    expect(shown.apiKeySet).toBe(true);
    expect(JSON.stringify(shown)).not.toContain("c2VjcmV0");
    expect(lib.publicSettings({}).apiKeySet).toBe(false);
  });

  it("round-trips a key through safeStorage", () => {
    const ss = fakeSafeStorage();
    const enc = lib.encryptSecret(ss, "sk-ant-secret");
    expect(enc).not.toContain("sk-ant-secret");
    expect(lib.decryptSecret(ss, enc)).toBe("sk-ant-secret");
  });

  it("refuses to store a key when encryption is unavailable instead of writing plaintext", () => {
    expect(() => lib.encryptSecret(fakeSafeStorage(false), "sk-secret")).toThrow(/not available/);
  });

  it("treats an undecryptable value as 'no key', not a crash", () => {
    expect(lib.decryptSecret(fakeSafeStorage(), Buffer.from("garbage").toString("base64"))).toBe("");
    expect(lib.decryptSecret(fakeSafeStorage(), undefined)).toBe("");
  });
});

describe("settings file", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = () => (dirs[dirs.push(mkdtempSync(join(tmpdir(), "k3d-desk-"))) - 1] as string);

  it("saves atomically, readable only by the owner, and loads it back", () => {
    const file = join(tmp(), "nested", "settings.json");
    lib.saveSettings(file, { llmProvider: "anthropic", apiKeyEnc: "x" });
    expect(lib.loadSettings(file)).toEqual({ llmProvider: "anthropic", apiKeyEnc: "x" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("returns {} for a missing or corrupt file", () => {
    const dir = tmp();
    expect(lib.loadSettings(join(dir, "none.json"))).toEqual({});
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(lib.loadSettings(join(dir, "bad.json"))).toEqual({});
  });
});

describe("freePort / waitForHttp", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("hands out a usable loopback port", async () => {
    const port = await lib.freePort();
    expect(port).toBeGreaterThan(1023);
  });

  it("resolves once the server answers 200", async () => {
    let hits = 0;
    server = createServer((_req, res) => {
      res.writeHead(++hits < 3 ? 503 : 200);
      res.end("{}");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    await lib.waitForHttp(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/`, 5000);
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it("times out with the last error, and stops early if the process died", async () => {
    const port = await lib.freePort();
    await expect(lib.waitForHttp(`http://127.0.0.1:${port}/`, 600)).rejects.toThrow(/timed out/);
    await expect(lib.waitForHttp(`http://127.0.0.1:${port}/`, 5000, () => false)).rejects.toThrow(/exited/);
  });
});

describe("KING3D_RUNS_DIR", () => {
  const read = (env: Record<string, string>) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", "import('./src/core/config.ts').then(m=>console.log(m.paths.runs))"], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    }).trim();

  it("moves the runs directory out of the application folder", () => {
    expect(read({ KING3D_RUNS_DIR: join(tmpdir(), "my-runs") })).toBe(join(tmpdir(), "my-runs"));
  });

  it("defaults to <project>/runs", () => {
    const { KING3D_RUNS_DIR: _omit, ...rest } = process.env;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", "import('./src/core/config.ts').then(m=>console.log(m.paths.runs))"], { env: rest, encoding: "utf8" }).trim();
    expect(out.endsWith("runs")).toBe(true);
  });
});
