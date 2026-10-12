// Build the directory electron-builder ships as resources/king3d: the server's source, the
// dashboard, the Blender-side Python and its production dependencies. Blender itself is NOT
// included - it is downloaded on first run, checksum-verified.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
// electron-builder drops a node_modules that sits at the ROOT of an extraResources directory
// (util/filter.js: `relative === "node_modules"` -> false) but keeps nested ones. So the server is staged
// one level down, in stage/king3d, and shipped with `to: "."`; otherwise the installed app has no zod.
const staged = resolve(here, "..", "stage");
const stage = join(staged, "king3d");

rmSync(staged, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const skip = (src) => !/(__pycache__|[\\/]tests[\\/]?$|\.pyc$)/.test(src);
for (const dir of ["src", "web", "blender"]) cpSync(join(root, dir), join(stage, dir), { recursive: true, filter: skip });
cpSync(join(root, "package.json"), join(stage, "package.json"));
cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));

execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
console.log(`staged King3D server in ${stage}`);
