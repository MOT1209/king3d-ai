/**
 * The deterministic provider.
 *
 * Answers the review stage from measurements alone, spending no model tokens
 * and needing no human: the gate report already carries what a size judgement
 * needs. The spec stage is deliberately NOT automated - turning a photograph
 * into a spec is genuine vision work - so it is delegated to the
 * agent-in-the-loop provider, which writes the request and waits as before.
 *
 * Selecting it keeps the project's core promise ("no API key required") while
 * removing the human from the second of the two stages that needed one. In a
 * run with clean gates it reviews and repairs unattended; only the spec still
 * asks for a judgement.
 */
import { Ai3dError } from "../core/errors.ts";
import { createLogger } from "../core/logger.ts";
import { computeDeterministicVerdict, type DeterministicReviewInput } from "../pipeline/deterministic-review.ts";
import type { GateResult } from "../pipeline/gates.ts";
import { type FileBackedProvider, type ModelProvider, type VisionRequest } from "./provider.ts";

const log = createLogger("provider:deterministic");

export interface DeterministicProviderOptions {
  /** Present so the review verdict can be written alongside the request for
   *  auditability, matching where the agent-in-loop provider keeps its files. */
  promptDir: string;
  /** Used for the spec stage, which this provider does not automate. */
  specProvider: FileBackedProvider;
}

interface ReviewContext {
  failed_gates?: unknown;
  measured_scores?: unknown;
  components?: unknown;
}

/**
 * Pull the measurements the review request already carries into the shape the
 * computation wants. Every field is optional on the wire; a missing one yields
 * a conservative verdict rather than a crash.
 */
function reviewInputFromContext(context: ReviewContext | undefined): DeterministicReviewInput {
  const failedGates = Array.isArray(context?.failed_gates)
    ? (context!.failed_gates as GateResult[]).filter((g) => g && typeof g === "object")
    : [];

  const scores = (context?.measured_scores as { overall?: unknown } | undefined) ?? {};
  const overall = typeof scores.overall === "number" ? scores.overall : 0;

  const components = Array.isArray(context?.components)
    ? (context!.components as Array<{ id: string; rotation_deg?: number[] }>).filter(
        (c): c is { id: string; rotation_deg?: number[] } => typeof c?.id === "string",
      )
    : [];

  return { failedGates, overallScore: overall, components };
}

export class DeterministicProvider implements ModelProvider {
  readonly name = "deterministic";
  readonly #options: DeterministicProviderOptions;

  constructor(options: DeterministicProviderOptions) {
    this.#options = options;
  }

  async ask<T>(request: VisionRequest<T>): Promise<T> {
    if (request.stage !== "review") {
      // Only the review stage is automated here. Everything else - in practice
      // the spec stage - still needs a judgement, so it goes to the human.
      return this.#options.specProvider.ask(request);
    }

    const input = reviewInputFromContext(request.context as ReviewContext | undefined);
    const { verdict, basis } = computeDeterministicVerdict(input);
    log.info(`deterministic review verdict: ${verdict.verdict} (similarity ${verdict.similarity})`, {
      basis,
      defects: verdict.defects.length,
    });

    // The verdict must satisfy the same schema a human's answer would. This is
    // a defence against this provider and the review vocabulary drifting apart.
    const parsed = request.schema.safeParse(verdict);
    if (!parsed.success) {
      throw new Ai3dError(
        "TOOL_OUTPUT_INVALID",
        `The deterministic review produced a verdict that does not match the ReviewVerdict schema:\n` +
          parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
        { issues: parsed.error.issues },
      );
    }
    return parsed.data as T;
  }

  /** The review's request/response files live where the spec provider keeps
   *  them, so a run's prompts stay in one place regardless of which provider
   *  handled which stage. */
  requestPath(stage: string): string {
    return this.#options.specProvider.requestPath(stage);
  }

  responsePath(stage: string): string {
    return this.#options.specProvider.responsePath(stage);
  }
}
