# Pipeline

How a reference becomes a game-ready asset, and which parts need a model.

## Shape

```
reference image / prompt
        |
        v
   [ MODEL ]  spec     -> SceneSpec, every field marked observed or inferred
        |
        v
   geometry             deterministic: strategies -> Blender commands
   lighting             deterministic: rig scaled to the object
   render               deterministic: standard views -> one captioned sheet
   inspect              deterministic: measured mesh statistics
   gates                deterministic: 11 checks, scored
        |
        v
   [ MODEL ]  review    -> similarity + defects, each with an optional fix
        |
        v
   repair               deterministic: apply fixes to the spec, rebuild
        |
        v
   export               unwrap, meet the triangle budget, write GLB
   verify               re-import the GLB and compare triangle counts
```

Two stages need eyes. Everything between them is arithmetic, which is the point:
model tokens are spent on visual judgement, never on bookkeeping.

## The spec is the source of truth

Every stage after `spec` reads the SceneSpec and nothing else. A repair edits the
spec and re-runs the build rather than poking at the Blender scene, so:

* the same spec always produces the same scene, renders and scores;
* a change in the report is attributable to a change in the spec;
* the final `.blend` is never the only record of a decision.

### Provenance

A single photograph shows one side of an object. Everything else is inference, so
each measurement records which it is:

```json
"dimensions_m": { "value": [0.08, 0.08, 0.1], "provenance": "observed", "confidence": 0.85 }
```

The review request lists every inferred field and instructs the reviewer not to
call one wrong unless the render contradicts something the reference actually
shows. Repaired values are re-marked `inferred`, because they are now the
reviewer's belief rather than the reference's evidence.

## Geometry strategies

The builder must be able to execute a spec without improvising, so strategies are
a small closed set:

| Strategy | Produces |
|---|---|
| `primitive` | one primitive at a size, place and rotation |
| `hollow` | a shell with a cavity inset by the wall thickness, open on a named face |
| `cut` | a primitive with one or more boolean cutters removed |
| `array` | a primitive repeated at a constant offset |

`hollow` is the interesting one: the cavity is the same primitive inset by the
wall thickness, then shifted by exactly one thickness toward the open face, so it
pierces that face and leaves a floor of precisely the stated thickness.

## Gates

Eleven deterministic checks over measured values - completeness, identity parts,
proportions, loose geometry, manifold (opt-in), non-empty, materials assigned,
material budget, orphans, triangle budget, UVs - plus two more once an export
exists.

Proportion checking is **rotation-invariant**: a component's spec dimensions are
local while the measurement is world-space, so both triples are sorted before
comparison. A rotated handle would otherwise fail a check it should pass.

The export gate re-imports the written GLB into a throwaway scene and compares
triangle counts. An exporter reporting success is not evidence that the file
loads.

Scores are weighted: geometry 0.35, similarity 0.20, material 0.20,
optimization 0.15, export 0.10. Optimization rewards headroom under the budget
rather than merely passing it.

## Review and repair

The review sees one image - the contact sheet, reference first - plus the spec,
the measured scores and any failing gates. It returns a similarity score and a
list of defects. A defect may carry a fix, expressed as a path into the spec and
a new value.

Fix paths are deliberately narrow:

```
object.overall_dimensions_m.value
components.<id>.dimensions_m.value | position_m.value | rotation_deg.value
materials.<id>.base_color | metallic | roughness
```

Sizes, placements and surface values may change; structure may not. Restructuring
is a new spec, not a repair, and a review that could rewrite arbitrary fields
would make a failed build impossible to attribute. A fix of the wrong shape is
skipped with a reason, and if the repaired spec fails validation the whole repair
is discarded rather than half-applied.

## Resumable, not blocking

A stage that needs judgement writes `runs/<id>/prompts/<stage>.request.md` - a
self-contained brief naming the images, the context and the answer schema - and
stops. The answer goes to `<stage>.response.json` and the command is re-run.

This is what lets the agent already driving the session be the model: no API key,
no per-token cost, no secret to leak, and a full audit trail of what was asked
and answered on disk beside the artefacts.

An answer is validated against its schema. A rejected answer leaves
`<stage>.errors.txt` explaining what was wrong, so the next attempt is informed.

## Run layout

```
runs/<id>/
  spec.json              the spec this run built
  spec.repaired.json     written only when a review proposed applicable fixes
  scene.blend            carries scene state between batches
  views/*.png            one render per standard view
  contact_sheet.png      the single image the review looks at
  export/model.glb
  report.json            gates, scores, timings, artefact paths, the review
  prompts/               request/response pairs
```
