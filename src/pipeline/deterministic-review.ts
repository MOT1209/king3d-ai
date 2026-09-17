/**
 * Deterministic review: a verdict derived from measurements alone, no model.
 *
 * The review stage exists because "does the render match the reference" needs
 * eyes. But once the build has run, most of what a review would report is
 * already measured: the proportions gate knows which components are the wrong
 * size, and it knows both what the spec asked for and what was actually built.
 * That is enough to decide and to repair without consulting anything external.
 *
 * This module turns the measurements a review request already carries into a
 * ReviewVerdict. It is pure: same measurements in, same verdict out, which keeps
 * it testable without Blender and keeps the repair loop auditable - a change in
 * the verdict always traces to a change in the measurements.
 *
 * The one judgement it deliberately does not make is visual similarity to a
 * reference photograph. The similarity number it returns is a mechanical proxy
 * (size fidelity plus the gate-derived overall score), and the observations text
 * says so. A pixel-based signal can be added later as an additional input; the
 * verdict shape it feeds is already fixed here.
 */
import type { GateResult } from "./gates.ts";
import type { Defect, ReviewVerdict } from "./review.ts";

export interface DeterministicReviewInput {
  /** Gates that failed. The proportions gate's data carries the offenders. */
  failedGates: GateResult[];
  /** The build's gate-derived overall score, 0-1. Stands in for "how clean is
   *  the model overall" without needing the full gate list. */
  overallScore: number;
  /** Components with their rotation, needed to decide whether a dimensions fix
   *  is frame-safe (see `isAxisAligned`). */
  components: Array<{ id: string; rotation_deg?: number[] }>;
}

export interface DeterministicVerdict {
  verdict: ReviewVerdict;
  /** The two components of the similarity proxy, exposed for the report. */
  basis: { dimension: number; gates: number };
}

/** A component is close enough to unrotated that local and world dimensions
 *  describe the same box, so a dimensions repair is geometrically safe.
 *  A rotated part's world dimensions are a permutation of its local ones;
 *  writing them back would silently change its shape, so those are left to a
 *  human. Most components in practice (bodies, lids, bases) are axis-aligned. */
function isAxisAligned(rotation: number[] | undefined): boolean {
  if (!rotation) return true;
  return rotation.every((angle) => Math.abs(angle) < 0.5);
}

interface ProportionOffender {
  id: string;
  error: number;
  expected: number[];
  measured: number[];
}

/** Read the proportions gate's offenders, tolerating a gate without them. */
function proportionOffenders(gates: GateResult[]): ProportionOffender[] {
  const proportions = gates.find((g) => g.id === "proportions");
  if (!proportions?.data) return [];
  const offenders = (proportions.data as { offenders?: unknown })["offenders"];
  if (!Array.isArray(offenders)) return [];
  return offenders.filter(
    (o): o is ProportionOffender =>
      typeof o === "object" &&
      o !== null &&
      "id" in o &&
      "error" in o &&
      "expected" in o &&
      "measured" in o &&
      Array.isArray((o as ProportionOffender).expected) &&
      Array.isArray((o as ProportionOffender).measured),
  );
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function computeDeterministicVerdict(input: DeterministicReviewInput): DeterministicVerdict {
  const { failedGates, components } = input;
  const byId = new Map(components.map((c) => [c.id, c]));
  const offenders = proportionOffenders(failedGates);

  const defects: Defect[] = [];

  // --- proportions: the one gate whose data is a machine-applicable fix ----
  // The build measured a size the spec did not ask for. The spec is meant to
  // describe the shipped artifact, so the repair records what was actually
  // built; the next build then measures within tolerance.
  for (const offender of offenders) {
    const component = byId.get(offender.id);
    const safe = component ? isAxisAligned(component.rotation_deg) : false;
    const problem =
      `${offender.id} is built at ${offender.measured.map((m) => m.toFixed(3)).join(" x ")} m, ` +
      `but the spec asks for ${offender.expected.map((m) => m.toFixed(3)).join(" x ")} m ` +
      `(relative error ${(offender.error * 100).toFixed(0)}%).` +
      (safe ? "" : " No automatic fix: the component is rotated, so its world dimensions are not in its local frame.");
    defects.push({
      id: `proportions_${offender.id}`,
      severity: "P0",
      component: offender.id,
      problem,
      fix: safe
        ? {
            path: `components.${offender.id}.dimensions_m.value`,
            value: offender.measured,
            reason: `deterministic reconciliation: record the size the build actually produced`,
          }
        : null,
    });
  }

  // --- every other failed gate: reported, but not auto-repairable ----------
  // These are structural (manifold, missing parts) or budgetary (materials,
  // triangles). None maps onto a value the repair vocabulary can set, so they
  // are surfaced for a human or a later strategy. Severity follows the gate's
  // own: an error-severity failure blocks acceptance (P0), a warning does not
  // (P2) - which mirrors `GateReport.passed`, itself false only when an error
  // gate fails. Proportions reaching here failed without offender data: still
  // P0, still blocking, just without an automatically derived fix.
  for (const gate of failedGates) {
    if (gate.passed) continue;
    if (gate.id === "proportions" && offenders.length > 0) continue;
    defects.push({
      id: gate.id,
      severity: gate.severity === "error" ? "P0" : "P2",
      problem: gate.message,
      fix: null,
    });
  }

  // --- similarity proxy ----------------------------------------------------
  // Size fidelity carries most of the weight: it is the dimension a reviewer
  // would call "the proportions are wrong". The gate-derived overall score
  // stands in for general hygiene (materials, budget, orphans).
  const dimension = offenders.length === 0 ? 1 : clamp01(1 - Math.max(...offenders.map((o) => o.error)));
  const gateScore = clamp01(input.overallScore);
  const similarity = round3(0.65 * dimension + 0.35 * gateScore);

  const p0 = defects.filter((d) => d.severity === "P0");
  const worstError = offenders.length === 0 ? 0 : Math.max(...offenders.map((o) => o.error));
  const verdict: ReviewVerdict = {
    similarity,
    verdict: p0.length > 0 ? "repair" : "accept",
    observations:
      `Deterministic review - no model was consulted. ` +
      `${offenders.length} component(s) outside the size tolerance (worst relative error ${(worstError * 100).toFixed(0)}%), ` +
      `${failedGates.length} gate(s) failed overall. ` +
      (p0.length > 0 ? "Verdict: repair." : "No P0 defects: accept."),
    defects,
  };

  return { verdict, basis: { dimension: round3(dimension), gates: round3(gateScore) } };
}
