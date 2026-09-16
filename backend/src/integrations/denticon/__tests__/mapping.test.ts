import { describe, expect, it } from "vitest";
import { groupTreatmentPlanItems, mapPatient, mapTreatPlanStatus, rollUpTreatmentPlan } from "../mapping.js";
import { splitIntoWindows } from "../dateWindows.js";
import type { DenticonTreatmentPlanItem } from "../types.js";

describe("mapTreatPlanStatus", () => {
  it("maps Denticon codes onto the funnel's 3-state enum", () => {
    expect(mapTreatPlanStatus("A")).toBe("accepted");
    expect(mapTreatPlanStatus("U")).toBe("declined");
    expect(mapTreatPlanStatus("R")).toBe("declined");
    for (const c of ["D", "H", "L", "", undefined, "zzz"]) expect(mapTreatPlanStatus(c)).toBe("presented");
  });
});

describe("mapPatient", () => {
  it("keeps only what the funnel needs and normalises dates", () => {
    const m = mapPatient({
      pgId: 1,
      patientId: 4000157,
      officeId: 101,
      firstName: "Test",
      lastName: "Patient",
      preferredProviderId: 55,
      refTypeCode: " WEB ",
      firstVisitDate: "2026-08-03T17:00:00Z",
    });
    expect(m).toEqual({
      denticonPatientId: "4000157",
      denticonOfficeId: 101,
      denticonProviderId: 55,
      source: "WEB",
      firstVisitDate: "2026-08-03",
      firstName: "Test",
      lastName: "Patient",
      birthDate: null,
      chartNo: null,
    });
  });
});

const item = (over: Partial<DenticonTreatmentPlanItem>): DenticonTreatmentPlanItem => ({
  patientId: 1,
  treatPlanId: 10,
  treatPlanStatus: "A",
  ...over,
});

describe("rollUpTreatmentPlan", () => {
  it("collapses item rows into one plan: fee sum, distinct codes, dates, completion", () => {
    const plan = rollUpTreatmentPlan([
      item({ procedureCode: "D2740", fee: 1200, treatPlanProposedDate: "2026-07-01", acceptedDateTime: "2026-07-05T10:00:00Z", isCompleted: true, treatPlanFinishDate: "2026-08-01" }),
      item({ procedureCode: "D2740", fee: 1200, treatPlanProposedDate: "2026-07-01", isCompleted: true, treatPlanFinishDate: "2026-08-15" }),
      item({ procedureCode: "D0120", fee: 60.5, treatPlanProposedDate: "2026-06-28", isCompleted: true, treatPlanFinishDate: "2026-07-20" }),
    ]);
    expect(plan).toMatchObject({
      denticonTreatPlanId: 10,
      denticonPatientId: "1",
      status: "accepted",
      procedureCode: "D0120,D2740",
      proposedFee: 2460.5,
      presentedDate: "2026-06-28",
      acceptedDate: "2026-07-05",
      completedDate: "2026-08-15",
      itemCount: 3,
      completedItemCount: 3,
    });
  });

  it("is not completed until every item is", () => {
    const plan = rollUpTreatmentPlan([
      item({ isCompleted: true, treatPlanFinishDate: "2026-08-01" }),
      item({ isCompleted: false }),
    ]);
    expect(plan.completedDate).toBeNull();
    expect(plan.completedItemCount).toBe(1);
  });

  it("groups by plan id", () => {
    const groups = groupTreatmentPlanItems([item({ treatPlanId: 1 }), item({ treatPlanId: 2 }), item({ treatPlanId: 1 })]);
    expect([...groups.keys()]).toEqual([1, 2]);
    expect(groups.get(1)).toHaveLength(2);
  });
});

describe("splitIntoWindows", () => {
  it("splits a long range into abutting ≤30-day windows ending exactly at `to`", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-03-15T12:00:00Z");
    const w = splitIntoWindows(from, to);
    expect(w).toHaveLength(3);
    expect(w[0]!.from).toEqual(from);
    expect(w[0]!.to).toEqual(new Date("2026-01-31T00:00:00Z"));
    expect(w[1]!.from).toEqual(w[0]!.to);
    expect(w[2]!.to).toEqual(to);
    for (const x of w) expect(x.to.getTime() - x.from.getTime()).toBeLessThanOrEqual(30 * 86_400_000);
  });

  it("returns nothing for an empty or inverted range", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    expect(splitIntoWindows(d, d)).toEqual([]);
    expect(splitIntoWindows(new Date(d.getTime() + 1), d)).toEqual([]);
  });
});
