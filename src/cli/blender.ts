/**
 * `king3d blender install | status | path`
 *
 * With --json, output is one JSON object per line on stdout (progress events, then a
 * final "done" or "error" event), so the desktop app can drive the install and show a
 * progress bar without parsing prose.
 */
import { findBlenderExecutable } from "../core/config.ts";
import { Ai3dError, errorMessage } from "../core/errors.ts";
import { kingHome } from "../core/home.ts";
import { currentPlatformKey, installBlender, installedVersions, loadReleases } from "../integrations/blender/install.ts";

export interface BlenderCommandOptions {
  action: string | undefined;
  asJson: boolean;
}

function emit(asJson: boolean, event: Record<string, unknown>, text?: string): void {
  if (asJson) process.stdout.write(JSON.stringify(event) + "\n");
  else if (text !== undefined) process.stdout.write(text + "\n");
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

export async function runBlender({ action, asJson }: BlenderCommandOptions): Promise<number> {
  switch (action) {
    case "install": {
      let lastPct = -1;
      try {
        const result = await installBlender({
          onProgress: (p) => {
            if (p.phase === "download") {
              const pct = p.total ? Math.floor((p.received / p.total) * 100) : -1;
              if (asJson) emit(true, { event: "progress", phase: "download", received: p.received, total: p.total });
              else if (pct !== lastPct && pct % 10 === 0) {
                lastPct = pct;
                process.stderr.write(`  downloading Blender ${p.total ? `${pct}% (${mb(p.received)}/${mb(p.total)} MB)` : `${mb(p.received)} MB`}\n`);
              }
            } else if (asJson) emit(true, { event: "progress", phase: p.phase });
            else if (p.phase !== "done") process.stderr.write(`  ${p.phase}...\n`);
          },
        });
        emit(asJson, { event: "done", ...result }, `${result.alreadyInstalled ? "already installed" : "installed"}: ${result.executable}`);
        return 0;
      } catch (e) {
        const message = e instanceof Ai3dError ? e.message : errorMessage(e);
        emit(asJson, { event: "error", message, details: e instanceof Ai3dError ? e.details : {} });
        if (!asJson) process.stderr.write(`error: ${message}\n`);
        return 1;
      }
    }

    case "path": {
      const found = findBlenderExecutable();
      emit(asJson, { event: "path", path: found }, found ?? "");
      return found ? 0 : 1;
    }

    case "status":
    case undefined: {
      const release = loadReleases();
      const installed = await installedVersions();
      const found = findBlenderExecutable();
      const status = {
        platform: currentPlatformKey(),
        home: kingHome(),
        pinned_version: release.version,
        installable: Boolean(release.version && release.files[currentPlatformKey()]),
        installed_by_king3d: installed,
        in_use: found,
      };
      emit(
        asJson,
        { event: "status", ...status },
        [
          `platform        ${status.platform}`,
          `king3d home     ${status.home}`,
          `pinned release  ${status.pinned_version ?? "none (run: npm run blender:pin)"}`,
          `installed       ${installed.length ? installed.join(", ") : "none"}`,
          `in use          ${found ?? "no Blender found"}`,
        ].join("\n"),
      );
      return found ? 0 : 1;
    }

    default:
      process.stderr.write(`unknown action "${action}": use install, status or path\n`);
      return 1;
  }
}
