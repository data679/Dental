import { pool } from "../db/pool.js";
import type {
  FinanceFilters,
  FinanceSummary,
  LenderCount,
  LenderRate,
  PeriodStat,
} from "../types/domain.js";

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
  if (filters.newPatientsOnly) {
    clauses.push("p.new_patient_flag = true");
  }

  const join = requireApplication
    ? "JOIN financing_applications fa ON fa.patient_id = p.id"
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

// Empty until financing_applications has real rows — see docs/data-model.md. Returns []
// rather than a zero-filled row per lender, so the UI can show an honest "no data yet"
// state instead of a chart full of zero-height bars.
async function applicationsByLender(range: Range, filters: FinanceFilters): Promise<LenderCount[]> {
  const clauses = ["fa.submitted_date >= $1", "fa.submitted_date <= $2"];
  const params: unknown[] = [range.from, range.to];

  if (filters.locationId !== undefined) {
    params.push(filters.locationId);
    clauses.push(`p.location_id = $${params.length}`);
  }
  if (filters.applicationType !== undefined) {
    params.push(filters.applicationType);
    clauses.push(`fa.application_type = $${params.length}`);
  }
  if (filters.status !== undefined) {
    params.push(filters.status);
    clauses.push(`fa.status = $${params.length}`);
  }

  const { rows } = await pool.query<{ lender: LenderCount["lender"]; count: string }>(
    `SELECT fa.lender, count(*)::text AS count
     FROM financing_applications fa
     JOIN patients p ON p.id = fa.patient_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY fa.lender
     ORDER BY count(*) DESC`,
    params,
  );
  return rows.map((r) => ({ lender: r.lender, count: Number(r.count) }));
}

// Same emptiness caveat as applicationsByLender.
async function approvalRateByLender(range: Range, filters: FinanceFilters): Promise<LenderRate[]> {
  const clauses = [
    "fa.decision_date >= $1",
    "fa.decision_date <= $2",
    "fa.status IN ('approved', 'declined')",
  ];
  const params: unknown[] = [range.from, range.to];

  if (filters.locationId !== undefined) {
    params.push(filters.locationId);
    clauses.push(`p.location_id = $${params.length}`);
  }
  if (filters.applicationType !== undefined) {
    params.push(filters.applicationType);
    clauses.push(`fa.application_type = $${params.length}`);
  }

  const { rows } = await pool.query<{ lender: LenderRate["lender"]; approved: string; total: string }>(
    `SELECT fa.lender,
            count(*) FILTER (WHERE fa.status = 'approved')::text AS approved,
            count(*)::text AS total
     FROM financing_applications fa
     JOIN patients p ON p.id = fa.patient_id
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

export async function getFinanceSummary(filters: FinanceFilters): Promise<FinanceSummary> {
  const current = resolveDateRange(filters);
  const prior = priorPeriod(current.from, current.to);

  const [newPatients, newPatientsApplying, appsByLender, approvalByLender] = await Promise.all([
    periodStat(current, prior, filters, false),
    periodStat(current, prior, filters, true),
    applicationsByLender(current, filters),
    approvalRateByLender(current, filters),
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
  };
}

function pctOf(part: number, whole: number): number {
  return Number(((part / whole) * 100).toFixed(2));
}
