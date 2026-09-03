#!/usr/bin/env node
/**
 * king3d command line.
 *
 * Machine-readable output goes to stdout; progress and diagnostics go to stderr,
 * so `king3d scene --json | jq` works without filtering log noise.
 */
import { parseArgs } from "node:util";
import { loadConfig, paths } from "../core/config.ts";
import { errorMessage, isAi3dError } from "../core/errors.ts";
import { setLogLevel, type LogLevel } from "../core/logger.ts";
import { runDoctor, formatDoctorReport } from "./doctor.ts";
import { acquireBackend, Batch, daemonStatus, startDaemon, stopDaemon } from "../integrations/blender/index.ts";

const USAGE = `king3d - AI 3D engineering agent

Usage: king3d <command> [options]

Commands:
  doctor                 Check the environment (Blender, Python, daemon, ports)
  daemon start           Start the persistent Blender daemon
  daemon stop            Stop it
  daemon status          Report whether it is running
  scene                  Print the current Blender scene as JSON
  gen --image <path>     Full pipeline from a reference image or --prompt
  build [spec.json]      Build a SceneSpec: geometry, renders, gates, GLB export
  review <run-id>        Judge a build against its reference and propose repairs
  viewer <run-id>        Serve the exported GLB in a browser
  bench                  Measure startup and render cost on this machine
  test:blender           Run the Blender-side unit suite (inside Blender)
  fixtures:build         Render the ground-truth reference image
  web                    Start the dashboard (upload, build, review, view)

Options:
  --json                 Machine-readable output where supported
  --blend <path>         .blend file to load for the command
  --spec <path>          SceneSpec JSON for the build command (default: mug fixture)
  --reference <path>     Reference image to place first on the contact sheet
  --image <path>         Reference image for gen
  --prompt <text>        Text description for gen, when there is no image
  --hints <text>         Extra context for the analysis stage
  --run-id <id>          Name the run directory instead of timestamping it
  --no-export            Stop after the renders and gates
  --rebuild              After a review, rebuild from the repaired spec
  --log-level <level>    debug | info | warn | error   (default: info)
  -h, --help             Show this help
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: "boolean", default: false },
      blend: { type: "string" },
      spec: { type: "string" },
      reference: { type: "string" },
      "run-id": { type: "string" },
      "no-export": { type: "boolean", default: false },
      rebuild: { type: "boolean", default: false },
      image: { type: "string" },
      prompt: { type: "string" },
      hints: { type: "string" },
      engine: { type: "string" },
      port: { type: "string" },
      "log-level": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values["log-level"]) setLogLevel(values["log-level"] as LogLevel);

  const command = positionals[0];
  if (!command || values["help"] === true) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  const asJson = values["json"] === true;

  switch (command) {
    case "doctor": {
      const report = await runDoctor();
      process.stdout.write(asJson ? JSON.stringify(report, null, 2) + "\n" : formatDoctorReport(report));
      return report.ok ? 0 : 1;
    }

    case "daemon": {
      const sub = positionals[1] ?? "status";
      const config = loadConfig();
      if (sub === "start") {
        const status = await daemonStatus(config);
        if (status.running) {
          process.stdout.write(`daemon already running on ${config.bridgeHost}:${config.bridgePort}\n`);
          return 0;
        }
        process.stderr.write("starting Blender daemon (this takes 30-90s on this machine)...\n");
        const state = await startDaemon(config, {
          onProgress: (m) => process.stderr.write(`  ${m}\n`),
        });
        process.stdout.write(`daemon ready: pid ${state.pid} on ${state.host}:${state.port}\n`);
        return 0;
      }
      if (sub === "stop") {
        const stopped = await stopDaemon(config);
        process.stdout.write(stopped ? "daemon stopped\n" : "no daemon was running\n");
        return 0;
      }
      const status = await daemonStatus(config);
      process.stdout.write(
        asJson
          ? JSON.stringify(status, null, 2) + "\n"
          : status.running
            ? `running on ${status.state?.host}:${status.state?.port} (pid ${status.state?.pid}, since ${status.state?.startedAt})\n`
            : `not running (configured for ${config.bridgeHost}:${config.bridgePort})\n`,
      );
      return status.running ? 0 : 1;
    }

    case "scene": {
      const config = loadConfig();
      const { backend, coldStart } = await acquireBackend(config, {
        onProgress: (m) => process.stderr.write(`  ${m}\n`),
      });
      if (coldStart) process.stderr.write("(started a new Blender daemon)\n");

      const batch = new Batch().add("scene.info", {});
      const blend = values["blend"] as string | undefined;
      const outcome = await batch.run(backend, {
        cwd: paths.root,
        ...(blend ? { loadBlend: blend } : {}),
      });
      const info = batch.resultAt(outcome, 0, "scene.info");

      if (asJson) {
        process.stdout.write(JSON.stringify(info, null, 2) + "\n");
      } else {
        process.stdout.write(
          `Blender ${info.blender_version} (Python ${info.python_version}), engine ${info.engine}\n` +
            `scene "${info.scene_name}": ${info.counts.objects} objects, ${info.counts.meshes} meshes, ` +
            `${info.counts.total_tris} tris, ${info.counts.materials} materials\n`,
        );
        for (const obj of info.objects) {
          process.stdout.write(
            `  ${obj.name.padEnd(20)} ${obj.type.padEnd(8)} tris=${String(obj.tris).padEnd(7)} ` +
              `dims=${obj.dimensions.map((d) => d.toFixed(3)).join(" x ")}\n`,
          );
        }
      }
      process.stderr.write(`(batch ${outcome.wallMs}ms, blender work ${outcome.timings?.batch_ms ?? "?"}ms)\n`);
      await backend.close();
      return outcome.ok ? 0 : 1;
    }

    case "build": {
      const { runBuild } = await import("./build.ts");
      return runBuild({
        specPath: (values["spec"] as string | undefined) ?? positionals[1],
        ...(values["reference"] ? { referenceImage: values["reference"] as string } : {}),
        ...(values["run-id"] ? { runId: values["run-id"] as string } : {}),
        skipExport: values["no-export"] === true,
        asJson,
      });
    }

    case "gen": {
      const { runGen } = await import("./gen.ts");
      return runGen({
        ...(values["image"] ? { imagePath: values["image"] as string } : {}),
        ...(values["prompt"] ? { prompt: values["prompt"] as string } : {}),
        ...(values["hints"] ? { hints: values["hints"] as string } : {}),
        ...(values["run-id"] ? { runId: values["run-id"] as string } : {}),
        skipExport: values["no-export"] === true,
        asJson,
      });
    }

    case "fixtures:build": {
      const { runFixtures } = await import("./fixtures.ts");
      return runFixtures({
        ...(values["engine"] ? { engine: values["engine"] as "WORKBENCH" | "EEVEE" | "CYCLES" } : {}),
      });
    }

    case "web": {
      const { runWeb } = await import("./web.ts");
      return runWeb({
        ...(values["port"] ? { port: Number(values["port"]) } : {}),
      });
    }

    case "review": {
      const { runReview } = await import("./review.ts");
      const runId = positionals[1];
      if (!runId) {
        process.stderr.write("review needs a run id: king3d review <run-id>\n");
        return 1;
      }
      return runReview({
        runId,
        rebuild: values["rebuild"] === true,
        ...(values["reference"] ? { referenceImage: values["reference"] as string } : {}),
        asJson,
      });
    }

    case "viewer": {
      const { runViewer } = await import("./viewer.ts");
      const runId = positionals[1];
      if (!runId) {
        process.stderr.write("viewer needs a run id: king3d viewer <run-id>\n");
        return 1;
      }
      return runViewer({
        runId,
        ...(values["port"] ? { port: Number(values["port"]) } : {}),
      });
    }

    case "bench": {
      const { runBench } = await import("./bench.ts");
      return runBench(asJson);
    }

    case "test:blender": {
      const { runBlenderTests } = await import("./test-blender.ts");
      return runBlenderTests();
    }

    default:
      process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    if (isAi3dError(e)) {
      process.stderr.write(`\nerror [${e.code}] ${e.message}\n`);
      if (Object.keys(e.details).length > 0) {
        process.stderr.write(`${JSON.stringify(e.details, null, 2)}\n`);
      }
      if (e.code === "BLENDER_NOT_FOUND") {
        process.stderr.write(
          `\nLooked for blender.exe under Program Files and on PATH. ` +
            `Set KING3D_BLENDER_PATH if it lives elsewhere.\n`,
        );
      }
    } else {
      process.stderr.write(`\nunexpected error: ${errorMessage(e)}\n`);
      if (e instanceof Error && e.stack) process.stderr.write(e.stack + "\n");
    }
    process.exitCode = 1;
  });

