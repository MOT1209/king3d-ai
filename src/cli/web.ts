/**
 * `king3d web [--port]` - start the dashboard.
 */
import { startServer } from "../server/http.ts";

export interface WebCommandOptions {
  port?: number;
  host?: string;
}

export async function runWeb(options: WebCommandOptions = {}): Promise<number> {
  const port = options.port ?? 5180;
  const host = options.host ?? "127.0.0.1";
  const server = startServer({ port, host });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  process.stdout.write(`\nking3d dashboard: http://${host}:${port}\n`);
  process.stderr.write("press Ctrl+C to stop\n");

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => server.close(() => resolve()));
  });
  return 0;
}
