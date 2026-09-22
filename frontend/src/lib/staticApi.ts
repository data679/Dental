import type {
  DataQualityReport,
  FinanceFilters,
  FinanceSummary,
  FunnelFilters,
  FunnelSummaryResponse,
  ImportBatch,
  Lender,
  LenderGovernanceResponse,
  LenderOption,
  LocationOption,
  MultiLenderSummary,
  PracticeRow,
  StatusBreakdownRow,
  UnmatchedApplication,
} from "./api";

// Backend-free mode for the GitHub Pages demo. Loads data/snapshot.json (exported by
// `npm run snapshot` in backend/) and recomputes the same numbers the API would return,
// with the same filter semantics as backend/src/services/{funnelService,financeService}.ts.
// Keep the two in step: backend/scripts/verifySnapshotParity.mjs diffs them.

interface Snapshot {
  generatedAt: string;
  note: string;
  locations: LocationOption[];
  lenders?: LenderOption[];
  lenderGovernance?: LenderGovernanceResponse;
  patients: Array<{ id: number; location_id: number | null; provider_id: number | null; first_visit_date: string | null; new_patient_flag: boolean; has_application: boolean }>;
  treatmentPlans: Array<{ id: number; patient_id: number; presented_date: string | null }>;
  treatmentCompletions: Array<{ treatment_plan_id: number; patient_id: number; completed_date: string | null }>;
  cases: Array<{
    id: number; patient_id: number | null; location_id: number | null; provider_id: number | null; opened_date: string | null;
    applications: number; lenders: number; approvals: number; declines: number; pending: number; funded: boolean;
    chosen_lender: Lender | null; lender_list: Lender[] | null; approved_lenders: Lender[] | null; patient_first_visit_date: string | null;
  }>;
  applications: Array<{
    id: number; case_id: number | null; lender: Lender; application_type: "primary" | "subprime" | null; status: string;
    submitted_date: string | null; decision_date: string | null; approved_amount: number | null; location_id: number | null;
    patient_id: number | null; inquiry_type: "soft" | "hard" | null; patient_first_visit_date: string | null;
    status_detail: string | null; outcome_class: "open" | "decided" | "abandoned" | null;
  }>;
  fundings: Array<{ application_id: number; funded_date: string | null; funded_amount: number | null }>;
  imports: ImportBatch[];
  unmatched: UnmatchedApplication[];
  dataQuality: DataQualityReport | null;
}

const FALLBACK_LENDER_LABELS: Record<Lender, string> = {
  care_credit: "CareCredit", alphaeon: "Alphaeon", cherry: "Cherry", proceed: "Proceed", sunbit: "Sunbit",
  hfd: "HFD", covered_care: "Covered Care", fortiva: "Fortiva", access: "Access", eve: "Eve",
};

let cache: Promise<Snapshot> | null = null;
export function loadSnapshot(): Promise<Snapshot> {
  // import.meta.env is Vite-only; the parity script runs this file under plain Node.
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  cache ??= fetch(`${base}data/snapshot.json`).then((r) => {
    if (!r.ok) throw new Error(`snapshot.json missing (${r.status}) — run \`npm run snapshot\` in backend/`);
    return r.json() as Promise<Snapshot>;
  });
  return cache;
}

// SQL `col >= $from AND col <= $to` semantics: a NULL date never satisfies a bound.
const inRange = (d: string | null, from?: string, to?: string) => {
  if (from === undefined && to === undefined) return true;
  if (!d) return false;
  return (from === undefined || d >= from) && (to === undefined || d <= to);
};
const patientById = (s: Snapshot) => new Map(s.patients.map((p) => [p.id, p]));

export async function getLocations(): Promise<LocationOption[]> {
  return (await loadSnapshot()).locations;
}
export async function getLenders(): Promise<LenderOption[]> {
  const s = await loadSnapshot();
  return s.lenders ?? Object.entries(FALLBACK_LENDER_LABELS).map(([code, label]) => ({ code: code as Lender, label, offers_prime: true, offers_subprime: true, active: true }));
}

