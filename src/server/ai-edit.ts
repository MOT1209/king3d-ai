/**
 * AI-proposed edits.
 *
 * The model is asked for the same thing a person edits by hand - `{ path, value }`
 * fixes on the SceneSpec - so its answer is held to the same vocabulary
 * (`RepairPath`) and the same dry-run through `applyRepairs`. It cannot add or
 * remove parts or change how anything is built, and nothing is written here:
 * a proposal comes back for the person to review, and only an explicit Apply in
 * the editor turns it into an edit.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Ai3dError } from "../core/errors.ts";
import { applyRepairs, Defect, RepairPath } from "../pipeline/review.ts";
import type { ModelProvider, VisionRequest } from "../providers/provider.ts";
import { safeParseSceneSpec, type SceneSpec } from "../spec/scene-spec.ts";
import type { RunPaths } from "./runs-list.ts";

export const AiEditProposal = z.object({
  explanation: z.string().min(1),
  fixes: z
    .array(
      z.object({
        path: RepairPath,
        value: z.union([z.number(), z.array(z.number())]),
        reason: z.string().default(""),
      }),
    )
    .max(20),
});
export type AiEditProposal = z.infer<typeof AiEditProposal>;

export interface AiEditResult {
  explanation: string;
  /** Fixes that resolve against this spec and have the right shape. */
  fixes: Array<{ path: string; value: number | number[]; reason: string }>;
  /** Fixes the model proposed that cannot apply, with why. */
  skipped: Array<{ path: string; reason: string }>;
}

const SCHEMA_HINT = `{
  "explanation": "one or two sentences: what you changed and why",
  "fixes": [
    { "path": "<allowed path>", "value": <number or [numbers]>, "reason": "short" }
  ]
}
Allowed paths (and nothing else):
  object.overall_dimensions_m.value               value: [x, y, z]
  components.<component_id>.dimensions_m.value   value: [x, y, z]   (metres)
  components.<component_id>.position_m.value     value: [x, y, z]   (metres)
  components.<component_id>.rotation_deg.value   value: [x, y, z]   (degrees)
  materials.<material_id>.base_color             value: [r, g, b, a] each 0-1
  materials.<material_id>.metallic               value: number 0-1
  materials.<material_id>.roughness              value: number 0-1
Use only component_id / material_id values that appear in the facts. A vector
value replaces the whole vector, so include all three components. If the request
cannot be done with these paths, return "fixes": [] and say why in "explanation".`;

async function workingSpec(rp: RunPaths): Promise<SceneSpec> {
  const file = existsSync(join(rp.dir, "spec.repaired.json")) ? join(rp.dir, "spec.repaired.json") : rp.spec;
  if (!existsSync(file)) throw new Ai3dError("RUN_STATE_INVALID", "this run has no spec to edit yet");
  const parsed = safeParseSceneSpec(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new Ai3dError("SPEC_INVALID", "the spec does not validate", { issues: parsed.error.issues });
  return parsed.data;
}

/** Just what the model needs to reason about the object - not the whole spec. */
function describe(spec: SceneSpec): Record<string, unknown> {
  return {
    object: {
      name: spec.object.name,
      category: spec.object.category,
      overall_dimensions_m: spec.object.overall_dimensions_m.value,
    },
    axes: "metres and degrees; +Z is up, -Y is the front",
    components: spec.components.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      material: c.material,
      dimensions_m: c.dimensions_m.value,
      position_m: c.position_m.value,
      rotation_deg: c.rotation_deg.value,
    })),
    materials: spec.materials.map((m) => ({
      id: m.id,
      base_color: m.base_color,
      metallic: m.metallic,
      roughness: m.roughness,
    })),
  };
}

export async function proposeEdit(rp: RunPaths, instruction: string, provider: ModelProvider): Promise<AiEditResult> {
  const text = instruction?.trim();
  if (!text) throw new Ai3dError("CONFIG_INVALID", "an instruction is required");
  if (text.length > 2000) throw new Ai3dError("CONFIG_INVALID", "the instruction is too long (max 2000 characters)");

  const spec = await workingSpec(rp);
  const request: VisionRequest<AiEditProposal> = {
    stage: "ai-edit",
    instruction:
      "Edit the 3D object described below according to the user's request, using only the allowed paths. " +
      `User request: ${text}`,
    images: [],
    schema: AiEditProposal,
    schemaHint: SCHEMA_HINT,
    context: describe(spec),
  };
  const proposal = await provider.ask(request);

  // Dry run: nothing is written. Anything that does not resolve or has the wrong shape is reported.
  const defects: Defect[] = proposal.fixes.map((fix, i) => ({
    id: `ai_${i + 1}`,
    severity: "P1" as const,
    problem: "ai edit",
    fix: { path: fix.path, value: fix.value, reason: fix.reason || "proposed by the AI" },
  }));
  const outcome = applyRepairs(spec, defects);
  const appliedIds = new Set(outcome.applied.map((a) => a.defect));

  return {
    explanation: proposal.explanation,
    fixes: proposal.fixes.filter((_, i) => appliedIds.has(`ai_${i + 1}`)),
    skipped: outcome.skipped.map((s) => ({
      path: proposal.fixes[Number(s.defect.slice(3)) - 1]?.path ?? s.defect,
      reason: s.reason,
    })),
  };
}
