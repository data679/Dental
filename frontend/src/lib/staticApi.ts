import type {
  DataQualityReport,
  FinanceFilters,
  FinanceSummary,
  FunnelFilters,
  FunnelSummaryResponse,
  ImportBatch,
  Lender,
  LocationOption,
  MultiLenderSummary,
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
  patients: Array<{ id: number; location_id: number | null; provider_id: number | null; first_visit_date: string | null; new_patient_flag: boolean; has_application: boolean }>;
  treatmentPlans: Array<{ id: number; patient_id: number; presented_date: string | null }>;
  treatmentCompletions: Array<{ treatment_plan_id: number; patient_id: number; completed_date: string | null }>;
  cases: Array<{
    id: number; patient_id: number | null; location_id: number | null; provider_id: number | null; opened_date: string | null;
    applications: number; lenders: number; approvals: number; declines: number; pending: number; funded: boolean;
    chosen_lender: Lender | null; lender_list: Lender[] | null; approved_lenders: Lender[] | null; new_patient: boolean | null;
  }>;
  applications: Array<{
    id: number; case_id: number | null; lender: Lender; application_type: "primary" | "subprime"; status: string;
    submitted_date: string | null; decision_date: string | null; approved_amount: number | null; location_id: number | null;
    patient_id: number | null; inquiry_type: "soft" | "hard" | null; new_patient: boolean | null;
  }>;
  fundings: Array<{ application_id: number; funded_date: string | null; funded_amount: number | null }>;
  imports: ImportBatch[];
  unmatched: UnmatchedApplication[];
  dataQuality: DataQualityReport | null;
}

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

  const countPatients = (r: { from: string; to: string }, requireApp: boolean) =>
    s.patients.filter(
      (p) =>
        inRange(p.first_visit_date, r.from, r.to) &&
        (f.locationId === undefined || p.location_id === f.locationId) &&
        (!f.newPatientsOnly || p.new_patient_flag) &&
        (!requireApp || p.has_application),
    ).length;
  const stat = (requireApp: boolean) => {
    const cur = countPatients(current, requireApp);
    const pri = countPatients(prior, requireApp);
    return { current: cur, prior: pri, pctChange: pctChange(cur, pri) };
  };
  const newPatients = stat(false);
  const applying = stat(true);

  const appOk = (a: Snapshot["applications"][number]) =>
    (f.locationId === undefined || a.location_id === f.locationId) &&
    (f.applicationType === undefined || a.application_type === f.applicationType) &&
    (!f.newPatientsOnly || a.new_patient === true);

  const byLender = new Map<Lender, number>();
  for (const a of s.applications) {
    if (!appOk(a) || !inRange(a.submitted_date, current.from, current.to)) continue;
    if (f.status !== undefined && a.status !== f.status) continue;
    byLender.set(a.lender, (byLender.get(a.lender) ?? 0) + 1);
  }
  const applicationsByLender = [...byLender].map(([lender, count]) => ({ lender, count })).sort((a, b) => b.count - a.count);

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
      (!f.newPatientsOnly || c.new_patient === true),
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
  };
}

export async function getImportBatches(): Promise<ImportBatch[]> {
  return (await loadSnapshot()).imports;
}
export async function getUnmatchedApplications(): Promise<UnmatchedApplication[]> {
  return (await loadSnapshot()).unmatched;
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
