/**
 * Runs the Blender-side unit tests.
 *
 * bpy only exists inside Blender, so this suite cannot run under vitest; it is
 * launched in Blender's own interpreter and its exit code is propagated.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { paths, requireBlenderExecutable } from "../core/config.ts";

export function runBlenderTests(): Promise<number> {
  const blenderPath = requireBlenderExecutable();
  const script = join(paths.blenderDir, "tests", "run_tests.py");

  return new Promise((resolve) => {
    const child = spawn(
      blenderPath,
      ["--background", "--factory-startup", "-noaudio", "--python", script],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    let sawVerdict = false;
    const forward = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (text.includes("AI3D_BLENDER_TESTS")) sawVerdict = true;
      // Blender's own startup chatter is noise; only test output is interesting.
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        if (/^(Fra:|Mem:|Info:|Blender \d)/.test(line)) continue;
        process.stdout.write(line + "\n");
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);

    child.on("error", (err) => {
      process.stderr.write(`could not launch Blender: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => {
      if (!sawVerdict) {
        process.stderr.write("\nthe suite did not report a verdict; Blender may have crashed before finishing\n");
        resolve(1);
        return;
      }
      resolve(code === 0 ? 0 : 1);
    });
  });
}
