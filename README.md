# ai3d

An AI 3D engineering agent: reference image or prompt in, game-ready asset out,
built procedurally in Blender and checked before it is handed over.

Informed by [img2threejs](https://github.com/img2threejs/img2threejs) (staged
generation behind quality gates, model tokens spent only on visual judgement) and
[blender-mcp](https://github.com/ahujasid/blender-mcp) (driving Blender from an
agent), without copying either.

## Status

The pipeline runs end to end: reference image in, verified GLB out.

* **Blender bridge** - 24 typed commands, two transports, one shared Python
  implementation. `docs/blender-bridge.md`
* **SceneSpec** - the source of truth, with per-field provenance separating what
  was observed from what was inferred.
* **Analysis** - reference image to spec draft. `ai3d gen --image`
* **Deterministic build** - geometry, lighting, renders, 11 quality gates, and a
  GLB export verified by re-import. `ai3d build`
* **Review and repair** - similarity score plus defects, each optionally carrying
  a fix applied back to the spec. `ai3d review --rebuild`
* **Viewer** - the exported GLB in a browser. `ai3d viewer`

88 tests pass: 67 under vitest, 21 inside Blender.

Not built yet: multi-view input, LOD generation, external 3D-generation
providers, and a web interface.

## Quick start

```bash
npm install
node src/cli/index.ts doctor                  # check the environment
node src/cli/index.ts fixtures:build          # render a reference to work from
node src/cli/index.ts gen --image tests/fixtures/mug_reference.png --run-id slice
#   answer the spec request it prints, then re-run the same command
node src/cli/index.ts review slice            # judge it, repair the spec
node src/cli/index.ts viewer slice            # look at the GLB
```

`docs/setup.md` covers requirements and configuration. No AI API key is needed.

## How it works

```
reference -> [MODEL] spec -> geometry -> lighting -> render -> gates
                                                                |
                        export <- repair <- [MODEL] review <----+
```

Two stages need eyes; everything between them is arithmetic. `docs/pipeline.md`
explains the stages, the gates and the repair vocabulary.

## Design notes worth knowing

* **The daemon is the point.** Starting Blender costs 30-90s on modest hardware
  while a command batch costs milliseconds, so one Blender is kept alive and fed
  batches over a socket. Measurements are in `docs/blender-bridge.md`.
* **Nothing is assumed to have worked.** The exporter is not trusted (the GLB is
  re-imported), the renderer is not trusted (the file must exist), and both sides
  of the wire validate against the same schemas.
* **The spec, not the scene, is edited.** A repair changes the spec and rebuilds,
  which keeps every result reproducible from a single JSON file.

## Layout

```
src/core/                 config, logging, error taxonomy
src/integrations/blender/ the bridge: protocol, framing, backends, daemon
src/spec/                 SceneSpec and fixtures
src/pipeline/             builder, gates, review, run orchestration
src/providers/            model providers (agent-in-the-loop by default)
src/cli/                  the ai3d command
blender/ai3dlib/          the Blender-side Python
blender/tests/            unit tests that run inside Blender
tests/                    vitest suites
docs/
```
