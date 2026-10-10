/**
 * Client for the TRELLIS.2 inference service - the generative "brain" that turns
 * an image or prompt into a raw base mesh (GLB with PBR materials).
 *
 * The service is a separate Python/CUDA process (see services/trellis). This is
 * the only place in the Node core that knows how to reach it, and it is kept
 * deliberately thin: an HTTP POST that writes the returned GLB to disk. The
 * boundary is HTTP precisely so the CUDA/GPU concern never leaks into Node or
 * into the Blender bridge, and so the same client works whether the service runs
 * locally (http://127.0.0.1:8900) or in the cloud - only the base URL changes.
 *
 * A mock provider returns a fixture GLB without any GPU, so the whole generative
 * pipeline is testable in CI and usable in development before a GPU exists.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Ai3dConfig, paths } from "../../core/config.ts";
import { Ai3dError } from "../../core/errors.ts";
import { createLogger } from "../../core/logger.ts";

const log = createLogger("trellis");

export interface GenerateInput {
  imagePath?: string;
  prompt?: string;
  seed?: number;
}

export interface GenerateResult {
  /** Absolute path the base mesh was written to. */
  glbPath: string;
  /** Provenance for the generative-spec / report. */
  meta: Record<string, unknown>;
}

export interface TrellisProvider {
  readonly kind: "http" | "mock";
  /** Cheap reachability probe; never throws. */
  health(): Promise<boolean>;
  /** Generate a base mesh and write it to `outGlbPath`. */
  generate(input: GenerateInput, outGlbPath: string): Promise<GenerateResult>;
}

/** Talks to a running TRELLIS.2 service over HTTP. */
export class HttpTrellisProvider implements TrellisProvider {
  readonly kind = "http" as const;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number) {
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(new URL("/healthz", this.#baseUrl), { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async generate(input: GenerateInput, outGlbPath: string): Promise<GenerateResult> {
    if (!input.imagePath && !input.prompt) {
      throw new Ai3dError("TRELLIS_GENERATE_FAILED", "generate requires an image or a prompt");
    }

    const form = new FormData();
    if (input.imagePath) {
      if (!existsSync(input.imagePath)) {
        throw new Ai3dError("TRELLIS_GENERATE_FAILED", `image not found: ${input.imagePath}`, { path: input.imagePath });
      }
      const bytes = await readFile(input.imagePath);
      form.set("image", new Blob([bytes]), "input.png");
    }
    if (input.prompt) form.set("prompt", input.prompt);
    if (input.seed !== undefined) form.set("seed", String(input.seed));

    let res: Response;
    try {
      res = await fetch(new URL("/generate", this.#baseUrl), {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new Ai3dError("TRELLIS_UNAVAILABLE", `could not reach TRELLIS service at ${this.#baseUrl}`, {
        baseUrl: this.#baseUrl,
        cause: e instanceof Error ? e.message : String(e),
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Ai3dError("TRELLIS_GENERATE_FAILED", `TRELLIS returned ${res.status}: ${body.slice(0, 500)}`, {
        status: res.status,
      });
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new Ai3dError("TRELLIS_GENERATE_FAILED", "TRELLIS returned an empty body");
    }
    await writeFile(outGlbPath, buffer);
    log.debug("generated base mesh", { bytes: buffer.byteLength, out: outGlbPath });

    return {
      glbPath: outGlbPath,
      meta: {
        source: "trellis2",
        base_url: this.#baseUrl,
        bytes: buffer.byteLength,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      },
    };
  }
}

/** Returns a fixture GLB; no GPU, no network. For development and CI. */
export class MockTrellisProvider implements TrellisProvider {
  readonly kind = "mock" as const;
  readonly #fixtureGlb: string;

  constructor(fixtureGlb: string) {
    this.#fixtureGlb = fixtureGlb;
  }

  async health(): Promise<boolean> {
    return existsSync(this.#fixtureGlb);
  }

  async generate(_input: GenerateInput, outGlbPath: string): Promise<GenerateResult> {
    if (!existsSync(this.#fixtureGlb)) {
      throw new Ai3dError("TRELLIS_UNAVAILABLE", `mock fixture GLB not found: ${this.#fixtureGlb}`, {
        path: this.#fixtureGlb,
      });
    }
    await writeFile(outGlbPath, await readFile(this.#fixtureGlb));
    return { glbPath: outGlbPath, meta: { source: "mock", fixture: this.#fixtureGlb } };
  }
}

/** Default fixture used by the mock provider when none is configured. */
export function defaultMockGlb(): string {
  return join(paths.fixtures, "trellis", "base.glb");
}

/** Pick a provider from config. Mirrors acquireBackend in the Blender layer. */
export function acquireTrellis(config: Ai3dConfig): TrellisProvider {
  if (config.trellisMode === "mock") {
    return new MockTrellisProvider(config.trellisMockGlb ?? defaultMockGlb());
  }
  return new HttpTrellisProvider(config.trellisUrl, config.trellisTimeoutMs);
}