export async function getFunnelSummary(f: FunnelFilters = {}): Promise<FunnelSummaryResponse> {
  const s = await loadSnapshot();
  const pById = patientById(s);
  const patientOk = (p: Snapshot["patients"][number] | undefined) =>
    !!p && (f.locationId === undefined || p.location_id === f.locationId) && (f.providerId === undefined || p.provider_id === f.providerId);

  const newPatients = s.patients.filter((p) => patientOk(p) && inRange(p.first_visit_date, f.dateFrom, f.dateTo)).length;
  const presented = new Set(s.treatmentPlans.filter((tp) => patientOk(pById.get(tp.patient_id)) && inRange(tp.presented_date, f.dateFrom, f.dateTo)).map((tp) => tp.patient_id)).size;
  const completed = new Set(s.treatmentCompletions.filter((tc) => patientOk(pById.get(tc.patient_id)) && inRange(tc.completed_date, f.dateFrom, f.dateTo)).map((tc) => tc.patient_id)).size;

  const cases = s.cases.filter(
    (c) =>
      (f.locationId === undefined || c.location_id === f.locationId) &&
      (f.providerId === undefined || c.provider_id === f.providerId) &&
      (f.lender === undefined || (c.lender_list ?? []).includes(f.lender as Lender)) &&
      inRange(c.opened_date, f.dateFrom, f.dateTo),
  );
  const lenderSum = cases.reduce((n, c) => n + c.lenders, 0);

  return {
    filters: f,
    stages: [
      { stage: "new_patients", count: newPatients },
      { stage: "treatment_presented", count: presented },
      { stage: "applications_submitted", count: cases.length },
      { stage: "applications_approved", count: cases.filter((c) => c.approvals > 0).length },
      { stage: "funded", count: cases.filter((c) => c.funded).length },
      { stage: "treatment_completed", count: completed },
    ],
    financing: {
      cases: cases.length,
      applications: cases.reduce((n, c) => n + c.applications, 0),
      multiLenderCases: cases.filter((c) => c.lenders > 1).length,
      avgLendersPerCase: cases.length ? Number((lenderSum / cases.length).toFixed(2)) : null,
    },
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function resolveRange(f: FinanceFilters) {
  if (f.dateFrom && f.dateTo) return { from: f.dateFrom, to: f.dateTo };
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: iso(from), to: iso(to) };
}
function priorPeriod(from: string, to: string) {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const lengthMs = toDate.getTime() - fromDate.getTime();
  const priorTo = new Date(fromDate.getTime() - 1);
  const priorFrom = new Date(priorTo.getTime() - lengthMs);
  return { from: iso(priorFrom), to: iso(priorTo) };
}
const pctChange = (cur: number, prior: number) => (prior === 0 ? null : Number((((cur - prior) / prior) * 100).toFixed(2)));
const pctOf = (part: number, whole: number) => Number(((part / whole) * 100).toFixed(2));

export async function getFinanceSummary(f: FinanceFilters = {}): Promise<FinanceSummary> {
  const s = await loadSnapshot();
  const current = resolveRange(f);
  const prior = priorPeriod(current.from, current.to);

  // Mirrors financeService.ts: "new in period" = first visit inside the report range.
  const newInPeriod = (firstVisit: string | null) => inRange(firstVisit, current.from, current.to);
  // The application must fall in the same period as the first visit (mirrors financeService.ts).
  const appliedIn = (r: { from: string; to: string }) =>
    new Set(s.applications.filter((a) => inRange(a.submitted_date, r.from, r.to) && a.patient_id !== null).map((a) => a.patient_id));
  const countPatients = (r: { from: string; to: string }, requireApp: boolean) => {
    const applied = requireApp ? appliedIn(r) : null;
    return s.patients.filter(
      (p) =>
        inRange(p.first_visit_date, r.from, r.to) &&
        (f.locationId === undefined || p.location_id === f.locationId) &&
        (!applied || applied.has(p.id)),
    ).length;
  };
  const stat = (requireApp: boolean) => {
    const cur = countPatients(current, requireApp);
    const pri = countPatients(prior, requireApp);
    return { current: cur, prior: pri, pctChange: pctChange(cur, pri) };
  };
  const newPatients = stat(false);
  const applying = stat(true);

  const appOk = (a: Snapshot["applications"][number]) =>
    (f.locationId === undefined || a.location_id === f.locationId) &&
    (f.applicationType === undefined || (f.applicationType === "unknown" ? a.application_type === null : a.application_type === f.applicationType)) &&
    (!f.newPatientsOnly || newInPeriod(a.patient_first_visit_date));

  const byLender = new Map<Lender, number>();
  for (const a of s.applications) {
    if (!appOk(a) || !inRange(a.submitted_date, current.from, current.to)) continue;
    if (f.status !== undefined && a.status !== f.status) continue;
    byLender.set(a.lender, (byLender.get(a.lender) ?? 0) + 1);
  }
  const applicationsByLender = [...byLender]
    .map(([lender, count]) => ({ lender, count }))
    .sort((a, b) => b.count - a.count || a.lender.localeCompare(b.lender));

  const rate = new Map<Lender, { approved: number; total: number }>();
  for (const a of s.applications) {
    if (!appOk(a) || !inRange(a.decision_date, current.from, current.to)) continue;
    if (a.status !== "approved" && a.status !== "declined") continue;
    const r = rate.get(a.lender) ?? { approved: 0, total: 0 };
    r.total += 1;
    if (a.status === "approved") r.approved += 1;
    rate.set(a.lender, r);
  }
  const approvalRateByLender = [...rate].map(([lender, r]) => ({ lender, count: r.total, rate: Number(((r.approved / r.total) * 100).toFixed(1)) }));

  const cases = s.cases.filter(
    (c) =>
      inRange(c.opened_date, current.from, current.to) &&
      (f.locationId === undefined || c.location_id === f.locationId) &&
      (!f.newPatientsOnly || newInPeriod(c.patient_first_visit_date)),
  );
  const caseIds = new Set(cases.map((c) => c.id));
  const inquiries = { soft: 0, hard: 0, unknown: 0 };
  for (const a of s.applications) {
    if (a.case_id === null || !caseIds.has(a.case_id)) continue;
    inquiries[a.inquiry_type ?? "unknown"] += 1;
  }
  const wins = new Map<Lender, { offered: number; chosen: number }>();
  for (const c of cases) {
    if (c.approvals <= 1) continue;
    for (const l of c.approved_lenders ?? []) {
      const w = wins.get(l) ?? { offered: 0, chosen: 0 };
      w.offered += 1;
      if (c.chosen_lender === l) w.chosen += 1;
      wins.set(l, w);
    }
  }
  const multiLender: MultiLenderSummary = {
    cases: cases.length,
    multiLenderCases: cases.filter((c) => c.lenders > 1).length,
    avgLendersPerCase: cases.length ? Number((cases.reduce((n, c) => n + c.lenders, 0) / cases.length).toFixed(2)) : null,
    casesApproved: cases.filter((c) => c.approvals > 0).length,
    casesWithMultipleApprovals: cases.filter((c) => c.approvals > 1).length,
    casesFunded: cases.filter((c) => c.funded).length,
    casesFundedFromMultipleApprovals: cases.filter((c) => c.funded && c.approvals > 1).length,
    inquiries,
    chosenLenderWhenMultiApproved: [...wins]
      .map(([lender, w]) => ({ lender, offered: w.offered, chosen: w.chosen, winRate: w.offered ? Number(((w.chosen / w.offered) * 100).toFixed(1)) : null }))
      .sort((a, b) => b.offered - a.offered || a.lender.localeCompare(b.lender)),
  };

  const practiceRows = byPractice(s, current, f);

  // Mirrors statusBreakdown() in backend/src/services/financeService.ts: group by
  // (status, detail, outcome class) over applications submitted in the range.
  const breakdown = new Map<string, StatusBreakdownRow>();
  for (const a of s.applications) {
    if (!inRange(a.submitted_date, current.from, current.to)) continue;
    if (f.locationId !== undefined && a.location_id !== f.locationId) continue;
    const key = `${a.status}|${a.status_detail ?? ""}|${a.outcome_class ?? ""}`;
    const row = breakdown.get(key);
    if (row) row.count += 1;
    else
      breakdown.set(key, {
        status: a.status as StatusBreakdownRow["status"],
        statusDetail: a.status_detail,
        outcomeClass: a.outcome_class,
        count: 1,
      });
  }
  const statusBreakdown = [...breakdown.values()].sort(
    (x, y) => y.count - x.count || x.status.localeCompare(y.status) || (x.statusDetail ?? "").localeCompare(y.statusDetail ?? ""),
  );

  return {
    filters: { ...f, dateFrom: current.from, dateTo: current.to },
    newPatients,
    newPatientsApplying: applying,
    pctNewPatientsApplying: {
      current: newPatients.current > 0 ? pctOf(applying.current, newPatients.current) : null,
      prior: newPatients.prior > 0 ? pctOf(applying.prior, newPatients.prior) : null,
    },
    applicationsByLender,
    approvalRateByLender,
    multiLender,
    byPractice: practiceRows,
    byPracticeTotal: totalPracticeRow(practiceRows),
    statusBreakdown,
  };
}

// Mirrors byPractice()/buildPracticeRow() in backend/src/services/financeService.ts.
// Kept in step by backend/scripts/verifySnapshotParity.mjs.
function buildPracticeRow(name: string, locationId: number | null, t: {
  newPatients: number; applying: number; applications: number; approved: number; declined: number;
  approvalAmount: number; collected: number; cases: number; casesApproved: number; casesFunded: number;
}): PracticeRow {
  const ratio = (a: number, b: number) => (b > 0 ? Number(((a / b) * 100).toFixed(2)) : null);
  return {
    locationId, name,
    newPatients: t.newPatients,
    newPatientsApplying: t.applying,
    pctNewPatientsApplying: ratio(t.applying, t.newPatients),
    applications: t.applications,
    approved: t.approved,
    declined: t.declined,
    approvalRate: ratio(t.approved, t.applications),
    approvalRateOfDecisioned: ratio(t.approved, t.approved + t.declined),
    approvalAmount: t.approvalAmount,
    averageApprovalAmount: t.approved > 0 ? Number((t.approvalAmount / t.approved).toFixed(2)) : null,
    collectedFromApps: t.collected,
    pctCollectedFromApps: ratio(t.collected, t.approvalAmount),
    totalCollected: null,
    pctOfCollectionsFinanced: null,
    cases: t.cases,
    casesApproved: t.casesApproved,
    caseApprovalRate: ratio(t.casesApproved, t.cases),
    casesFunded: t.casesFunded,
  };
}

function byPractice(s: Snapshot, range: { from: string; to: string }, f: FinanceFilters): PracticeRow[] {
  const fundedByApp = new Map(s.fundings.map((x) => [x.application_id, x.funded_amount ?? 0]));
  const appliedInRange = new Set(
    s.applications.filter((a) => inRange(a.submitted_date, range.from, range.to) && a.patient_id !== null).map((a) => a.patient_id),
  );
  const rows = s.locations
    .filter((l) => f.locationId === undefined || l.id === f.locationId)
    .map((l) => {
      const np = s.patients.filter((p) => p.location_id === l.id && inRange(p.first_visit_date, range.from, range.to));
      const apps = s.applications.filter((a) => a.location_id === l.id && inRange(a.submitted_date, range.from, range.to));
      const cs = s.cases.filter((c) => c.location_id === l.id && inRange(c.opened_date, range.from, range.to));
      const approved = apps.filter((a) => a.status === "approved");
      return buildPracticeRow(l.name, l.id, {
        newPatients: np.length,
        applying: np.filter((p) => appliedInRange.has(p.id)).length,
        applications: apps.length,
        approved: approved.length,
        declined: apps.filter((a) => a.status === "declined").length,
        approvalAmount: approved.reduce((n, a) => n + (a.approved_amount ?? 0), 0),
        collected: apps.reduce((n, a) => n + (fundedByApp.get(a.id) ?? 0), 0),
        cases: cs.length,
        casesApproved: cs.filter((c) => c.approvals > 0).length,
        casesFunded: cs.filter((c) => c.funded).length,
      });
    });
  return rows.sort((a, b) => b.collectedFromApps - a.collectedFromApps || a.name.localeCompare(b.name));
}

function totalPracticeRow(rows: PracticeRow[]): PracticeRow {
  const sum = (g: (r: PracticeRow) => number) => rows.reduce((n, r) => n + g(r), 0);
  return buildPracticeRow("Total", null, {
    newPatients: sum((r) => r.newPatients),
    applying: sum((r) => r.newPatientsApplying),
    applications: sum((r) => r.applications),
    approved: sum((r) => r.approved),
    declined: sum((r) => r.declined),
    approvalAmount: sum((r) => r.approvalAmount),
    collected: sum((r) => r.collectedFromApps),
    cases: sum((r) => r.cases),
    casesApproved: sum((r) => r.casesApproved),
    casesFunded: sum((r) => r.casesFunded),
  });
}

export async function getImportBatches(): Promise<ImportBatch[]> {
  return (await loadSnapshot()).imports;
}
export async function getUnmatchedApplications(): Promise<UnmatchedApplication[]> {
  return (await loadSnapshot()).unmatched;
}
export async function getLenderGovernance(): Promise<LenderGovernanceResponse> {
  const s = await loadSnapshot();
  if (!s.lenderGovernance) throw new Error("lender governance not in snapshot");
  return s.lenderGovernance;
}

export async function getDataQuality(): Promise<DataQualityReport> {
  const s = await loadSnapshot();
  if (!s.dataQuality) throw new Error("data-quality report not in snapshot");
  return s.dataQuality;
}
export async function snapshotInfo(): Promise<{ generatedAt: string; note: string }> {
  const s = await loadSnapshot();
  return { generatedAt: s.generatedAt, note: s.note };
}
