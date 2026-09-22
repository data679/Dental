import { pool } from "../db/pool.js";
import type {
  FinanceFilters,
  FinanceSummary,
  PracticeRow,
  Lender,
  LenderCount,
  LenderRate,
  MultiLenderSummary,
  PeriodStat,
} from "../types/domain.js";

// "New patient" = completed a first visit (patients.new_patient_flag is generated from
// first_visit_date, migration 0009). "New in this period" = that first visit falls inside
// the report's date range — which is what the Patient Type → New Patients toggle means for
// the lender charts: applications from patients who became patients during the period.
// $1/$2 are always the period bounds in the queries that use this.
const NEW_IN_PERIOD = "p.first_visit_date >= $1 AND p.first_visit_date <= $2";

// Defaults to the last 30 days when no range is given, so there's always a well-defined
// "prior period" (the same-length window immediately before it) to compare against.
function resolveDateRange(filters: FinanceFilters): { from: string; to: string } {
  if (filters.dateFrom && filters.dateTo) {
    return { from: filters.dateFrom, to: filters.dateTo };
  }
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function priorPeriod(from: string, to: string): { from: string; to: string } {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const lengthMs = toDate.getTime() - fromDate.getTime();
  const priorTo = new Date(fromDate.getTime() - 1); // day before current period starts
  const priorFrom = new Date(priorTo.getTime() - lengthMs);
  return {
    from: priorFrom.toISOString().slice(0, 10),
    to: priorTo.toISOString().slice(0, 10),
  };
}

function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return Number((((current - prior) / prior) * 100).toFixed(2));
}

interface Range {
  from: string;
  to: string;
}

