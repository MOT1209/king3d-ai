# Desktop app (Windows)

`apps/desktop` wraps King3D in an Electron window: it starts the server, makes sure a
Blender is available, and shows the dashboard. It is a thin shell. The real logic is the
King3D CLI (`king3d blender ...`) and `apps/desktop/lib.cjs`, both covered by tests.

## How it runs
- The server is started as a child process on **Electron's embedded Node** (v24, which runs
  the project's TypeScript directly), so no separate Node is bundled.
- It binds `127.0.0.1` on a free port. The window refuses to navigate away from it.
- Runs are written to `Documents\King3D\runs` (`KING3D_RUNS_DIR`), not into the program folder.
- On quit, the app stops the server and the Blender daemon.

## Blender
Blender is not in git and not in the installer. On first run the app calls
`king3d blender install`, which downloads it from the URL pinned in
`src/integrations/blender/releases.json` and **installs it only if the SHA-256 matches**
(streamed hash, extracted into a staging folder, marked complete last). An install with no
pinned hash is refused. If automatic install fails, the app asks you to point it at your own
`blender.exe`.

```bash
king3d blender status      # what is pinned, installed and in use
king3d blender install     # download + verify + install (add --json for machine output)
king3d blender path        # the executable King3D will use
```

### Pinning (one-time per Blender version)
The pinned hashes come from Blender's own `.sha256` files and are never typed by hand.
`releases.json` ships **unpinned** until you do this, because blender.org was not reachable
where it was written:

1. GitHub → Actions → **desktop** → *Run workflow* with **pin_blender** ticked.
2. Download the `releases-json` artifact and commit it as `src/integrations/blender/releases.json`
   (or run `npm run blender:pin` yourself on any machine that can reach blender.org).

## Settings
**King3D → Settings…** (Ctrl+,) holds the AI provider/model/URL, the generator URLs and an
optional Blender path. The AI key is encrypted with Electron `safeStorage` (DPAPI on Windows)
and handed to the server only through its environment at start. The settings page can read
whether a key exists, never the key. If secure storage is unavailable the key is refused,
not stored in plain text.

## Build
```bash
cd apps/desktop
npm ci
npm run dist        # stages the server, then builds an NSIS installer (Windows)
```
CI does this on `windows-latest` and smoke-tests both the source run and the silently
installed app (`.github/workflows/desktop.yml`).

The installer is **unsigned**, so Windows SmartScreen will warn on first run. Signing needs a
code-signing certificate and is not set up.

## What has and has not been verified
| Part | Status |
|---|---|
| Blender installer (hash check, refusal when unpinned, bad archive, atomic marker) | Tested here (15 tests, incl. a mutation check on the hash comparison) |
| Pin script parsing | Tested on sample text only; **not run against blender.org** |
| Settings validation, env mapping, secret handling (with a fake safeStorage), runs dir | Tested here (17 tests) |
| Electron shell on Linux/xvfb: starts, spawns the server on embedded Node, loads the dashboard | Run here (smoke) |
| Staged server copy runs on Electron's Node | Run here |
| `safeStorage` / DPAPI on Windows | **Not tested** (no keyring on the Linux test box; only the refusal path ran) |
| NSIS installer build, silent install, packaged app | **Not run** — Windows CI only |
| Real Blender download and extraction of the official archives | **Not run** — blender.org is blocked here; the zip path relies on Windows' bundled `tar` |
