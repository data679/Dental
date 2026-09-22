import { pool } from "../../db/pool.js";
import { detectDelimiter, parseCsv } from "./csv.js";
import {
  DEFAULT_LENDER_TIERS,
  describeTiers,
  mapHeaders,
  normalizeRow,
  type ColumnMap,
  type LenderTierConfig,
  type NormalizedApplication,
  type RowError,
  type RowWarning,
} from "./columns.js";
import type { Lender } from "../../types/domain.js";
import { matchPatient, resolveLocationId } from "./matching.js";
import { env } from "../../config/env.js";
import { nameKey } from "./columns.js";

// Financing CSV intake: parse → map headers → normalise rows → land every row in
// staging_financing_csv (raw + normalised) → upsert applications/fundings → record the
// batch. Runs inline in the request so the uploader sees the outcome immediately; files
// are small. Re-importing the same file is safe: rows upsert on the lender's external id,
// or on a stable dedupe key when there isn't one.

export interface ImportInput {
  csvText: string;
  sourceFile: string;
  importedBy?: string;
}

export interface ImportResult {
  batchId: number;
  rowCount: number;
  inserted: number;
  updated: number; // an application already on file (earlier import) was refreshed
  unmatched: number; // rows imported but not linked to a patient (still counted in the funnel)
  duplicates: number; // repeated within this file — skipped, first occurrence kept
  rejected: number; // rows that could not be normalised (listed in errors)
  errors: RowError[];
  /** Imported, but something looked off: contradictions, missing dates, possible duplicates. */
  warnings: RowWarning[];
  /** File-level observations (missing optional columns) — not per row. */
  notes: string[];
  columnMap: ColumnMap["byHeader"];
  unmappedHeaders: string[];
  missingRequired: string[];
}

export class ImportValidationError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ImportValidationError";
  }
}

