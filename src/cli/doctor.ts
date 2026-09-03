/**
 * Environment diagnosis.
 *
 * Reports what is actually true rather than what should be: every check either
 * ran and produced a value, or says why it could not.
 */
import { existsSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { findBlenderExecutable, loadConfig, paths } from "../core/config.ts";
import { errorMessage } from "../core/errors.ts";
import { daemonStatus, HeadlessBackend, isBridgeReachable, runOne } from "../integrations/blender/index.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
  startupMs?: number;
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: Check[] = [];
  const config = loadConfig();
  let startupMs: number | undefined;

  checks.push({
    name: "node",
    status: Number(process.versions.node.split(".")[0]) >= 24 ? "ok" : "fail",
    detail: `v${process.versions.node} (>=24 required for native TypeScript execution)`,
  });

  const blenderPath = (() => {
    try {
      return findBlenderExecutable();
    } catch (e) {
      checks.push({ name: "blender path", status: "fail", detail: errorMessage(e) });
      return null;
    }
  })();

  if (blenderPath) {
    checks.push({ name: "blender path", status: "ok", detail: blenderPath });
  } else if (!checks.some((c) => c.name === "blender path")) {
    checks.push({
      name: "blender path",
      status: "fail",
      detail: "not found under Program Files or on PATH; set KING3D_BLENDER_PATH",
    });
  }

  for (const [label, path] of [
    ["runner", paths.blenderRunner],
    ["daemon", join(paths.blenderDir, "daemon.py")],
    ["ai3dlib", join(paths.blenderDir, "ai3dlib", "dispatch.py")],
  ] as const) {
    checks.push({
      name: `blender-side ${label}`,
      status: existsSync(path) ? "ok" : "fail",
      detail: path,
    });
  }

  const status = await daemonStatus(config);
  checks.push({
    name: "daemon",
    status: status.running ? "ok" : "warn",
    detail: status.running
      ? `running on ${status.state?.host}:${status.state?.port} (pid ${status.state?.pid})`
      : `not running; "king3d daemon start" will start one on ${config.bridgeHost}:${config.bridgePort}`,
  });

  // 9876 is the third-party blender-mcp addon's port. We deliberately avoid it,
  // but knowing whether it is live explains a lot of confusing behaviour.
  const mcpPortBusy = await isBridgeReachable("127.0.0.1", 9876, 800);
  checks.push({
    name: "port 9876 (third-party blender-mcp)",
    status: "ok",
    detail: mcpPortBusy ? "in use - unrelated to king3d, which uses 9877" : "free",
  });

  if (blenderPath && !status.running) {
    // Only pay for this when there is no daemon to ask; it costs a full startup.
    try {
      const started = Date.now();
      const backend = new HeadlessBackend({ blenderPath, timeoutMs: 300_000 });
      const pong = await runOne(backend, "ping", {}, { cwd: paths.root });
      startupMs = Date.now() - started;
      checks.push({
        name: "blender launch",
        status: "ok",
        detail: `Blender ${pong.blender_version}, Python ${pong.python_version} (cold start ${(startupMs / 1000).toFixed(1)}s)`,
      });
      if (startupMs > 20_000) {
        checks.push({
          name: "startup cost",
          status: "warn",
          detail: `${(startupMs / 1000).toFixed(1)}s per cold start - keep the daemon running rather than using KING3D_BACKEND=headless`,
        });
      }
    } catch (e) {
      checks.push({ name: "blender launch", status: "fail", detail: errorMessage(e) });
    }
  } else if (status.running) {
    checks.push({ name: "blender launch", status: "skip", detail: "daemon already answering" });
  }

  checks.push({
    name: "backend",
    status: "ok",
    detail: `${config.backend} (python.exec ${config.allowPythonExec ? "ENABLED" : "disabled"})`,
  });

  // Memory pressure is the difference between a 25ms batch and a 20s one: an idle
  // daemon gets paged out when free RAM is short, and faulting it back in is slow.
  const freeMb = Math.round(freemem() / 1024 / 1024);
  const totalMb = Math.round(totalmem() / 1024 / 1024);
  checks.push({
    name: "memory",
    status: freeMb < 1024 ? "warn" : "ok",
    detail:
      `${freeMb} MB free of ${totalMb} MB` +
      (freeMb < 1024 ? " - the idle daemon may be paged out, making the first batch after a pause slow" : ""),
  });

  checks.push({
    name: "cpu",
    status: cpus().length < 4 ? "warn" : "ok",
    detail: `${cpus().length} threads - ${cpus()[0]?.model ?? "unknown"}`,
  });

  const report: DoctorReport = {
    ok: !checks.some((c) => c.status === "fail"),
    checks,
  };
  if (startupMs !== undefined) report.startupMs = startupMs;
  return report;
}

const SYMBOLS: Record<CheckStatus, string> = { ok: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = report.checks.map((c) => `  ${SYMBOLS[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const warned = report.checks.filter((c) => c.status === "warn").length;
  return (
    `king3d doctor\n${lines.join("\n")}\n\n` +
    (report.ok ? `environment usable (${warned} warning${warned === 1 ? "" : "s"})\n` : `${failed} check(s) failed\n`)
  );
}
