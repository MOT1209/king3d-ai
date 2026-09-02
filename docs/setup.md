# Setup

## Requirements

* **Node 24+** - the project runs TypeScript directly via Node's native type
  stripping, so there is no build step.
* **Blender 4.2+** (developed against 5.2.0 LTS). Found automatically under
  `C:/Program Files/Blender Foundation`, the usual macOS/Linux paths, or `PATH`.
  Override with `AI3D_BLENDER_PATH`.

Nothing is installed into Blender's Python: the Blender-side code is standard
library plus `bpy` and the numpy that Blender already bundles.

## Install

```
npm install
node src/cli/index.ts doctor
```

`doctor` reports what it actually found, including how long a cold Blender start
costs on this machine and whether memory pressure will slow the daemon down.

## Everyday use

```
node src/cli/index.ts daemon start      # once per session (15-90s)
node src/cli/index.ts scene             # milliseconds thereafter
node src/cli/index.ts daemon stop
```

Commands start the daemon on demand, so `daemon start` is optional - it just moves
the wait somewhere predictable.

## Tests

```
npm test                 # vitest: framing, schemas, batch handling
npm run test:blender     # unit tests inside Blender's own interpreter
npm run typecheck
npm run bench            # measure this machine's startup and render costs
```

## Configuration

See `.env.example`. All settings are environment variables; none are required.

| Variable | Default | Purpose |
|---|---|---|
| `AI3D_BLENDER_PATH` | auto-detected | Blender executable |
| `AI3D_BACKEND` | `daemon` | `daemon` (persistent) or `headless` (one-shot) |
| `AI3D_BRIDGE_PORT` | `9877` | Daemon port (9876 belongs to third-party blender-mcp) |
| `AI3D_ALLOW_PYTHON_EXEC` | unset | Set to `1` to enable the arbitrary-Python escape hatch |
| `AI3D_LOG_LEVEL` | `info` | `debug` shows the bridge traffic |

No AI API keys are needed: visual judgement is done by the agent in the loop.
