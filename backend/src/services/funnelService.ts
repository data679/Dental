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
  if (filters.dateFrom !== undefined) {
    params.push(filters.dateFrom);
    clauses.push(`${opts.table}.created_at >= $${params.length}`);
  }
  if (filters.dateTo !== undefined) {
    params.push(filters.dateTo);
    clauses.push(`${opts.table}.created_at <= $${params.length}`);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

// Stub implementation: counts new patients only, everything else returns 0 until the
// patients/treatment_plans/financing_applications tables have real data (see
// docs/data-model.md — this also depends on resolving "what counts as a new patient").
export async function getFunnelSummary(
  filters: FunnelFilters,
): Promise<FunnelStageSummary[]> {
  const { where, params } = buildFilterClause(filters, { table: "patients" });

  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM patients ${where}`,
    params,
  );
  const newPatients = Number(rows[0]?.count ?? 0);

  return [
    { stage: "new_patients", count: newPatients },
    { stage: "treatment_presented", count: 0 },
    { stage: "applications_submitted", count: 0 },
    { stage: "applications_approved", count: 0 },
    { stage: "funded", count: 0 },
    { stage: "treatment_completed", count: 0 },
  ];
}
