/**
 * Model providers.
 *
 * Two things in this pipeline genuinely need eyes: turning a reference image
 * into a spec, and judging whether a render matches that reference. Everything
 * else is arithmetic. This interface is the boundary between the two, so the
 * pipeline never learns which model - or which human - answered.
 */
import type { z } from "zod";

export interface PromptImage {
  path: string;
  label: string;
}

export interface VisionRequest<T> {
  /** Stage name; also the filename stem for file-based providers. */
  stage: string;
  /** What the answer must accomplish, in prose. */
  instruction: string;
  images: PromptImage[];
  /** Input is `unknown` on purpose: answers arrive as untrusted JSON, and the
   *  schema's own defaults mean the parsed output is not the same shape. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Human-readable schema description included in the prompt. */
  schemaHint: string;
  /** Structured facts the answer should take into account. */
  context?: Record<string, unknown>;
}

/**
 * Raised when a provider cannot answer synchronously and has instead written a
 * request for someone to answer. This is a normal control-flow outcome for the
 * agent-in-the-loop provider, not a failure.
 */
export class NeedsModelInput extends Error {
  readonly stage: string;
  readonly requestPath: string;
  readonly responsePath: string;

  constructor(stage: string, requestPath: string, responsePath: string) {
    super(`stage "${stage}" needs a judgement; see ${requestPath}`);
    this.name = "NeedsModelInput";
    this.stage = stage;
    this.requestPath = requestPath;
    this.responsePath = responsePath;
  }
}

export interface ModelProvider {
  readonly name: string;
  /**
   * Answer a visual question, validated against the request's schema.
   * Throws NeedsModelInput when the answer is not available yet.
   */
  ask<T>(request: VisionRequest<T>): Promise<T>;
}
