import { describe, expect, it } from "vitest";
import { classificationHint, CADENCE_DAYS } from "../lenderGovernance.js";

// Pure part of the governance service: turning observed behaviour into a read on the
// prime/subprime question. The DB-backed half is covered in importService.db.test.ts.

const obs = (o: Partial<Parameters<typeof classificationHint>[0]> = {}) => ({
  decisioned: 0, approvalRateOfDecisioned: null, avgApprovedAmount: null, medianApprovedAmount: null,
  unknownTier: 0, statedPrime: 0, statedSubprime: 0, ...o,
});

describe("classificationHint", () => {
  it("trusts the export's own tier column above everything else", () => {
    expect(classificationHint(obs({ statedPrime: 40, statedSubprime: 30 }), true, true)).toMatch(/state both tiers/);
    expect(classificationHint(obs({ statedPrime: 120 }), true, false)).toMatch(/state prime on 120 of 120/);
    expect(classificationHint(obs({ statedSubprime: 60 }), false, true)).toMatch(/state subprime on 60 of 60/);
  });

  it("does not let a handful of odd rows reclassify a lender, but does mention them", () => {
    const h = classificationHint(obs({ statedPrime: 178, statedSubprime: 1 }), true, false);
    expect(h).toMatch(/state prime on 178 of 179/);
    expect(h).toMatch(/1 row says the opposite/);
    expect(h).not.toMatch(/runs both programs/);
    // A real minority is different: 30 of 200 is a second program, not a typo.
    expect(classificationHint(obs({ statedPrime: 170, statedSubprime: 30 }), true, false)).toMatch(/runs both programs/);
  });

  it("flags a lender configured for both that has only ever shown one tier", () => {
    expect(classificationHint(obs({ statedPrime: 129 }), true, true)).toMatch(/No subprime row has been seen yet/);
    expect(classificationHint(obs({ statedSubprime: 94 }), true, true)).toMatch(/No prime row has been seen yet/);
  });

  it("falls back to behaviour only with enough decided applications", () => {
    expect(classificationHint(obs({ decisioned: 5 }), true, true)).toMatch(/Not enough decided applications/);
    // Approves most people for small amounts → second-look shape.
    expect(classificationHint(obs({ decisioned: 200, approvalRateOfDecisioned: 72, medianApprovedAmount: 1500 }), false, true))
      .toMatch(/second-look program/);
    // Declines most, approves large limits → prime shape.
    expect(classificationHint(obs({ decisioned: 200, approvalRateOfDecisioned: 22, medianApprovedAmount: 7000 }), true, false))
      .toMatch(/prime program/);
    // In between: say so rather than guess.
    expect(classificationHint(obs({ decisioned: 200, approvalRateOfDecisioned: 48, medianApprovedAmount: 4000 }), true, true))
      .toMatch(/not clear-cut/);
  });
});

describe("CADENCE_DAYS", () => {
  it("only schedules the cadences that have a period", () => {
    expect(CADENCE_DAYS.weekly).toBe(7);
    expect(CADENCE_DAYS.monthly).toBe(31);
    for (const c of ["unset", "none", "on_request"]) expect(CADENCE_DAYS[c]).toBeNull();
  });
});
