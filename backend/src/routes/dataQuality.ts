import { Router } from "express";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";

// GET /api/data-quality — one place that lists what's duplicated or missing across the
// warehouse, regardless of which source it came from. Each check returns a count and a
// handful of examples; the Import page renders it. Checks are plain SQL so adding one is
// a matter of appending to CHECKS.

interface Check {
  id: string;
  title: string;
  severity: "error" | "warning" | "info";
  hint: string;
  sql: string; // must return columns: label (text), detail (text)
}

const CHECKS: Check[] = [
  {
    id: "duplicate_patients",
    title: "Possible duplicate patient charts",
    severity: "warning",
    hint: "Same name and date of birth under different Denticon ids. Lender rows for these people come back as 'ambiguous' until the charts are merged in Denticon.",
    sql: `SELECT string_agg(denticon_patient_id, ', ' ORDER BY denticon_patient_id) AS label,
                 initcap(first_name_key) || ' ' || initcap(last_name_key) || ' · ' || birth_date::text AS detail
            FROM patients
           WHERE last_name_key <> '' AND birth_date IS NOT NULL
           GROUP BY last_name_key, first_name_key, birth_date
          HAVING count(*) > 1`,
  },
  {
    id: "duplicate_applications",
    title: "Possible duplicate applications",
    severity: "warning",
    hint: "Same patient, lender and submitted date under different reference ids. Usually the same application exported twice.",
    sql: `SELECT '#' || fa.id || ' ≈ #' || fa.possible_duplicate_of AS label,
                 fa.lender || ' · ' || fa.submitted_date::text || ' · ' || coalesce(fa.external_id, '(no id)') AS detail
            FROM financing_applications fa
           WHERE fa.possible_duplicate_of IS NOT NULL`,
  },
  {
    id: "cases_multi_funded",
    title: "Cases funded through more than one lender",
    severity: "warning",
    hint: "A patient's round of applications has fundings at two lenders. Either two treatments were grouped into one case (widen/narrow FINANCING_CASE_WINDOW_DAYS or add a request-id column), or it's a genuine split — worth a look.",
    sql: `SELECT 'case #' || fa.case_id AS label, string_agg(DISTINCT fa.lender::text, ', ') || ' · opened ' || min(fa.submitted_date) AS detail
            FROM financing_applications fa JOIN fundings f ON f.application_id = fa.id
           WHERE fa.case_id IS NOT NULL GROUP BY fa.case_id HAVING count(DISTINCT fa.lender) > 1`,
  },
  {
    id: "applications_without_case",
    title: "Applications not grouped into a case",
    severity: "error",
    hint: "Not counted in the funnel's financing stages. Run POST /api/finance/cases/rebuild.",
    sql: `SELECT '#' || id AS label, lender || ' · ' || coalesce(submitted_date::text, 'no date') AS detail
            FROM financing_applications WHERE case_id IS NULL`,
  },
  {
    id: "applications_unknown_tier",
    title: "Applications with unknown prime/subprime tier",
    severity: "warning",
    hint: "The lender runs both programs and the export didn't say which. Excluded from the Prime vs SubPrime filter. Re-import with a Program/Tier column, or if the lender really runs one program, fix it under lenders and run retier.",
    sql: `SELECT '#' || id AS label, lender || ' · ' || coalesce(submitted_date::text, 'no date') || ' · ' || coalesce(external_id, '(no id)') AS detail
            FROM financing_applications WHERE application_type IS NULL`,
  },
  {
    id: "duplicate_locations",
    title: "Locations with the same name",
    severity: "warning",
    hint: "Two location rows share a name — the Practice filter will show it twice. Usually a seeded location next to a Denticon-synced one; reset with `npm run seed -- --reset-only`.",
    sql: `SELECT name AS label, count(*) || ' rows: ids ' || string_agg(id::text, ', ' ORDER BY id) AS detail
            FROM locations GROUP BY lower(name), name HAVING count(*) > 1`,
  },
  {
    id: "applications_unmatched",
    title: "Applications not linked to a patient",
    severity: "warning",
    hint: "Counted in the funnel but can't be filtered by provider or new-patient status. Retried after every Denticon sync.",
    sql: `SELECT '#' || id AS label, lender || ' · ' || coalesce(submitted_date::text, 'no date') || ' · ' || match_status || ': ' || coalesce(match_detail, '') AS detail
            FROM financing_applications WHERE match_status <> 'matched' ORDER BY submitted_date DESC NULLS LAST`,
  },
  {
    id: "applications_no_date",
    title: "Applications with no submitted date",
    severity: "error",
    hint: "Invisible in every date-filtered report and funnel. Fix the export or add the date column.",
    sql: `SELECT '#' || id AS label, lender || ' · ' || status || ' · ' || coalesce(external_id, '(no id)') AS detail
            FROM financing_applications WHERE submitted_date IS NULL`,
  },
  {
    id: "approved_no_amount",
    title: "Approved with no approved amount",
    severity: "info",
    hint: "Approval rate is fine; utilisation % can't be computed for these.",
    sql: `SELECT '#' || id AS label, lender || ' · ' || coalesce(submitted_date::text, 'no date') AS detail
            FROM financing_applications WHERE status = 'approved' AND approved_amount IS NULL`,
  },
  {
    id: "funded_over_approved",
    title: "Funded more than approved",
    severity: "warning",
    hint: "Utilisation over 100% — usually a limit increase the export didn't carry, or swapped columns.",
    sql: `SELECT '#' || fa.id AS label, fa.lender || ' · funded ' || f.funded_amount || ' vs approved ' || fa.approved_amount AS detail
            FROM fundings f JOIN financing_applications fa ON fa.id = f.application_id
           WHERE f.funded_amount > fa.approved_amount`,
  },
  {
    id: "decision_before_submitted",
    title: "Decided before submitted",
    severity: "warning",
    hint: "Decision date earlier than submitted date — likely swapped date columns in the export.",
    sql: `SELECT '#' || id AS label, lender || ' · submitted ' || submitted_date || ', decided ' || decision_date AS detail
            FROM financing_applications WHERE decision_date < submitted_date`,
  },
  {
    id: "patients_missing_fields",
    title: "Patients missing location, provider or first visit",
    severity: "info",
    hint: "Drop out of the corresponding filters. Location/provider gaps usually mean an office or provider outside the key's scope; missing first visit = never seen yet.",
    sql: `SELECT coalesce(denticon_patient_id, 'internal #' || id) AS label,
                 concat_ws(', ', CASE WHEN location_id IS NULL THEN 'no location' END,
                                 CASE WHEN provider_id IS NULL THEN 'no provider' END,
                                 CASE WHEN first_visit_date IS NULL THEN 'no first visit' END) AS detail
            FROM patients WHERE location_id IS NULL OR provider_id IS NULL OR first_visit_date IS NULL`,
  },
  {
    id: "plans_missing_fields",
    title: "Treatment plans missing fee or presented date",
    severity: "info",
    hint: "Fee-less plans contribute $0 to case value; date-less plans never show in the 'treatment presented' stage.",
    sql: `SELECT coalesce('denticon ' || denticon_treat_plan_id::text, 'internal #' || id) AS label,
                 concat_ws(', ', CASE WHEN proposed_fee IS NULL THEN 'no fee' END, CASE WHEN presented_date IS NULL THEN 'no presented date' END) AS detail
            FROM treatment_plans WHERE proposed_fee IS NULL OR presented_date IS NULL`,
  },
  {
    id: "staging_unprocessed",
    title: "Denticon staging rows waiting to be processed",
    severity: "info",
    hint: "Treatment plans whose patient hasn't synced yet, or a sync that stopped before processing. Clears on the next run.",
    sql: `SELECT 'treatment plan ' || denticon_treat_plan_id AS label, 'patient ' || denticon_patient_id || ' not in patients yet' AS detail
            FROM staging_denticon_treatment_plans WHERE processed_at IS NULL
          UNION ALL
          SELECT 'patient ' || denticon_patient_id, 'unprocessed' FROM staging_denticon_patients WHERE processed_at IS NULL`,
  },
  {
    id: "bcp_feed_stale",
    title: "Denticon data download (BCP) feed is stale",
    severity: "warning",
    hint: `No successful BCP load in the last ${env.DENTICON_BCP_STALE_DAYS} day(s). Check the inbox folder, the zip password, and the last load's error via GET /api/bcp/loads. Silent when the feed has never been loaded.`,
    // DENTICON_BCP_STALE_DAYS is zod-validated as a positive integer, so it's safe to inline.
    sql: `SELECT 'last successful load #' || id AS label,
                 to_char(finished_at, 'YYYY-MM-DD HH24:MI') || ' (' || coalesce(file_name, source) || ')' AS detail
            FROM bcp_loads
           WHERE status = 'ok'
             AND NOT EXISTS (SELECT 1 FROM bcp_loads WHERE status = 'ok'
                              AND finished_at >= now() - interval '${env.DENTICON_BCP_STALE_DAYS} days')
           ORDER BY finished_at DESC LIMIT 1`,
  },
  {
    id: "bcp_failed_loads",
    title: "BCP loads that failed",
    severity: "error",
    hint: "The most recent loads that ended in an error (wrong password, unreadable zip, database error). Fix and re-run `npm run bcp:load`; nothing partial is promoted from a failed load.",
    sql: `SELECT 'load #' || id || ' · ' || coalesce(file_name, source) AS label, left(error, 200) AS detail
            FROM bcp_loads WHERE status = 'error' AND started_at > now() - interval '14 days'
           ORDER BY started_at DESC`,
  },
  {
    id: "bcp_unmapped_tables",
    title: "BCP tables landed but not promoted",
    severity: "info",
    hint: "Files in the latest download we have no adapter or column names for. They're kept raw in staging_bcp_rows; add columns/map entries to bcp-feed.json (see docs/denticon-bcp.md) to bring them into the dashboard.",
    sql: `SELECT t->>'table' AS label, coalesce(t->>'blocked', '') || ' · ' || (t->>'rows') || ' rows' AS detail
            FROM (SELECT tables FROM bcp_loads WHERE status = 'ok' ORDER BY finished_at DESC LIMIT 1) l,
                 jsonb_array_elements(l.tables) t
           WHERE (t->>'ignored')::boolean = false AND t->>'blocked' IS NOT NULL`,
  },
];

export const dataQualityRouter = Router();

dataQualityRouter.get("/", async (_req, res, next) => {
  try {
    const results = [];
    for (const c of CHECKS) {
      const { rows } = await pool.query<{ label: string; detail: string }>(`SELECT * FROM (${c.sql}) q LIMIT 1000`);
      results.push({
        id: c.id,
        title: c.title,
        severity: c.severity,
        hint: c.hint,
        count: rows.length,
        examples: rows.slice(0, 10),
      });
    }
    res.json({
      generatedAt: new Date().toISOString(),
      summary: {
        errors: results.filter((r) => r.severity === "error" && r.count).length,
        warnings: results.filter((r) => r.severity === "warning" && r.count).length,
      },
      checks: results,
    });
  } catch (err) {
    next(err);
  }
});
