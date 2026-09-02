# Blender bridge

How the TypeScript core drives Blender, and why it is built this way.

## Shape

```
TypeScript                          Python (inside Blender)
-----------------------------------------------------------------
BlenderBackend (interface)
├── SocketBackend  ──── TCP 9877 ──► ai3dlib/server.py ──┐
│     (default)                                          │
└── HeadlessBackend ─── job.json ──► blender/runner.py ──┤
      (fallback)                                         │
                                                         ▼
                                                  ai3dlib/job.py
                                                  ai3dlib/dispatch.py
                                                  ai3dlib/{scene,primitives,
                                                    materials,lighting,camera,
                                                    render,inspect_mesh,optimize,
                                                    exporter,contact_sheet}.py
```

Both transports call the same `run_job()`, so a batch behaves identically whether
it arrived over a socket or as a file. There is exactly one implementation of
each bpy operation.

## Why a persistent daemon is the default

Measured on the development machine (Intel Pentium Silver N5030, 4 threads,
8 GB RAM, Intel UHD 605, no Cycles-capable GPU):

| Path | Cost |
|---|---|
| `blender -b` one-shot batch (ping only) | **30 000 - 92 000 ms** |
| Blender's own init, before our script runs | 29 000 ms of that |
| Daemon start (once per session) | 15 800 ms |
| Batch over the warm daemon | **25 - 98 ms** |

Commands take milliseconds; starting Blender takes tens of seconds. Paying that
per batch would make a 12-stage pipeline with a repair loop unusable, so the
daemon is the primary path and `runner.py` is the fallback for CI and one-offs.

`blender-mcp` only supports the case where a GUI Blender is already open. The
daemon gives the same warm-process economics with no GUI and no user action.

### First batch after an idle pause

With free RAM under ~500 MB, Windows trims the idle daemon's working set (it was
observed at 5 MB). The next batch has to fault the process back in, which costs
12 000 - 45 000 ms once, after which batches return to milliseconds. `ai3d doctor`
reports this as a memory warning. It is a machine limit, not a bug.

## Protocol

`{id, cmd, params}` in, `{id, ok, result|error, logs, duration_ms}` out.

Over the socket every message is **4-byte big-endian length + UTF-8 JSON**
(`frame.ts` / `framing.py`). `blender-mcp` instead accumulates bytes and retries
`json.loads` until one succeeds, which mis-splits any payload containing an
embedded JSON string and truncates large results. `tests/frame.test.ts` covers
both failure modes.

Every command declares a params schema and a result schema in
`src/integrations/blender/protocol.ts`. Params are validated before sending and
results after receiving, so a drift between the two halves fails at the boundary
with a readable message instead of producing a quietly wrong scene.

## Command batching

A batch stops at the first failure and reports the rest as `SKIPPED`; continuing
would build on a scene that is already wrong. Scene state persists between
batches through `save_blend` / `load_blend`.

## Robustness rules learned the hard way

* **A client disconnect must never reach the accept loop.** An abrupt close (which
  the reachability probe used to cause) raised `ConnectionResetError` out of
  `read_frame` and killed the server. `framing._recv_exactly` now treats any
  connection error as EOF, and each connection is served inside its own
  try/except.
* **Never leave a spawned Blender's stdout on an undrained pipe.** Blender prints
  enough to fill the 64 KB pipe buffer, after which it blocks forever. The daemon
  writes straight to `runs/daemon.log` by file descriptor, which also lets it
  outlive the CLI process.
* **A missing `load_blend` is an error.** Silently falling back to an empty scene
  presents as "the model came out empty".
* **Do not introspect the render-engine enum.** Cycles ships as an addon and never
  appears in `RenderSettings.bl_rna.properties["engine"].enum_items` even when it
  is usable. Assignment is the only reliable availability test, and
  `--factory-startup` means Cycles must be enabled explicitly first.
* **`obj.dimensions` ignores rotation.** It is the local bounding box times scale.
  Gates compare `world_dimensions`, derived from the world-space bounding box.

## Render engines

Availability and speed differ enormously; `ai3d bench` measures the current
machine. On the development machine, rendering a 384px frame:

| Engine | Cold (first render in a process) | Warm |
|---|---|---|
| Workbench | ~54 s | **4.3 s** |
| Cycles (CPU) | ~46 s | ~40 s |
| EEVEE | ~156 s for 4 views | very slow |

EEVEE needs a GPU context that a background Blender does not have, and falls back
to software rasterisation. Workbench with `color_type = MATERIAL` still shows
per-material colour with shadows and cavity, which is enough for the structural
review passes; Cycles is reserved for the material/lighting review, where its cost
is paid once per repair cycle rather than per stage.

## Ports

`9877`. The third-party `blender-mcp` addon owns `9876`; we sit beside it
deliberately so both can be installed at once. `ai3d doctor` reports whether 9876
is live, because a running blender-mcp explains a lot of otherwise confusing
behaviour.

## python.exec

Disabled unless `AI3D_ALLOW_PYTHON_EXEC=1`. `blender-mcp` makes arbitrary code its
primary interface, which means no validation, no typed results, and no way to tell
what a call will do. Here it is a debugging escape hatch only.
