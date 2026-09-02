export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

let threshold: LogLevel = (process.env["AI3D_LOG_LEVEL"] as LogLevel | undefined) ?? "info";
const useColor = process.stderr.isTTY === true && process.env["NO_COLOR"] === undefined;

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
}

function emit(scope: string, level: LogLevel, msg: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  const tag = useColor ? `${COLORS[level]}${level.padEnd(5)}${RESET}` : level.padEnd(5);
  const prefix = scope ? `[${scope}] ` : "";
  let line = `${tag} ${prefix}${msg}`;
  if (data !== undefined) {
    let rendered: string;
    try {
      rendered = typeof data === "string" ? data : JSON.stringify(data);
    } catch {
      rendered = String(data);
    }
    line += ` ${rendered}`;
  }
  // Logs go to stderr so stdout stays clean for machine-readable command output.
  process.stderr.write(line + "\n");
}

export function createLogger(scope = ""): Logger {
  return {
    debug: (m, d) => emit(scope, "debug", m, d),
    info: (m, d) => emit(scope, "info", m, d),
    warn: (m, d) => emit(scope, "warn", m, d),
    error: (m, d) => emit(scope, "error", m, d),
    child: (sub) => createLogger(scope ? `${scope}:${sub}` : sub),
  };
}

export const log = createLogger();