async function countPatients(
  range: Range,
  filters: FinanceFilters,
  requireApplication: boolean,
): Promise<number> {
  const clauses = ["p.first_visit_date >= $1", "p.first_visit_date <= $2"];
  const params: unknown[] = [range.from, range.to];

  if (filters.locationId !== undefined) {
    params.push(filters.locationId);
    clauses.push(`p.location_id = $${params.length}`);
  }
  // newPatientsOnly is implied: both tiles already count patients by first visit in range.

  // The application must fall in the same period as the first visit — "of the new patients
  // we saw this period, how many applied" (matches the OS Dental report's single date filter).
  const join = requireApplication
    ? "JOIN financing_applications fa ON fa.patient_id = p.id AND fa.submitted_date >= $1 AND fa.submitted_date <= $2"
    : "";

  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT p.id)::text AS count FROM patients p ${join} WHERE ${clauses.join(" AND ")}`,
    params,
  );
  return Number(rows[0]?.count ?? 0);
}

async function periodStat(
  current: Range,
  prior: Range,
  filters: FinanceFilters,
  requireApplication: boolean,
): Promise<PeriodStat> {
  const [currentCount, priorCount] = await Promise.all([
    countPatients(current, filters, requireApplication),
    countPatients(prior, filters, requireApplication),
  ]);
  return { current: currentCount, prior: priorCount, pctChange: pctChange(currentCount, priorCount) };
}

// Applications come from the lender CSV intake (docs/financing-intake.md). Returns []
// rather than a zero-filled row per lender when there's nothing in range, so the UI can
// show an honest "no data yet" state instead of a chart full of zero-height bars.
async function applicationsByLender(range: Range, filters: FinanceFilters): Promise<LenderCount[]> {
  const clauses = ["fa.submitted_date >= $1", "fa.submitted_date <= $2"];
  const params: unknown[] = [range.from, range.to];

  if (filters.locationId !== undefined) {
    params.push(filters.locationId);
    clauses.push(`COALESCE(fa.location_id, p.location_id) = $${params.length}`);
  }
  if (filters.applicationType === "unknown") {
    clauses.push("fa.application_type IS NULL");
  } else if (filters.applicationType !== undefined) {
    params.push(filters.applicationType);
    clauses.push(`fa.application_type = $${params.length}`);
  }
  if (filters.status !== undefined) {
    params.push(filters.status);
    clauses.push(`fa.status = $${params.length}`);
  }
  if (filters.newPatientsOnly) clauses.push(NEW_IN_PERIOD);

  const { rows } = await pool.query<{ lender: LenderCount["lender"]; count: string }>(
    `SELECT fa.lender, count(*)::text AS count
     FROM financing_applications fa
     LEFT JOIN patients p ON p.id = fa.patient_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY fa.lender
     ORDER BY count(*) DESC`,
    params,
  );
  return rows.map((r) => ({ lender: r.lender, count: Number(r.count) }));
}

// Same emptiness caveat as applicationsByLender. Rate = approved / decisioned (approved + declined).
async function approvalRateByLender(range: Range, filters: FinanceFilters): Promise<LenderRate[]> {
  const clauses = [
    "fa.decision_date >= $1",
    "fa.decision_date <= $2",
    "fa.status IN ('approved', 'declined')",
  ];
  const params: unknown[] = [range.from, range.to];

  if (filters.locationId !== undefined) {
    params.push(filters.locationId);
    clauses.push(`COALESCE(fa.location_id, p.location_id) = $${params.length}`);
  }
  if (filters.applicationType === "unknown") {
    clauses.push("fa.application_type IS NULL");
  } else if (filters.applicationType !== undefined) {
    params.push(filters.applicationType);
    clauses.push(`fa.application_type = $${params.length}`);
  }
  if (filters.newPatientsOnly) clauses.push(NEW_IN_PERIOD);

  const { rows } = await pool.query<{ lender: LenderRate["lender"]; approved: string; total: string }>(
    `SELECT fa.lender,
            count(*) FILTER (WHERE fa.status = 'approved')::text AS approved,
            count(*)::text AS total
     FROM financing_applications fa
     LEFT JOIN patients p ON p.id = fa.patient_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY fa.lender`,
    params,
  );
  return rows.map((r) => ({
    lender: r.lender,
    count: Number(r.total),
    rate: Number(((Number(r.approved) / Number(r.total)) * 100).toFixed(1)),
  }));
}

// Multi-lender ("multi-app") view: cases opened in the range, how many lenders each went
// to, and — when a patient had more than one approval to choose from — which lender won.
// "offered" = multi-approved cases where this lender approved; "chosen" = of those, the
// ones funded through this lender. Win rate = chosen / offered.
async function multiLenderSummary(range: Range, filters: FinanceFilters): Promise<MultiLenderSummary> {
  const clauses = ["cs.opened_date >= $1", "cs.opened_date <= $2"];
  const params: unknown[] = [range.from, range.to];
  if (filters.locationId !== undefined) {
    params.push(filters.locationId);
    clauses.push(`cs.location_id = $${params.length}`);
  }
  if (filters.newPatientsOnly) {
    clauses.push("EXISTS (SELECT 1 FROM patients p WHERE p.id = cs.patient_id AND p.first_visit_date >= $1 AND p.first_visit_date <= $2)");
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const { rows: [t] } = await pool.query<{
    cases: string; multi: string; lenders: string; approved: string; multi_approved: string; funded: string;
    funded_from_multi: string; soft: string; hard: string; unknown: string;
  }>(
    `SELECT count(*)::text AS cases,
            count(*) FILTER (WHERE cs.lenders > 1)::text AS multi,
            coalesce(sum(cs.lenders), 0)::text AS lenders,
            count(*) FILTER (WHERE cs.approvals > 0)::text AS approved,
            count(*) FILTER (WHERE cs.approvals > 1)::text AS multi_approved,
            count(*) FILTER (WHERE cs.funded)::text AS funded,
            count(*) FILTER (WHERE cs.funded AND cs.approvals > 1)::text AS funded_from_multi,
            (SELECT count(*) FROM financing_applications fa JOIN financing_case_summary c2 ON c2.case_id = fa.case_id
              WHERE fa.inquiry_type = 'soft' AND c2.case_id IN (SELECT case_id FROM financing_case_summary cs ${where}))::text AS soft,
            (SELECT count(*) FROM financing_applications fa JOIN financing_case_summary c2 ON c2.case_id = fa.case_id
              WHERE fa.inquiry_type = 'hard' AND c2.case_id IN (SELECT case_id FROM financing_case_summary cs ${where}))::text AS hard,
            (SELECT count(*) FROM financing_applications fa JOIN financing_case_summary c2 ON c2.case_id = fa.case_id
              WHERE fa.inquiry_type IS NULL AND c2.case_id IN (SELECT case_id FROM financing_case_summary cs ${where}))::text AS unknown
       FROM financing_case_summary cs ${where}`,
    params,
  );

  const { rows: wins } = await pool.query<{ lender: Lender; offered: string; chosen: string }>(
    `SELECT fa.lender,
            count(DISTINCT cs.case_id)::text AS offered,
            count(DISTINCT cs.case_id) FILTER (WHERE cs.chosen_lender = fa.lender)::text AS chosen
       FROM financing_case_summary cs
       JOIN financing_applications fa ON fa.case_id = cs.case_id AND fa.status = 'approved'
      ${where} AND cs.approvals > 1
      GROUP BY fa.lender
      ORDER BY count(DISTINCT cs.case_id) DESC, fa.lender::text`,
    params,
  );

  const cases = Number(t?.cases ?? 0);
  return {
    cases,
    multiLenderCases: Number(t?.multi ?? 0),
    avgLendersPerCase: cases ? Number((Number(t?.lenders ?? 0) / cases).toFixed(2)) : null,
    casesApproved: Number(t?.approved ?? 0),
    casesWithMultipleApprovals: Number(t?.multi_approved ?? 0),
    casesFunded: Number(t?.funded ?? 0),
    casesFundedFromMultipleApprovals: Number(t?.funded_from_multi ?? 0),
    inquiries: { soft: Number(t?.soft ?? 0), hard: Number(t?.hard ?? 0), unknown: Number(t?.unknown ?? 0) },
    chosenLenderWhenMultiApproved: wins.map((w) => ({
      lender: w.lender,
      offered: Number(w.offered),
      chosen: Number(w.chosen),
      winRate: Number(w.offered) ? Number(((Number(w.chosen) / Number(w.offered)) * 100).toFixed(1)) : null,
    })),
  };
}

/**
 * One row per practice, matching the column set of the OS Dental Finance Report this is
 * replacing (docs/os-dental-report.md). Definitions were reverse-engineered from a real
 * export and verified arithmetically against all 15 practices:
 *   Approval Rate            = approved ÷ applications   (ALL applications, not just decisioned)
 *   Average Approval Amount  = approval amount ÷ approved
 *   % Collected From Apps    = collected ÷ approval amount
 * Everything cohorts on the application's submitted date, like the source report's single
 * date filter. `totalCollected` needs practice-wide collections from the PMS ledger, which
 * we don't ingest yet — it comes back null rather than guessed.
 */
async function byPractice(range: Range, filters: FinanceFilters): Promise<PracticeRow[]> {
  const params: unknown[] = [range.from, range.to];
  const locationClause = filters.locationId !== undefined ? ` AND l.id = $${params.push(filters.locationId)}` : "";

  const { rows } = await pool.query<Record<string, string | null>>(
    `WITH np AS (
       SELECT p.location_id,
              count(*)::int AS new_patients,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM financing_applications fa
                 WHERE fa.patient_id = p.id AND fa.submitted_date >= $1 AND fa.submitted_date <= $2))::int AS applying
         FROM patients p
        WHERE p.first_visit_date >= $1 AND p.first_visit_date <= $2
        GROUP BY p.location_id
     ),
     apps AS (
       SELECT COALESCE(fa.location_id, p.location_id) AS location_id,
              count(*)::int AS applications,
              count(*) FILTER (WHERE fa.status = 'approved')::int AS approved,
              count(*) FILTER (WHERE fa.status = 'declined')::int AS declined,
              coalesce(sum(fa.approved_amount) FILTER (WHERE fa.status = 'approved'), 0)::float AS approval_amount,
              coalesce(sum(f.funded_amount), 0)::float AS collected
         FROM financing_applications fa
         LEFT JOIN patients p ON p.id = fa.patient_id
         LEFT JOIN fundings f ON f.application_id = fa.id
        WHERE fa.submitted_date >= $1 AND fa.submitted_date <= $2
        GROUP BY 1
     ),
     cs AS (
       SELECT location_id, count(*)::int AS cases,
              count(*) FILTER (WHERE approvals > 0)::int AS cases_approved,
              count(*) FILTER (WHERE funded)::int AS cases_funded
         FROM financing_case_summary
        WHERE opened_date >= $1 AND opened_date <= $2
        GROUP BY location_id
     )
     SELECT l.id::text, l.name,
            coalesce(np.new_patients, 0)::text AS new_patients,
            coalesce(np.applying, 0)::text AS applying,
            coalesce(apps.applications, 0)::text AS applications,
            coalesce(apps.approved, 0)::text AS approved,
            coalesce(apps.declined, 0)::text AS declined,
            coalesce(apps.approval_amount, 0)::text AS approval_amount,
            coalesce(apps.collected, 0)::text AS collected,
            coalesce(cs.cases, 0)::text AS cases,
            coalesce(cs.cases_approved, 0)::text AS cases_approved,
            coalesce(cs.cases_funded, 0)::text AS cases_funded
       FROM locations l
       LEFT JOIN np   ON np.location_id = l.id
       LEFT JOIN apps ON apps.location_id = l.id
       LEFT JOIN cs   ON cs.location_id = l.id
      WHERE true${locationClause}
      ORDER BY coalesce(apps.collected, 0) DESC, l.name`,
    params,
  );

  return rows.map((r) => buildPracticeRow(r.name ?? "", Number(r.id), {
    newPatients: Number(r.new_patients),
    applying: Number(r.applying),
    applications: Number(r.applications),
    approved: Number(r.approved),
    declined: Number(r.declined),
    approvalAmount: Number(r.approval_amount),
    collected: Number(r.collected),
    cases: Number(r.cases),
    casesApproved: Number(r.cases_approved),
    casesFunded: Number(r.cases_funded),
  }));
}

interface PracticeTotals {
  newPatients: number; applying: number; applications: number; approved: number; declined: number;
  approvalAmount: number; collected: number; cases: number; casesApproved: number; casesFunded: number;
}

function buildPracticeRow(name: string, locationId: number | null, t: PracticeTotals): PracticeRow {
  const ratio = (a: number, b: number) => (b > 0 ? Number(((a / b) * 100).toFixed(2)) : null);
  return {
    locationId,
    name,
    newPatients: t.newPatients,
    newPatientsApplying: t.applying,
    pctNewPatientsApplying: ratio(t.applying, t.newPatients),
    applications: t.applications,
    approved: t.approved,
    declined: t.declined,
    /** OS Dental's definition: approved ÷ every application, including pending/withdrawn. */
    approvalRate: ratio(t.approved, t.applications),
    /** approved ÷ (approved + declined) — the rate lenders themselves would quote. */
    approvalRateOfDecisioned: ratio(t.approved, t.approved + t.declined),
    approvalAmount: t.approvalAmount,
    averageApprovalAmount: t.approved > 0 ? Number((t.approvalAmount / t.approved).toFixed(2)) : null,
    collectedFromApps: t.collected,
    pctCollectedFromApps: ratio(t.collected, t.approvalAmount),
    // Practice-wide collections live in the PMS ledger, which we don't ingest yet.
    totalCollected: null,
    pctOfCollectionsFinanced: null,
    cases: t.cases,
    casesApproved: t.casesApproved,
    /** Share of PATIENTS who got financed, which the per-application rate hides under multi-app. */
    caseApprovalRate: ratio(t.casesApproved, t.cases),
    casesFunded: t.casesFunded,
  };
}

function totalPracticeRow(rows: PracticeRow[]): PracticeRow {
  const sum = (f: (r: PracticeRow) => number) => rows.reduce((n, r) => n + f(r), 0);
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

export async function getFinanceSummary(filters: FinanceFilters): Promise<FinanceSummary> {
  const current = resolveDateRange(filters);
  const prior = priorPeriod(current.from, current.to);

  const [newPatients, newPatientsApplying, appsByLender, approvalByLender, multiLender, practices] = await Promise.all([
    periodStat(current, prior, filters, false),
    periodStat(current, prior, filters, true),
    applicationsByLender(current, filters),
    approvalRateByLender(current, filters),
    multiLenderSummary(current, filters),
    byPractice(current, filters),
  ]);

  return {
    filters: { ...filters, dateFrom: current.from, dateTo: current.to },
    newPatients,
    newPatientsApplying,
    pctNewPatientsApplying: {
      current: newPatients.current > 0 ? pctOf(newPatientsApplying.current, newPatients.current) : null,
      prior: newPatients.prior > 0 ? pctOf(newPatientsApplying.prior, newPatients.prior) : null,
    },
    applicationsByLender: appsByLender,
    approvalRateByLender: approvalByLender,
    multiLender,
    byPractice: practices,
    byPracticeTotal: totalPracticeRow(practices),
  };
}

function pctOf(part: number, whole: number): number {
  return Number(((part / whole) * 100).toFixed(2));
}
