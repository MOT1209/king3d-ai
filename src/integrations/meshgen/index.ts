/**
 * Mesh generators: the models that turn an image or prompt into a raw base mesh.
 *
 * Every generator is an HTTP service behind the same contract (`GET /healthz`,
 * `POST /generate` -> GLB), so a new one is a registry entry plus a service, not
 * new pipeline code. What differs between them is licence and availability, which
 * is why that lives here, next to the name, where the UI can show it.
 */
import type { Ai3dConfig } from "../../core/config.ts";
import { Ai3dError } from "../../core/errors.ts";
import { acquireTrellis, HttpTrellisProvider, type TrellisProvider } from "../trellis/client.ts";

export const GENERATOR_NAMES = ["trellis2", "hunyuan3d"] as const;
export type GeneratorName = (typeof GENERATOR_NAMES)[number];

/** A generator is a TrellisProvider by another name: same contract, different service. */
export type MeshGenProvider = TrellisProvider;

export interface GeneratorInfo {
  name: GeneratorName;
  label: string;
  /** Model version recorded in the run's spec, for provenance. */
  model: string;
  /** Licence caveat the UI must show; null when there is none worth a warning. */
  restriction: string | null;
}

const INFO: Record<GeneratorName, GeneratorInfo> = {
  trellis2: { name: "trellis2", label: "TRELLIS.2", model: "4B", restriction: null },
  hunyuan3d: {
    name: "hunyuan3d",
    label: "Hunyuan3D",
    model: "2.1",
    restriction: "Licence excludes the EU, UK and South Korea (use of the output too). See services/hunyuan3d/README.md",
  },
};

export function generatorInfo(name: GeneratorName): GeneratorInfo {
  return INFO[name];
}

export function isGeneratorName(value: unknown): value is GeneratorName {
  return typeof value === "string" && (GENERATOR_NAMES as readonly string[]).includes(value);
}

export interface GeneratorStatus extends GeneratorInfo {
  /** Whether King3D has what it needs to call this generator (not whether it is up). */
  configured: boolean;
}

export function listGenerators(config: Ai3dConfig): GeneratorStatus[] {
  return GENERATOR_NAMES.map((name) => ({
    ...INFO[name],
    // TRELLIS has a default local URL and a mock; Hunyuan3D is opt-in and needs an explicit URL.
    configured: name === "trellis2" ? true : Boolean(config.hunyuan3dUrl),
  }));
}

export function acquireMeshGen(config: Ai3dConfig, name: GeneratorName): MeshGenProvider {
  switch (name) {
    case "trellis2":
      return acquireTrellis(config);
    case "hunyuan3d":
      if (!config.hunyuan3dUrl) {
        throw new Ai3dError(
          "CONFIG_INVALID",
          "Hunyuan3D is not configured. Set KING3D_GEN_HUNYUAN3D_URL to your own Hunyuan3D service. " +
            "Its licence excludes the EU, UK and South Korea; read services/hunyuan3d/README.md first.",
        );
      }
      return new HttpTrellisProvider(config.hunyuan3dUrl, config.trellisTimeoutMs);
  }
}
