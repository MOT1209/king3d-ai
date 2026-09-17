/**
 * Provider selection.
 *
 * The spec stage always uses the agent-in-the-loop provider - turning a
 * reference into a spec is genuine vision work - so there is nothing to
 * configure there. What can change is who answers the review stage, and that
 * is what this factory resolves from config.
 *
 * Every front end (CLI, dashboard routes, MCP server) builds its provider
 * here rather than constructing one directly, so a run behaves the same no
 * matter which of them started it.
 */
import type { Ai3dConfig } from "../core/config.ts";
import { AgentInLoopProvider } from "./agent-in-loop.ts";
import { DeterministicProvider } from "./deterministic.ts";
import type { FileBackedProvider } from "./provider.ts";

/**
 * The provider for a run's prompt directory. Both kinds need the spec
 * provider's file layout, so it is constructed once and shared.
 */
export function createReviewProvider(config: Ai3dConfig, promptDir: string): FileBackedProvider {
  const specProvider = new AgentInLoopProvider({ promptDir });
  if (config.reviewProvider === "deterministic") {
    return new DeterministicProvider({ promptDir, specProvider });
  }
  return specProvider;
}
