import { describe, expect, it } from "vitest";
import { computeDeterministicVerdict, type DeterministicReviewInput } from "../src/pipeline/deterministic-review.ts";
import { ReviewVerdict } from "../src/pipeline/review.ts";
import type { GateResult } from "../src/pipeline/gates.ts";

/** A proportions offender as the gate stores it in `data.offenders`. */
function offender(id: string, error: number, expected: number[], measured: number[]): GateResult {
  return {
    id: "proportions",
    passed: false,
    severity: "error",
    message: `${id} exceeds the size tolerance`,
    data: { offenders: [{ id, error, expected, measured }] },
  };
}

function input(failedGates: GateResult[], overallScore = 1, components: DeterministicReviewInput["components"] = [{ id: "body" }]): DeterministicReviewInput {
  return { failedGates, overallScore, components };
}

describe("deterministic review", () => {
  it("accepts a clean build and scores it high", () => {
    const { verdict, basis } = computeDeterministicVerdict(input([], 1));
    expect(verdict.verdict).toBe("accept");
    expect(verdict.defects).toEqual([]);
    expect(verdict.similarity).toBe(1);
    expect(basis).toEqual({ dimension: 1, gates: 1 });
  });

  it("reports a P0 defect and repairs an unrotated component to its measured size", () => {
    const { verdict } = computeDeterministicVerdict(
      input([offender("body", 0.4, [0.08, 0.08, 0.1], [0.08, 0.08, 0.14])], 1, [{ id: "body" }]),
    );

    expect(verdict.verdict).toBe("repair");
    const defect = verdict.defects.find((d) => d.component === "body");
    expect(defect?.severity).toBe("P0");
    // The spec must describe the shipped artifact, so the fix records what was
    // actually built - not what the spec asked for.
    expect(defect?.fix).toEqual({
      path: "components.body.dimensions_m.value",
      value: [0.08, 0.08, 0.14],
      reason: expect.stringContaining("reconciliation"),
    });
  });

  it("proposes no fix for a rotated component, because world dimensions are not local ones", () => {
    const { verdict } = computeDeterministicVerdict(
      input([offender("handle", 0.5, [0.064, 0.064, 0.012], [0.064, 0.064, 0.02])], 1, [
        { id: "handle", rotation_deg: [90, 0, 0] },
      ]),
    );

    expect(verdict.verdict).toBe("repair");
    const defect = verdict.defects.find((d) => d.component === "handle");
    expect(defect?.fix).toBeNull();
    expect(defect?.problem).toContain("rotated");
  });

  it("surfaces other failed gates as defects without machine-applicable fixes", () => {
    const triangle: GateResult = {
      id: "triangle_budget",
      passed: false,
      severity: "warning",
      message: "30000 triangles exceeds the budget of 20000",
    };
    const { verdict } = computeDeterministicVerdict(input([triangle], 0.8));

    expect(verdict.verdict).toBe("accept"); // no P0 proportions defect
    const budget = verdict.defects.find((d) => d.id === "triangle_budget");
    expect(budget?.severity).toBe("P2");
    expect(budget?.fix).toBeNull();
  });

  it("composes similarity as 0.65 * size fidelity + 0.35 * gate score", () => {
    const { verdict, basis } = computeDeterministicVerdict(
      input([offender("body", 0.4, [0.08, 0.08, 0.1], [0.08, 0.08, 0.14])], 0.5),
    );
    // dimension = 1 - 0.4 = 0.6; gates = 0.5
    expect(basis).toEqual({ dimension: 0.6, gates: 0.5 });
    expect(verdict.similarity).toBe(Math.round((0.65 * 0.6 + 0.35 * 0.5) * 1000) / 1000);
  });

  it("produces a verdict that satisfies the ReviewVerdict schema a human answer would", () => {
    const { verdict } = computeDeterministicVerdict(
      input([offender("body", 0.3, [0.08, 0.08, 0.1], [0.08, 0.08, 0.13])], 0.9, [{ id: "body" }]),
    );
    // The provider validates against this schema before returning; keep the
    // computation honest by asserting it here too.
    expect(() => ReviewVerdict.parse(verdict)).not.toThrow();
  });

  it("tolerates a proportions gate with no offender data", () => {
    const { verdict } = computeDeterministicVerdict(
      input([{ id: "proportions", passed: false, severity: "error", message: "tolerance exceeded" }], 1),
    );
    expect(verdict.verdict).toBe("repair");
    expect(verdict.defects[0]?.fix).toBeNull();
  });
});
