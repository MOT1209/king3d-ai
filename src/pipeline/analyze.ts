/**
 * The analysis stage: reference image (or prompt) to SceneSpec draft.
 *
 * This is the first of the two places that need eyes, and the harder one. The
 * request has to convey the whole modelling vocabulary - what strategies exist,
 * what units are used, what counts as observed - because everything downstream
 * executes the answer literally and without judgement.
 */
import type { VisionRequest } from "../providers/provider.ts";
import { SpecDraft } from "../spec/scene-spec.ts";

const SCHEMA_HINT = `A JSON object with these top-level keys:

  object      { category, name, description, overall_dimensions_m, symmetry,
                visible_from, occluded_regions }
  components  [ ... ]   at least one
  materials   [ ... ]   at least one, each used by some component
  camera      { azimuth_deg, elevation_deg, lens_mm, margin }        (optional)
  quality     { target_tris, max_materials, require_uv,
                require_manifold, dimension_tolerance }              (optional)
  render      { review_engine, final_engine, resolution, samples, views }  (optional)

A measured value is an object, never a bare number:

  "overall_dimensions_m": {
    "value": [0.116, 0.08, 0.1],
    "provenance": "observed" | "inferred",
    "confidence": 0.0-1.0,
    "note": "optional, say why"
  }

Measured fields: object.overall_dimensions_m, object.symmetry,
and per component dimensions_m, position_m, rotation_deg.

A component:

  {
    "id": "lower_snake_case",         also becomes the Blender object name
    "name": "Human readable",
    "role": "what this part is for, e.g. handle, leg, lid",
    "identity_defining": true|false,  true if the object is not itself without it
    "geometry": { ...strategy... },
    "dimensions_m": <measured [x,y,z]>,   LOCAL size, before rotation
    "position_m":  <measured [x,y,z]>,    centre, in metres, +Z is up
    "rotation_deg": <measured [x,y,z]>,   optional, degrees
    "material": "<a material id>",
    "parent": "<another component id>",   optional
    "notes": "optional"
  }

Geometry strategies - these four and nothing else:

  { "kind": "primitive", "primitive": <kind>, "options": {}, "shade_smooth": false }

  { "kind": "hollow", "primitive": <kind>, "options": {},
    "wall_thickness_m": 0.005, "open": "top"|"bottom"|"front"|"none" }
      A shell. The cavity is inset by the wall thickness and pierces the open
      face, leaving a floor of exactly that thickness on the opposite one.

  { "kind": "cut", "primitive": <kind>, "options": {},
    "cutters": [ { "primitive": <kind>, "options": {},
                   "dimensions_m": [x,y,z], "offset_m": [x,y,z],
                   "rotation_deg": [x,y,z] } ] }
      Booleans subtracted from the base. Offsets are relative to the component.

  { "kind": "array", "primitive": <kind>, "options": {},
    "count": 4, "step_m": [x,y,z] }
      One primitive repeated at a constant offset. Use it for legs, slats, teeth.

Primitive kinds: cube, uv_sphere, ico_sphere, cylinder, cone, torus, plane,
circle, empty.

Useful options (all optional; size always comes from dimensions_m, so these only
control tessellation and shape ratios):
  cylinder   vertices
  cone       vertices, radius1, radius2
  uv_sphere  segments, ring_count
  torus      major_segments, minor_segments, major_radius, minor_radius
  ico_sphere subdivisions

A material:

  { "id": "lower_snake_case", "name": "Human readable",
    "base_color": [r,g,b,a],   each 0-1, linear
    "metallic": 0-1, "roughness": 0-1,
    "ior": 1.45,                     optional
    "alpha": 0-1,                    optional, below 1 for glass
    "provenance": "observed"|"inferred",
    "appearance": "plain-language description of the surface" }`;

const GUIDANCE = `How to answer well:

1. **Metres, always.** A coffee mug is about 0.10 m tall, not 10. Getting the
   scale wrong makes every downstream light and camera wrong too.

2. **+Z is up. -Y is the front.** A component's position_m is the centre of its
   bounding box. An object standing on the ground has its base at z = 0, so a
   0.1 m tall body sits at z = 0.05.

3. **dimensions_m is LOCAL, before rotation.** If you rotate a ring 90 degrees
   about X to stand it upright, still state the ring's own flat-lying size.

4. **Mark provenance honestly.** "observed" means you can see it in the image.
   Depth of something shown only from the front, the far side, the underside,
   the interior - these are "inferred". Being wrong is fine; claiming to have
   seen something you inferred is not, because the review stage trusts these
   marks when deciding what to criticise.

5. **Decompose into parts that a primitive can express.** Prefer four or five
   well-placed components over twenty. If a shape needs a strategy that is not
   on the list, approximate it with one that is and say so in "notes".

6. **Every component needs a material, and every material needs a user.** An
   unused material is rejected.

7. **Fill occluded_regions.** List what the reference could not show. This is
   what stops the review stage from marking a reasonable guess as a defect.`;

export interface AnalyzeContext {
  imagePath?: string;
  prompt?: string;
  /** Anything the user said about scale, use, or intent. */
  hints?: string;
  /** A worked example of a valid spec, which is worth more than prose. */
  example?: unknown;
}

export function buildSpecRequest(context: AnalyzeContext): VisionRequest<SpecDraft> {
  const hasImage = context.imagePath !== undefined;

  const instruction = hasImage
    ? `Look at the reference image and describe the object in it as a buildable 3D specification.

Identify what the object is, break it into parts, and give each part a size, a place and a
material. The result is executed literally and without judgement: a procedural builder turns
it straight into Blender geometry, so anything vague becomes something wrong.

You are seeing one view. Say what you can see, infer the rest, and mark which is which.

${GUIDANCE}`
    : `Turn this description into a buildable 3D specification.

${context.prompt ?? ""}

There is no reference image, so everything is inference. Choose proportions that are typical
for this kind of object and mark them accordingly.

${GUIDANCE}`;

  const requestContext: Record<string, unknown> = {};
  if (context.prompt && hasImage) requestContext["prompt"] = context.prompt;
  if (context.hints) requestContext["hints"] = context.hints;
  if (context.example) requestContext["worked_example"] = context.example;

  return {
    stage: "spec",
    instruction,
    images: hasImage ? [{ path: context.imagePath as string, label: "reference" }] : [],
    schema: SpecDraft,
    schemaHint: SCHEMA_HINT,
    ...(Object.keys(requestContext).length > 0 ? { context: requestContext } : {}),
  };
}
