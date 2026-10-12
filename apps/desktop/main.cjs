"use strict";
/**
 * King3D desktop shell.
 *
 * Deliberately thin: it starts King3D's own server as a child process, makes sure a
 * Blender is available, and shows the dashboard in a window. The server runs on Electron's
 * embedded Node (ELECTRON_RUN_AS_NODE), which executes the project's TypeScript directly,
 * so no separate Node is bundled. All real logic lives in the King3D CLI and in lib.cjs.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./lib.cjs");

const SMOKE = process.env.KING3D_DESKTOP_SMOKE === "1";
// Packaged: resources/king3d (see scripts/stage.mjs). Dev: the repository root.
const ROOT = app.isPackaged ? path.join(process.resourcesPath, "king3d") : path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "src", "cli", "index.ts");

let server = null; // { child, port }
let mainWindow = null;
let quitting = false;
let started = false; // quit-on-last-window only once the dashboard has been shown

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const logFile = () => path.join(app.getPath("userData"), "logs", "server.log");
const runsDir = () => process.env.KING3D_RUNS_DIR || path.join(app.getPath("documents"), "King3D", "runs");

function childEnv(extra = {}) {
  const stored = lib.loadSettings(settingsFile());
  const apiKey = lib.decryptSecret(safeStorage, stored.apiKeyEnc);
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    KING3D_RUNS_DIR: runsDir(),
    ...lib.settingsToEnv(stored, apiKey),
    ...extra,
  };
}

/** Run a King3D CLI command; resolves with every JSON event it printed and its exit code. */
function runCli(args, onEvent = () => undefined) {
  return new Promise((resolve) => {
    const events = [];
    const lines = new lib.JsonLines((e) => {
      events.push(e);
      onEvent(e);
    });
    const child = spawn(process.execPath, [CLI, ...args], { env: childEnv(), cwd: ROOT, windowsHide: true });
    child.stdout.on("data", (d) => lines.push(d.toString()));
    child.stderr.on("data", () => undefined);
    child.on("error", (e) => resolve({ events, code: -1, error: e.message }));
    child.on("close", (code) => resolve({ events, code }));
  });
}

// ------------------------------------------------------------------ windows

function showProgress(text, fraction) {
  if (SMOKE || !progressWin) return;
  const script = `document.getElementById("msg").textContent = ${JSON.stringify(text)};
    const bar = document.getElementById("bar"), fill = document.getElementById("fill");
    ${fraction == null ? 'bar.classList.add("indeterminate");' : `bar.classList.remove("indeterminate"); fill.style.width = "${Math.round(fraction * 100)}%";`}`;
  progressWin.webContents.executeJavaScript(script).catch(() => undefined);
}

