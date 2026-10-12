"use strict";
/**
 * Pure helpers for the desktop shell. Nothing here touches Electron, so all of it is
 * covered by vitest (tests/desktop.test.ts); main.cjs only wires these to windows.
 */
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const PROVIDERS = ["agent", "anthropic", "openai-compatible"];

/** Splits a stream into lines and parses the ones that are JSON (the CLI's --json events). */
class JsonLines {
  constructor(onEvent) {
    this.buffer = "";
    this.onEvent = onEvent;
  }
  push(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line.startsWith("{")) continue;
      try {
        this.onEvent(JSON.parse(line));
      } catch {
        /* a stray non-JSON line is not an event */
      }
    }
  }
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate and normalise what the settings window sends. Returns { ok, errors, clean }.
 * Unknown fields are dropped, so the renderer can never smuggle in an arbitrary env var.
 */
function validateSettings(input) {
  const errors = [];
  const src = input && typeof input === "object" ? input : {};
  const str = (v, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const clean = {
    llmProvider: str(src.llmProvider) || "agent",
    llmModel: str(src.llmModel, 200),
    llmBaseUrl: str(src.llmBaseUrl, 500),
    trellisUrl: str(src.trellisUrl, 500),
    hunyuan3dUrl: str(src.hunyuan3dUrl, 500),
    blenderPath: str(src.blenderPath, 1000),
  };
  if (!PROVIDERS.includes(clean.llmProvider)) errors.push(`unknown provider "${clean.llmProvider}"`);
  if (clean.llmProvider === "openai-compatible" && !clean.llmBaseUrl) errors.push("openai-compatible needs a base URL");
  if (clean.llmProvider === "openai-compatible" && !clean.llmModel) errors.push("openai-compatible needs a model");
  for (const key of ["llmBaseUrl", "trellisUrl", "hunyuan3dUrl"]) {
    if (clean[key] && !isHttpUrl(clean[key])) errors.push(`${key} must be an http(s) URL`);
  }
  return { ok: errors.length === 0, errors, clean };
}

/** Settings (+ the decrypted key) -> environment for the server process. Empty values are omitted. */
function settingsToEnv(settings, apiKey) {
  const env = {};
  const set = (name, value) => {
    if (value) env[name] = value;
  };
  if (settings.llmProvider && settings.llmProvider !== "agent") set("KING3D_LLM_PROVIDER", settings.llmProvider);
  set("KING3D_LLM_MODEL", settings.llmModel);
  set("KING3D_LLM_BASE_URL", settings.llmBaseUrl);
  set("KING3D_LLM_API_KEY", apiKey);
  set("KING3D_TRELLIS_URL", settings.trellisUrl);
  set("KING3D_GEN_HUNYUAN3D_URL", settings.hunyuan3dUrl);
  set("KING3D_BLENDER_PATH", settings.blenderPath);
  return env;
}

/** What the renderer may see: never the key, only whether one is stored. */
function publicSettings(stored) {
  const { apiKeyEnc, ...rest } = stored;
  return { ...rest, apiKeySet: Boolean(apiKeyEnc) };
}

function encryptSecret(safeStorage, plain) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "secure storage is not available on this system, so the key was not saved. " +
        "Set KING3D_LLM_API_KEY in the environment instead.",
    );
  }
  return safeStorage.encryptString(plain).toString("base64");
}

function decryptSecret(safeStorage, encoded) {
  if (!encoded) return "";
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return ""; // a key encrypted under another account/machine is unreadable, not an error
  }
}

function loadSettings(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveSettings(file, stored) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs, isAlive = () => true) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error("the server process exited before it became ready");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url} (${lastError})`);
}

module.exports = {
  PROVIDERS,
  JsonLines,
  validateSettings,
  settingsToEnv,
  publicSettings,
  encryptSecret,
  decryptSecret,
  loadSettings,
  saveSettings,
  freePort,
  waitForHttp,
};