export async function importFinancingCsv(input: ImportInput): Promise<ImportResult> {
  const text = input.csvText;
  if (!text.trim()) throw new ImportValidationError("The file is empty.");
  const parsed = parseCsv(text, detectDelimiter(text));
  if (parsed.headers.length === 0) throw new ImportValidationError("No header row found.");
  if (parsed.rows.length === 0) throw new ImportValidationError("The file has a header row but no data rows.");

  const map = mapHeaders(parsed.headers);
  const missingRequired = (["lender", "status"] as const).filter((c) => map.byColumn[c] === undefined);
  if (missingRequired.length) {
    throw new ImportValidationError(`Missing required column(s): ${missingRequired.join(", ")}`, {
      headers: parsed.headers,
      columnMap: map.byHeader,
      unmappedHeaders: map.unmapped,
      missingRequired,
    });
  }

  const lenderTiers = await loadLenderTiers();
  const notes = fileNotes(map);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batch = await client.query<{ id: number }>(
      `INSERT INTO financing_import_batches (source_file, imported_by, row_count, column_map)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.sourceFile, input.importedBy ?? null, parsed.rows.length, JSON.stringify(map.byHeader)],
    );
    const batchId = Number(batch.rows[0]!.id);

    const counts = { inserted: 0, updated: 0, unmatched: 0, duplicates: 0, rejected: 0 };
    const errors: RowError[] = [];
    const warnings: RowWarning[] = [];
    const seenKeys = new Map<string, number>(); // dedupe key → first row number in this file
    const unknownTierByLender = new Map<Lender, number>();

    for (let i = 0; i < parsed.rows.length; i++) {
      const rowNumber = i + 1;
      const result = normalizeRow(parsed.rows[i]!, parsed.headers, map, rowNumber, { lenderTiers });
      const staged = await client.query<{ id: number }>(
        `INSERT INTO staging_financing_csv (raw, normalized, source_file, imported_by, batch_id, row_number)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [JSON.stringify(result.raw), result.ok ? JSON.stringify(result.record) : null, input.sourceFile, input.importedBy ?? null, batchId, rowNumber],
      );
      const stagingRowId = Number(staged.rows[0]!.id);

      if (!result.ok) {
        counts.rejected += 1;
        errors.push(result.error);
        warnings.push(...result.warnings);
        await client.query("UPDATE staging_financing_csv SET processed_at = now(), outcome = 'rejected', outcome_detail = $2 WHERE id = $1", [stagingRowId, result.error.message]);
        continue;
      }

      // Same application twice in one file: keep the first, flag the rest. (Across files
      // the same key is an intentional refresh and counts as "updated".)
      const firstRow = seenKeys.get(result.record.dedupeKey);
      if (firstRow !== undefined) {
        counts.duplicates += 1;
        const msg = `duplicate of row ${firstRow} (${result.record.externalId ? `application ${result.record.externalId}` : "same lender, patient and date"}) — skipped`;
        warnings.push({ row: rowNumber, message: msg });
        await client.query("UPDATE staging_financing_csv SET processed_at = now(), outcome = 'duplicate', outcome_detail = $2 WHERE id = $1", [stagingRowId, msg]);
        continue;
      }
      seenKeys.set(result.record.dedupeKey, rowNumber);
      warnings.push(...result.warnings);
      if (result.record.applicationTypeSource === "unknown") {
        unknownTierByLender.set(result.record.lender, (unknownTierByLender.get(result.record.lender) ?? 0) + 1);
      }

      const outcome = await upsertApplication(client, result.record, stagingRowId);
      if (outcome.inserted) counts.inserted += 1;
      else counts.updated += 1;
      if (outcome.match.status !== "matched") counts.unmatched += 1;
      if (outcome.possibleDuplicateOf) {
        warnings.push({ row: rowNumber, message: `possible duplicate of application #${outcome.possibleDuplicateOf} (same patient, lender and submitted date, different id) — imported and flagged` });
      }
      await client.query(
        "UPDATE staging_financing_csv SET processed_at = now(), outcome = $2, outcome_detail = $3 WHERE id = $1",
        [stagingRowId, outcome.inserted ? "inserted" : "updated", `${outcome.match.status}: ${outcome.match.detail}`],
      );
    }

    // Lenders that run both programs need the export to say which — say so once per lender.
    for (const [lender, n] of unknownTierByLender) {
      const hasColumn = map.byColumn.application_type !== undefined;
      notes.push(
        `${n} ${lender} application${n === 1 ? "" : "s"} imported with tier unknown: ${lender} is configured as ${describeTiers(lenderTiers[lender])} and ` +
          (hasColumn
            ? "the tier column was blank or unrecognised on those rows (see the row warnings)."
            : "the file has no prime/subprime column.") +
          " They're excluded from the Prime vs SubPrime filter until a file states their tier.",
      );
    }

    await client.query(
      `UPDATE financing_import_batches
         SET inserted = $2, updated = $3, unmatched = $4, rejected = $5, errors = $6, duplicates = $7, warnings = $8
       WHERE id = $1`,
      [batchId, counts.inserted, counts.updated, counts.unmatched, counts.rejected, JSON.stringify(errors), counts.duplicates, JSON.stringify(warnings)],
    );
    await client.query("COMMIT");

    return {
      batchId,
      rowCount: parsed.rows.length,
      ...counts,
      errors,
      warnings,
      notes,
      columnMap: map.byHeader,
      unmappedHeaders: map.unmapped,
      missingRequired: [],
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Tier configuration from the `lenders` table, falling back to the built-in defaults. */
export async function loadLenderTiers(): Promise<LenderTierConfig> {
  const cfg: LenderTierConfig = { ...DEFAULT_LENDER_TIERS };
  const { rows } = await pool.query<{ code: Lender; offers_prime: boolean; offers_subprime: boolean }>(
    "SELECT code, offers_prime, offers_subprime FROM lenders",
  );
  for (const r of rows) cfg[r.code] = { prime: r.offers_prime, subprime: r.offers_subprime };
  return cfg;
}

/** What the file can't tell us at all, said once rather than per row. */
function fileNotes(map: ColumnMap): string[] {
  const has = (c: keyof ColumnMap["byColumn"]) => map.byColumn[c] !== undefined;
  const notes: string[] = [];
  if (!has("submitted_date")) notes.push(has("decision_date") || has("funded_date") ? "No submitted-date column — the decision/funded date is used as the submitted date." : "No date columns — these applications won't appear in any date-filtered report.");
  if (!has("patient_dob") && !has("chart_no") && !has("patient_id")) notes.push("No DOB, chart number or patient id column — patients are matched by name only, which can be ambiguous.");
  if (!has("patient_last_name") && !has("chart_no") && !has("patient_id")) notes.push("No patient identifiers at all — nothing will link to a patient.");
  if (!has("approved_amount")) notes.push("No approved-amount column — utilisation % can't be computed.");
  if (!has("external_id")) notes.push("No application id column — re-imports are de-duplicated by lender + patient + date instead.");
  if (!has("location")) notes.push("No practice/location column — location comes from the matched patient only.");
  if (!has("application_type")) notes.push("No prime/subprime column — tier taken from the lender configuration where the lender runs only one program.");
  return notes;
}

type Db = NonNullable<Parameters<typeof matchPatient>[1]>;

async function upsertApplication(db: Db, rec: NormalizedApplication, stagingRowId: number) {
  const match = await matchPatient(rec, db);
  const patientId = match.status === "matched" ? match.patientId : null;
  const locationId =
    (await resolveLocationId(rec.location, db)) ??
    (patientId ? Number((await db.query("SELECT location_id FROM patients WHERE id = $1", [patientId])).rows[0]?.location_id ?? null) || null : null);

  const { rows } = await db.query(
    `INSERT INTO financing_applications
       (patient_id, treatment_plan_id, lender, application_type, status, submitted_date, decision_date,
        approved_amount, requested_amount, decline_reason, location_id, external_id, dedupe_key,
        match_status, match_detail, staging_row_id, inquiry_type, application_type_source)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (dedupe_key) DO UPDATE SET
       patient_id = COALESCE(EXCLUDED.patient_id, financing_applications.patient_id),
       -- Tier precedence: a value the export stated ('file') is never replaced by one we
       -- derived (lender_only_tier) or by unknown; a derived value never replaces a
       -- file-stated one; unknown never replaces anything.
       application_type = CASE
         WHEN EXCLUDED.application_type_source = 'file' THEN EXCLUDED.application_type
         WHEN financing_applications.application_type_source = 'file' THEN financing_applications.application_type
         ELSE COALESCE(EXCLUDED.application_type, financing_applications.application_type) END,
       application_type_source = CASE
         WHEN EXCLUDED.application_type_source = 'file' THEN 'file'
         WHEN financing_applications.application_type_source = 'file' THEN 'file'
         WHEN EXCLUDED.application_type IS NULL THEN COALESCE(financing_applications.application_type_source, 'unknown')
         ELSE EXCLUDED.application_type_source END,
       status = EXCLUDED.status,
       submitted_date = COALESCE(EXCLUDED.submitted_date, financing_applications.submitted_date),
       decision_date = COALESCE(EXCLUDED.decision_date, financing_applications.decision_date),
       approved_amount = COALESCE(EXCLUDED.approved_amount, financing_applications.approved_amount),
       requested_amount = COALESCE(EXCLUDED.requested_amount, financing_applications.requested_amount),
       decline_reason = COALESCE(EXCLUDED.decline_reason, financing_applications.decline_reason),
       location_id = COALESCE(EXCLUDED.location_id, financing_applications.location_id),
       match_status = CASE WHEN EXCLUDED.patient_id IS NOT NULL THEN EXCLUDED.match_status ELSE financing_applications.match_status END,
       match_detail = CASE WHEN EXCLUDED.patient_id IS NOT NULL THEN EXCLUDED.match_detail ELSE financing_applications.match_detail END,
       staging_row_id = EXCLUDED.staging_row_id,
       inquiry_type = COALESCE(EXCLUDED.inquiry_type, financing_applications.inquiry_type),
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [patientId, rec.lender, rec.applicationType, rec.status, rec.submittedDate, rec.decisionDate, rec.approvedAmount, rec.requestedAmount, rec.declineReason, locationId, rec.externalId, rec.dedupeKey, match.status, match.detail, stagingRowId, rec.inquiryType, rec.applicationTypeSource],
  );
  const applicationId = Number(rows[0].id);
  const inserted = Boolean(rows[0].inserted);

  await assignCase(db, applicationId, { patientId, locationId, submittedDate: rec.submittedDate, externalCaseId: rec.externalCaseId, caseKey: caseKeyFor(rec, patientId) });

  // A second application for the same patient at the same lender on the same day, under
  // a different key, is almost always the same application exported twice with different
  // reference numbers. Import it (it might be real) but flag it for review.
  let possibleDuplicateOf: number | null = null;
  if (patientId && rec.submittedDate) {
    const dup = await db.query(
      `SELECT id FROM financing_applications
        WHERE patient_id = $1 AND lender = $2 AND submitted_date = $3 AND id <> $4
        ORDER BY id LIMIT 1`,
      [patientId, rec.lender, rec.submittedDate, applicationId],
    );
    if (dup.rows[0]) {
      possibleDuplicateOf = Number(dup.rows[0].id);
      await db.query("UPDATE financing_applications SET possible_duplicate_of = $2 WHERE id = $1 AND possible_duplicate_of IS NULL", [applicationId, possibleDuplicateOf]);
    }
  }

  if (rec.fundedDate || rec.fundedAmount) {
    const approved = rec.approvedAmount ?? null;
    const utilization = approved && rec.fundedAmount ? Math.round((rec.fundedAmount / approved) * 10000) / 100 : null;
    await db.query(
      `INSERT INTO fundings (application_id, funded_date, funded_amount, utilization_pct)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (application_id) DO UPDATE SET
         funded_date = COALESCE(EXCLUDED.funded_date, fundings.funded_date),
         funded_amount = COALESCE(EXCLUDED.funded_amount, fundings.funded_amount),
         utilization_pct = COALESCE(EXCLUDED.utilization_pct, fundings.utilization_pct)`,
      [applicationId, rec.fundedDate, rec.fundedAmount, utilization],
    );
  }
  return { applicationId, inserted, match, possibleDuplicateOf };
}

/** Identity a case groups on: the patient when matched, else the applicant as written in the file. */
function caseKeyFor(rec: Pick<NormalizedApplication, "patientLastName" | "patientFirstName" | "patientDob" | "patientId" | "chartNo">, patientId: number | null): string {
  if (patientId) return `patient:${patientId}`;
  if (rec.patientId) return `denticon:${rec.patientId}`;
  if (rec.chartNo) return `chart:${rec.chartNo}`;
  return `name:${nameKey(rec.patientLastName)}|${nameKey(rec.patientFirstName)}|${rec.patientDob ?? ""}`;
}

interface CaseTarget {
  patientId: number | null;
  locationId: number | null;
  submittedDate: string | null;
  externalCaseId: string | null;
  caseKey: string;
}

/**
 * Puts an application into a financing case: the export's explicit request id if it has
 * one, else the same person's existing case whose opened date is within
 * FINANCING_CASE_WINDOW_DAYS of this submission, else a new case. Extends the case's
 * opened_date backwards if this application is earlier.
 */
export async function assignCase(db: Db, applicationId: number, t: CaseTarget): Promise<number> {
  const window = env.FINANCING_CASE_WINDOW_DAYS;
  let caseId: number | null = null;

  if (t.externalCaseId) {
    const { rows } = await db.query("SELECT id FROM financing_cases WHERE case_key = $1 AND external_case_id = $2", [t.caseKey, t.externalCaseId]);
    caseId = rows[0] ? Number(rows[0].id) : null;
  }
  if (caseId === null && t.submittedDate) {
    const { rows } = await db.query(
      `SELECT c.id FROM financing_cases c
        WHERE c.case_key = $1 AND c.external_case_id IS NULL
          AND c.opened_date IS NOT NULL
          AND abs(c.opened_date - $2::date) <= $3
          AND NOT EXISTS (SELECT 1 FROM financing_applications x WHERE x.case_id = c.id AND x.id = $4)
        ORDER BY abs(c.opened_date - $2::date), c.id LIMIT 1`,
      [t.caseKey, t.submittedDate, window, applicationId],
    );
    caseId = rows[0] ? Number(rows[0].id) : null;
  }
  if (caseId === null) {
    // No dated case in range. Adopt an undated case for the same person if one exists
    // (a dateless row imported earlier), or — for a dateless row — the person's most
    // recent case, rather than creating one case per row.
    const { rows } = await db.query(
      t.submittedDate
        ? "SELECT id FROM financing_cases WHERE case_key = $1 AND external_case_id IS NULL AND opened_date IS NULL ORDER BY id DESC LIMIT 1"
        : "SELECT id FROM financing_cases WHERE case_key = $1 AND external_case_id IS NULL ORDER BY opened_date DESC NULLS FIRST, id DESC LIMIT 1",
      [t.caseKey],
    );
    caseId = rows[0] ? Number(rows[0].id) : null;
  }
  if (caseId === null) {
    const { rows } = await db.query(
      `INSERT INTO financing_cases (patient_id, case_key, external_case_id, location_id, opened_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [t.patientId, t.caseKey, t.externalCaseId, t.locationId, t.submittedDate],
    );
    caseId = Number(rows[0].id);
  } else {
    await db.query(
      `UPDATE financing_cases
          SET opened_date = LEAST(opened_date, $2::date),
              location_id = COALESCE(location_id, $3),
              patient_id = COALESCE(patient_id, $4),
              updated_at = now()
        WHERE id = $1`,
      [caseId, t.submittedDate, t.locationId, t.patientId],
    );
  }

  const { rows: prev } = await db.query("SELECT case_id FROM financing_applications WHERE id = $1", [applicationId]);
  const previousCase = prev[0]?.case_id ? Number(prev[0].case_id) : null;
  await db.query("UPDATE financing_applications SET case_id = $2 WHERE id = $1", [applicationId, caseId]);
  if (previousCase && previousCase !== caseId) await deleteCaseIfEmpty(db, previousCase);
  return caseId;
}

/**
 * Drops every case and regroups all applications from scratch, oldest first. Use after
 * changing FINANCING_CASE_WINDOW_DAYS or after a migration that introduced cases.
 * Idempotent; safe to run any time (cases hold no data of their own).
 */
export async function rebuildCases(): Promise<{ applications: number; cases: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE financing_applications SET case_id = NULL");
    await client.query("DELETE FROM financing_cases");
    const { rows } = await client.query<{
      id: number; patient_id: number | null; location_id: number | null; submitted_date: string | null; normalized: NormalizedApplication | null;
    }>(
      `SELECT fa.id, fa.patient_id, fa.location_id, fa.submitted_date::text AS submitted_date, s.normalized
         FROM financing_applications fa
         LEFT JOIN staging_financing_csv s ON s.id = fa.staging_row_id
        ORDER BY fa.submitted_date NULLS LAST, fa.id`,
    );
    for (const r of rows) {
      const n = r.normalized;
      await assignCase(client, Number(r.id), {
        patientId: r.patient_id ? Number(r.patient_id) : null,
        locationId: r.location_id ? Number(r.location_id) : null,
        submittedDate: r.submitted_date,
        externalCaseId: n?.externalCaseId ?? null,
        caseKey: caseKeyFor(
          n ?? { patientLastName: null, patientFirstName: null, patientDob: null, patientId: null, chartNo: null },
          r.patient_id ? Number(r.patient_id) : null,
        ),
      });
    }
    const { rows: [c] } = await client.query("SELECT count(*)::int AS n FROM financing_cases");
    await client.query("COMMIT");
    return { applications: rows.length, cases: c.n };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function deleteCaseIfEmpty(db: Db, caseId: number) {
  await db.query("DELETE FROM financing_cases c WHERE c.id = $1 AND NOT EXISTS (SELECT 1 FROM financing_applications WHERE case_id = c.id)", [caseId]);
}

/**
 * Re-attempts patient matching for applications that couldn't be linked at import time —
 * typically because the patient hadn't been synced from Denticon yet. Called after every
 * Denticon processing run and from POST /api/finance/rematch.
 */
export async function rematchUnmatchedApplications(): Promise<{ checked: number; matched: number }> {
  const { rows } = await pool.query<{ id: number; normalized: NormalizedApplication | null }>(
    `SELECT fa.id, s.normalized
       FROM financing_applications fa
       LEFT JOIN staging_financing_csv s ON s.id = fa.staging_row_id
      WHERE fa.match_status <> 'matched'`,
  );
  let matched = 0;
  for (const r of rows) {
    if (!r.normalized) continue;
    const m = await matchPatient(r.normalized);
    if (m.status === "matched") {
      await pool.query(
        `UPDATE financing_applications
            SET patient_id = $2, match_status = 'matched', match_detail = $3,
                location_id = COALESCE(location_id, (SELECT location_id FROM patients WHERE id = $2)),
                updated_at = now()
          WHERE id = $1`,
        [r.id, m.patientId, m.detail],
      );
      // Now that we know who this is, regroup it with the patient's other applications.
      const { rows: app } = await pool.query("SELECT submitted_date::text AS submitted_date, location_id FROM financing_applications WHERE id = $1", [r.id]);
      await assignCase(pool, r.id, {
        patientId: m.patientId,
        locationId: app[0]?.location_id ? Number(app[0].location_id) : null,
        submittedDate: app[0]?.submitted_date ?? null,
        externalCaseId: r.normalized.externalCaseId ?? null,
        caseKey: `patient:${m.patientId}`,
      });
      matched += 1;
    } else if (m.detail) {
      await pool.query("UPDATE financing_applications SET match_status = $2, match_detail = $3 WHERE id = $1", [r.id, m.status, m.detail]);
    }
  }
  return { checked: rows.length, matched };
}