let progressWin = null;
function openProgress() {
  if (SMOKE) return;
  progressWin = new BrowserWindow({
    width: 380, height: 180, resizable: false, minimizable: false, maximizable: false, title: "King3D",
    autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  progressWin.loadFile(path.join(__dirname, "progress.html"));
}
function closeProgress() {
  if (progressWin && !progressWin.isDestroyed()) progressWin.close();
  progressWin = null;
}

function openDashboard(port) {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, title: "King3D", show: !SMOKE, backgroundColor: "#16181d",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const origin = `http://127.0.0.1:${port}`;
  // The dashboard may link out (docs, licence pages); those open in the real browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });
  mainWindow.on("closed", () => (mainWindow = null));
  return mainWindow.loadURL(origin);
}

let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    width: 560, height: 760, title: "King3D settings", autoHideMenuBar: true, parent: mainWindow || undefined,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
}

// ------------------------------------------------------------------ server

async function startServer() {
  const port = await lib.freePort();
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  const log = fs.openSync(logFile(), "a");
  const child = spawn(process.execPath, [CLI, "web", "--port", String(port)], {
    env: childEnv(), cwd: ROOT, windowsHide: true, stdio: ["ignore", log, log],
  });
  let alive = true;
  child.on("exit", () => (alive = false));
  server = { child, port };
  await lib.waitForHttp(`http://127.0.0.1:${port}/api/runs`, 60_000, () => alive);
  return port;
}

function stopServer() {
  if (server && !server.child.killed) server.child.kill();
  server = null;
}

/** King3D keeps one Blender daemon alive between commands; closing the app must end it. */
async function stopBlenderDaemon() {
  await Promise.race([runCli(["daemon", "stop"]), new Promise((r) => setTimeout(r, 8000))]);
}

// ------------------------------------------------------------------ Blender

function looksLikeBlender(file) {
  return /(^|[\\/])blender(\.exe)?$/i.test(file) && fs.existsSync(file);
}

async function pickBlender(reason) {
  for (;;) {
    const answer = await dialog.showMessageBox({
      type: "warning", title: "King3D needs Blender", buttons: ["Choose Blender...", "Quit"], defaultId: 0, cancelId: 1,
      message: "King3D could not set up Blender automatically.",
      detail: `${reason}\n\nIf Blender 4.2 or newer is installed, point King3D at blender.exe.`,
    });
    if (answer.response !== 0) return null;
    const picked = await dialog.showOpenDialog({ title: "Select blender.exe", properties: ["openFile"], filters: [{ name: "Blender", extensions: ["exe", "*"] }] });
    if (picked.canceled || !picked.filePaths[0]) continue;
    if (!looksLikeBlender(picked.filePaths[0])) {
      reason = "That file does not look like Blender's executable.";
      continue;
    }
    const stored = lib.loadSettings(settingsFile());
    lib.saveSettings(settingsFile(), { ...stored, blenderPath: picked.filePaths[0] });
    return picked.filePaths[0];
  }
}

async function ensureBlender() {
  showProgress("Checking Blender...", null);
  const status = (await runCli(["blender", "status", "--json"])).events.find((e) => e.event === "status");
  if (status && status.in_use) return true;

  let failure = status && !status.installable ? "No Blender release is available for automatic install on this system." : "";
  if (!failure) {
    showProgress("Downloading Blender (first run only)...", 0);
    const result = await runCli(["blender", "install", "--json"], (e) => {
      if (e.event === "progress" && e.phase === "download") showProgress("Downloading Blender (first run only)...", e.total ? e.received / e.total : null);
      else if (e.event === "progress" && e.phase === "verify") showProgress("Verifying download...", null);
      else if (e.event === "progress" && e.phase === "extract") showProgress("Unpacking Blender...", null);
    });
    const last = result.events[result.events.length - 1];
    if (last && last.event === "done") return true;
    failure = (last && last.message) || "The Blender install did not finish.";
  }
  closeProgress();
  const chosen = await pickBlender(failure);
  if (chosen) openProgress();
  return Boolean(chosen);
}

// ------------------------------------------------------------------ settings IPC

function trustedSender(event) {
  return Boolean(settingsWin) && event.sender === settingsWin.webContents && event.senderFrame.url.startsWith("file:");
}

function registerIpc() {
  ipcMain.handle("settings:get", (event) => {
    if (!trustedSender(event)) throw new Error("untrusted sender");
    return lib.publicSettings(lib.loadSettings(settingsFile()));
  });

  ipcMain.handle("settings:chooseBlender", async (event) => {
    if (!trustedSender(event)) throw new Error("untrusted sender");
    const picked = await dialog.showOpenDialog(settingsWin, { properties: ["openFile"], filters: [{ name: "Blender", extensions: ["exe", "*"] }] });
    return !picked.canceled && picked.filePaths[0] && looksLikeBlender(picked.filePaths[0]) ? picked.filePaths[0] : null;
  });

  ipcMain.handle("settings:save", async (event, values) => {
    if (!trustedSender(event)) throw new Error("untrusted sender");
    const checked = lib.validateSettings(values);
    if (!checked.ok) return { ok: false, errors: checked.errors };

    const stored = lib.loadSettings(settingsFile());
    const next = { ...checked.clean };
    const typedKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
    try {
      next.apiKeyEnc = typedKey ? lib.encryptSecret(safeStorage, typedKey) : stored.apiKeyEnc; // empty = keep the stored key
    } catch (e) {
      return { ok: false, errors: [e.message] };
    }
    lib.saveSettings(settingsFile(), next);

    // Restart the server so it picks the new environment up, then reload the dashboard.
    stopServer();
    try {
      const port = await startServer();
      if (mainWindow) await mainWindow.loadURL(`http://127.0.0.1:${port}`);
    } catch (e) {
      return { ok: false, errors: [`saved, but the server did not restart: ${e.message}`] };
    }
    return { ok: true, errors: [] };
  });
}

// ------------------------------------------------------------------ lifecycle

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "King3D", submenu: [
      { label: "Settings...", accelerator: "CmdOrCtrl+,", click: openSettings },
      { label: "Open runs folder", click: () => shell.openPath(runsDir()) },
      { label: "Open log", click: () => shell.openPath(logFile()) },
      { type: "separator" }, { role: "quit" },
    ] },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { role: "togglefullscreen" }] },
  ]));
}

async function main() {
  if (!app.requestSingleInstanceLock()) return app.quit();
  app.on("second-instance", () => mainWindow && (mainWindow.isMinimized() && mainWindow.restore(), mainWindow.focus()));

  await app.whenReady();
  registerIpc();
  buildMenu();
  fs.mkdirSync(runsDir(), { recursive: true });

  openProgress();
  try {
    if (!(await ensureBlender())) return app.quit();
    showProgress("Starting King3D...", null);
    const port = await startServer();
    await openDashboard(port);
    started = true;
    closeProgress();
    if (SMOKE) await smoke(port);
  } catch (e) {
    closeProgress();
    if (SMOKE) {
      smokeReport("SMOKE_FAIL " + e.message);
      return app.exit(1);
    }
    dialog.showErrorBox("King3D could not start", `${e.message}\n\nLog: ${logFile()}`);
    app.quit();
  }
}

/** A GUI app cannot print to the console on Windows, so the result also goes to a file when asked. */
function smokeReport(line) {
  console.log(line);
  if (process.env.KING3D_DESKTOP_SMOKE_OUT) fs.writeFileSync(process.env.KING3D_DESKTOP_SMOKE_OUT, line + "\n");
}

/** Headless check used by CI and by me: the window really loaded the dashboard from the sidecar. */
async function smoke(port) {
  await new Promise((r) => setTimeout(r, 800)); // let the dashboard fetch its generator list
  const info = await mainWindow.webContents.executeJavaScript(
    `JSON.stringify({ title: document.title, form: !!document.querySelector("#new-run-form"), generators: document.querySelectorAll("#new-generator option").length })`,
  );
  const runs = await fetch(`http://127.0.0.1:${port}/api/runs`).then((r) => r.status);
  const key = lib.settingsToEnv({ llmProvider: "anthropic" }, "k").KING3D_LLM_API_KEY;
  const line = ["SMOKE_OK", info, "api/runs=" + runs, "runs_dir=" + runsDir(), "env_mapping=" + (key === "k"), "safeStorage=" + safeStorage.isEncryptionAvailable()].join(" ");
  smokeReport(line);
  app.exit(0);
}

app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  stopServer();
  stopBlenderDaemon().finally(() => app.exit(0));
});
app.on("window-all-closed", () => {
  if (!SMOKE && started) app.quit();
});

main();
