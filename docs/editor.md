# Editor

The dashboard's **Model** tab is an editor: pick a part in the 3D view, change its
size, placement or material, rebuild, and undo.

## How an edit works

An edit never touches the scene. Each change becomes a `{ path, value }` fix on the
SceneSpec — the same vocabulary the review stage already uses — and the server
rebuilds from the edited spec. So the inspector can only offer what the server
accepts:

- `components.<id>.dimensions_m | position_m | rotation_deg`
- `materials.<id>.base_color | metallic | roughness`

Anything else (adding parts, changing geometry kinds) is a new spec, not an edit, and
is rejected with HTTP 400.

```
click part → inspector → pending changes → Apply & rebuild
   POST /api/runs/:id/edit      applyRepairs → spec.repaired.json + revisions/rev-N.json
   POST /api/runs/:id/rebuild   builds spec.repaired.json into a NEW run, then opens it
```

Edits accumulate in `spec.repaired.json`; the built `spec.json` is never modified.
The rebuilt run is a new run, so the original stays available for comparison.

## Reading the view
- Click a part to select it (green outline). Dragging orbits and never selects.
- **Red** outlines mark parts named in a failing quality gate.
- Parts are matched to the GLB by name: the Blender object name is the component id.

## Undo
Every edit snapshots the resulting spec. **History → Revert** makes an earlier
revision (or `original`) the working spec again and rebuilds. Later revisions are
kept, so redo is a revert to a higher number.

## API
| Route | Body | Result |
|---|---|---|
| `POST /api/runs/:id/edit` | `{ fixes: [{ path, value }] }` | `{ rev, applied, skipped, spec }` |
| `GET /api/runs/:id/revisions` | — | `{ revisions: [{ rev, created_at, fixes }] }` |
| `POST /api/runs/:id/revert` | `{ rev }` (0 = built spec) | `{ rev, spec }` |

## Limits (v1)
- Generative (TRELLIS) runs can be viewed, not edited: they have no components.
- A material shared by several parts changes all of them.
- A review's repair also writes `spec.repaired.json`, so a later review replaces
  unbuilt edits.
- three.js still loads from a CDN, so the editor needs internet until it is vendored.
- A rebuild that fails (for example no Blender) leaves a stub run in the list.
