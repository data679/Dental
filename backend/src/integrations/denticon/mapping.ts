import type { TreatmentPlanStatus } from "../../types/domain.js";
import type { DenticonPatient, DenticonTreatmentPlanItem } from "./types.js";

// Pure Denticon → domain mapping. Kept separate from the sync job so the rules are easy
// to read, unit test, and revisit once the open questions in docs/data-model.md are
// settled (especially "what counts as a new patient").

/**
 * Denticon plan status → our 3-state enum.
 *   A (Accepted)                       → accepted
 *   U (Unaccepted), R (Referred Out)   → declined
 *   D (Diagnosed), H (Hold), L (Alt.)  → presented   (proposed but not decided)
 * Anything unknown is treated as "presented" so a new Denticon code never drops a plan
 * from the funnel; it's logged by the caller.
 */
export function mapTreatPlanStatus(code: string | null | undefined): TreatmentPlanStatus {
  switch ((code ?? "").trim().toUpperCase()) {
    case "A":
      return "accepted";
    case "U":
    case "R":
      return "declined";
    default:
      return "presented";
  }
}

/** `2026-09-01T14:03:00Z` / `2026-09-01` → `2026-09-01`; null/garbage → null. */
export function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export interface MappedPatient {
  denticonPatientId: string;
  denticonOfficeId: number;
  denticonProviderId: number | null;
  source: string | null;
  firstVisitDate: string | null;
  /** Matching keys for lender imports (financing exports identify patients by name + DOB). */
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null;
  chartNo: string | null;
}

export function mapPatient(p: DenticonPatient): MappedPatient {
  return {
    denticonPatientId: String(p.patientId),
    denticonOfficeId: Number(p.officeId),
    denticonProviderId: p.preferredProviderId ?? null,
    // Referral type code is the closest thing Denticon has to "marketing source". The
    // human-readable description comes from /practices/v0/referral-types; the sync job
    // resolves it when available and falls back to the code.
    source: p.refTypeCode?.trim() || null,
    firstVisitDate: toDateOnly(p.firstVisitDate),
    firstName: p.firstName?.trim() || null,
    lastName: p.lastName?.trim() || null,
    birthDate: toDateOnly(p.birthDate),
    chartNo: p.chartNo?.trim() || null,
  };
}

export interface MappedTreatmentPlan {
  denticonTreatPlanId: number;
  denticonPatientId: string;
  status: TreatmentPlanStatus;
  /** Comma-separated distinct procedure codes across the plan's items. */
  procedureCode: string | null;
  /** Sum of item fees. */
  proposedFee: number | null;
  presentedDate: string | null;
  acceptedDate: string | null;
  completedDate: string | null;
  itemCount: number;
  completedItemCount: number;
}

/**
 * Collapses Denticon's item-level rows (one per procedure) into one record per
 * treatment plan, which is the grain our `treatment_plans` table uses.
 */
export function rollUpTreatmentPlan(items: DenticonTreatmentPlanItem[]): MappedTreatmentPlan {
  if (items.length === 0) throw new Error("rollUpTreatmentPlan: no items");
  const head = items[0]!;

  const codes = new Set<string>();
  let fee = 0;
  let hasFee = false;
  let completed = 0;
  let presented: string | null = null;
  let accepted: string | null = null;
  let finished: string | null = null;

  for (const it of items) {
    if (it.procedureCode) codes.add(it.procedureCode.trim());
    if (typeof it.fee === "number") {
      fee += it.fee;
      hasFee = true;
    }
    if (it.isCompleted) completed += 1;
    presented = minDate(presented, toDateOnly(it.treatPlanProposedDate) ?? toDateOnly(it.createdOn));
    accepted = minDate(accepted, toDateOnly(it.acceptedDateTime));
    finished = maxDate(finished, toDateOnly(it.treatPlanFinishDate));
  }

  // A plan counts as completed only when every item is; the finish date is the latest
  // item finish date, which is what "treatment completed" means for the funnel.
  const allDone = completed === items.length;

  return {
    denticonTreatPlanId: head.treatPlanId,
    denticonPatientId: String(head.patientId),
    status: mapTreatPlanStatus(head.treatPlanStatus),
    procedureCode: codes.size ? [...codes].sort().join(",") : null,
    proposedFee: hasFee ? Math.round(fee * 100) / 100 : null,
    presentedDate: presented,
    acceptedDate: accepted,
    completedDate: allDone ? finished : null,
    itemCount: items.length,
    completedItemCount: completed,
  };
}

/** Groups item rows by treatPlanId, preserving first-seen order. */
export function groupTreatmentPlanItems(
  items: Iterable<DenticonTreatmentPlanItem>,
): Map<number, DenticonTreatmentPlanItem[]> {
  const byPlan = new Map<number, DenticonTreatmentPlanItem[]>();
  for (const it of items) {
    const list = byPlan.get(it.treatPlanId);
    if (list) list.push(it);
    else byPlan.set(it.treatPlanId, [it]);
  }
  return byPlan;
}

function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
