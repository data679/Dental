import { pool } from "../../db/pool.js";
import { detectDelimiter, parseCsv } from "./csv.js";
import { mapHeaders, normalizeRow, type ColumnMap, type NormalizedApplication, type RowError } from "./columns.js";
import { matchPatient, resolveLocationId } from "./matching.js";

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
  updated: number;
  unmatched: number; // rows imported but not linked to a patient (still counted in the funnel)
  rejected: number; // rows that could not be normalised (listed in errors)
  errors: RowError[];
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batch = await client.query<{ id: number }>(
      `INSERT INTO financing_import_batches (source_file, imported_by, row_count, column_map)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.sourceFile, input.importedBy ?? null, parsed.rows.length, JSON.stringify(map.byHeader)],
    );
    const batchId = Number(batch.rows[0]!.id);

    const counts = { inserted: 0, updated: 0, unmatched: 0, rejected: 0 };
    const errors: RowError[] = [];

    for (let i = 0; i < parsed.rows.length; i++) {
      const rowNumber = i + 1;
      const result = normalizeRow(parsed.rows[i]!, parsed.headers, map, rowNumber);
      const staged = await client.query<{ id: number }>(
        `INSERT INTO staging_financing_csv (raw, normalized, source_file, imported_by, batch_id, row_number)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [JSON.stringify(result.raw), result.ok ? JSON.stringify(result.record) : null, input.sourceFile, input.importedBy ?? null, batchId, rowNumber],
      );
      const stagingRowId = Number(staged.rows[0]!.id);

      if (!result.ok) {
        counts.rejected += 1;
        errors.push(result.error);
        await client.query("UPDATE staging_financing_csv SET processed_at = now(), outcome = 'rejected', outcome_detail = $2 WHERE id = $1", [stagingRowId, result.error.message]);
        continue;
      }

      const outcome = await upsertApplication(client, result.record, stagingRowId);
      if (outcome.inserted) counts.inserted += 1;
      else counts.updated += 1;
      if (outcome.match.status !== "matched") counts.unmatched += 1;
      await client.query(
        "UPDATE staging_financing_csv SET processed_at = now(), outcome = $2, outcome_detail = $3 WHERE id = $1",
        [stagingRowId, outcome.inserted ? "inserted" : "updated", `${outcome.match.status}: ${outcome.match.detail}`],
      );
    }

    await client.query(
      `UPDATE financing_import_batches
         SET inserted = $2, updated = $3, unmatched = $4, rejected = $5, errors = $6
       WHERE id = $1`,
      [batchId, counts.inserted, counts.updated, counts.unmatched, counts.rejected, JSON.stringify(errors)],
    );
    await client.query("COMMIT");

    return {
      batchId,
      rowCount: parsed.rows.length,
      ...counts,
      errors,
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
        match_status, match_detail, staging_row_id)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (dedupe_key) DO UPDATE SET
       patient_id = COALESCE(EXCLUDED.patient_id, financing_applications.patient_id),
       application_type = EXCLUDED.application_type,
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
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [patientId, rec.lender, rec.applicationType, rec.status, rec.submittedDate, rec.decisionDate, rec.approvedAmount, rec.requestedAmount, rec.declineReason, locationId, rec.externalId, rec.dedupeKey, match.status, match.detail, stagingRowId],
  );
  const applicationId = Number(rows[0].id);
  const inserted = Boolean(rows[0].inserted);

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
  return { applicationId, inserted, match };
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
      matched += 1;
    } else if (m.detail) {
      await pool.query("UPDATE financing_applications SET match_status = $2, match_detail = $3 WHERE id = $1", [r.id, m.status, m.detail]);
    }
  }
  return { checked: rows.length, matched };
}
