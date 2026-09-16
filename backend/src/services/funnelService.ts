import { pool } from "../db/pool.js";
import type { FunnelFilters, FunnelStageSummary } from "../types/domain.js";

// Builds a WHERE clause fragment + params for the filters that apply to a given base
// table alias. Not every filter applies to every stage (e.g. `lender` only makes sense
// once we're joined to financing_applications), so each query below picks what it needs.
function buildFilterClause(
  filters: FunnelFilters,
  opts: { table: string; hasLender?: boolean },
): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.locationId !== undefined) {
    params.push(filters.locationId);
    clauses.push(`${opts.table}.location_id = $${params.length}`);
  }
  if (filters.providerId !== undefined) {
    params.push(filters.providerId);
    clauses.push(`${opts.table}.provider_id = $${params.length}`);
  }
  if (opts.hasLender && filters.lender !== undefined) {
    params.push(filters.lender);
    clauses.push(`lender = $${params.length}`);
  }
  // Dates filter on first_visit_date for patients (matches financeService and what the
  // seed data actually varies) rather than created_at, which just reflects insert time.
  const dateColumn = opts.table === "patients" ? "first_visit_date" : "created_at";
  if (filters.dateFrom !== undefined) {
    params.push(filters.dateFrom);
    clauses.push(`${opts.table}.${dateColumn} >= $${params.length}`);
  }
  if (filters.dateTo !== undefined) {
    params.push(filters.dateTo);
    clauses.push(`${opts.table}.${dateColumn} <= $${params.length}`);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

// New patients, treatment presented and treatment completed count distinct patients from
// the Denticon-fed tables; the three financing stages count applications from the lender
// CSV intake (docs/financing-intake.md).
export async function getFunnelSummary(
  filters: FunnelFilters,
): Promise<FunnelStageSummary[]> {
  const patientsClause = buildFilterClause(filters, { table: "patients" });
  const { rows: np } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM patients ${patientsClause.where}`,
    patientsClause.params,
  );

  // Location/provider filters apply through the patient; the date range applies to the
  // stage's own date (when the plan was presented / when treatment finished).
  const stageClause = (dateColumn: string) => {
    const { where, params } = buildFilterClause(
      { locationId: filters.locationId, providerId: filters.providerId },
      { table: "p" },
    );
    const clauses = where ? [where.replace(/^WHERE /, "")] : [];
    if (filters.dateFrom !== undefined) {
      params.push(filters.dateFrom);
      clauses.push(`${dateColumn} >= $${params.length}`);
    }
    if (filters.dateTo !== undefined) {
      params.push(filters.dateTo);
      clauses.push(`${dateColumn} <= $${params.length}`);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  };

  const presented = stageClause("tp.presented_date");
  const { rows: tpRows } = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT tp.patient_id)::text AS count
       FROM treatment_plans tp JOIN patients p ON p.id = tp.patient_id
       ${presented.where}`,
    presented.params,
  );

  const completed = stageClause("tc.completed_date");
  const { rows: tcRows } = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT tp.patient_id)::text AS count
       FROM treatment_completions tc
       JOIN treatment_plans tp ON tp.id = tc.treatment_plan_id
       JOIN patients p ON p.id = tp.patient_id
       ${completed.where}`,
    completed.params,
  );

  // Financing stages are a cohort of applications *submitted* in the range: how many of
  // those were approved, and how many of those funded. Same date basis for all three
  // keeps the funnel monotonic. Location comes from the application itself when the
  // lender named it, else from the matched patient; the provider filter can only apply
  // through a matched patient, so unmatched applications drop out under that filter.
  const financing = financingClause(filters);
  const { rows: faRows } = await pool.query<{ submitted: string; approved: string; funded: string }>(
    `SELECT count(*)::text AS submitted,
            count(*) FILTER (WHERE fa.status = 'approved')::text AS approved,
            count(f.id)::text AS funded
       FROM financing_applications fa
       LEFT JOIN patients p ON p.id = fa.patient_id
       LEFT JOIN fundings f ON f.application_id = fa.id
       ${financing.where}`,
    financing.params,
  );

  return [
    { stage: "new_patients", count: Number(np[0]?.count ?? 0) },
    { stage: "treatment_presented", count: Number(tpRows[0]?.count ?? 0) },
    { stage: "applications_submitted", count: Number(faRows[0]?.submitted ?? 0) },
    { stage: "applications_approved", count: Number(faRows[0]?.approved ?? 0) },
    { stage: "funded", count: Number(faRows[0]?.funded ?? 0) },
    { stage: "treatment_completed", count: Number(tcRows[0]?.count ?? 0) },
  ];
}

function financingClause(filters: FunnelFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.locationId !== undefined) {
    params.push(filters.locationId);
    clauses.push(`COALESCE(fa.location_id, p.location_id) = $${params.length}`);
  }
  if (filters.providerId !== undefined) {
    params.push(filters.providerId);
    clauses.push(`p.provider_id = $${params.length}`);
  }
  if (filters.lender !== undefined) {
    params.push(filters.lender);
    clauses.push(`fa.lender = $${params.length}`);
  }
  if (filters.dateFrom !== undefined) {
    params.push(filters.dateFrom);
    clauses.push(`fa.submitted_date >= $${params.length}`);
  }
  if (filters.dateTo !== undefined) {
    params.push(filters.dateTo);
    clauses.push(`fa.submitted_date <= $${params.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}
