import { pool } from "../../db/pool.js";
import {
  mapPatient,
  rollUpTreatmentPlan,
  type DenticonPatient,
  type DenticonTreatmentPlanItem,
} from "../../integrations/denticon/index.js";
import type { ReferenceData } from "./syncReference.js";
import { rematchUnmatchedApplications } from "../financing/importService.js";
import { nameKey } from "../financing/columns.js";

// Staging → core. Runs after landing so the dashboard queries (which only read the core
// tables) see Denticon data. Idempotent: keyed on denticon_* ids, and a staging row is
// only stamped processed_at once its core row exists.
//
// Deliberately conservative where docs/data-model.md still has open questions:
//  - patients.new_patient_flag is a generated column (migration 0009): true once the
//    patient has a first_visit_date. Decision: booked-but-never-seen patients are not new
//    patients. Nothing here writes the flag.
//  - treatment_plans.status uses the mapping in integrations/denticon/mapping.ts.

export interface ProcessResult {
  patients: number;
  treatmentPlans: number;
  /** Plans whose patient hasn't been synced yet — left unprocessed for the next run. */
  treatmentPlansDeferred: number;
}

export async function processDenticonStaging(ref: ReferenceData): Promise<ProcessResult> {
  const patients = await processPatients(ref);
  const { processed, deferred } = await processTreatmentPlans();
  // Lender applications imported before their patient existed can now be linked.
  if (patients > 0) {
    const { matched } = await rematchUnmatchedApplications();
    if (matched) console.log(`[denticon] linked ${matched} previously unmatched financing applications`);
  }
  return { patients, treatmentPlans: processed, treatmentPlansDeferred: deferred };
}

async function processPatients(ref: ReferenceData): Promise<number> {
  const { rows } = await pool.query<{ id: number; raw: DenticonPatient }>(
    "SELECT id, raw FROM staging_denticon_patients WHERE processed_at IS NULL ORDER BY id",
  );
  let count = 0;
  for (const row of rows) {
    const m = mapPatient(row.raw);
    const locationId = ref.locationIdByOffice.get(m.denticonOfficeId) ?? null;
    const providerId =
      m.denticonProviderId !== null ? (ref.providerIdByDenticon.get(m.denticonProviderId) ?? null) : null;
    const source = m.source ? (ref.referralDescriptions.get(m.source) ?? m.source) : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO patients (denticon_patient_id, location_id, provider_id, source, first_visit_date, active,
                               first_name, last_name, birth_date, chart_no, first_name_key, last_name_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (denticon_patient_id) DO UPDATE SET
           location_id = EXCLUDED.location_id,
           provider_id = EXCLUDED.provider_id,
           source = EXCLUDED.source,
           first_visit_date = EXCLUDED.first_visit_date,
           active = EXCLUDED.active,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           birth_date = EXCLUDED.birth_date,
           chart_no = EXCLUDED.chart_no,
           first_name_key = EXCLUDED.first_name_key,
           last_name_key = EXCLUDED.last_name_key,
           updated_at = now()`,
        [m.denticonPatientId, locationId, providerId, source, m.firstVisitDate, row.raw.active !== false,
         m.firstName, m.lastName, m.birthDate, m.chartNo, nameKey(m.firstName), nameKey(m.lastName)],
      );
      await client.query("UPDATE staging_denticon_patients SET processed_at = now() WHERE id = $1", [row.id]);
      await client.query("COMMIT");
      count += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return count;
}

async function processTreatmentPlans(): Promise<{ processed: number; deferred: number }> {
  const { rows } = await pool.query<{
    id: number;
    raw: DenticonTreatmentPlanItem[];
    denticon_patient_id: string;
    patient_id: number | null;
  }>(
    `SELECT s.id, s.raw, s.denticon_patient_id, p.id AS patient_id
     FROM staging_denticon_treatment_plans s
     LEFT JOIN patients p ON p.denticon_patient_id = s.denticon_patient_id
     WHERE s.processed_at IS NULL
     ORDER BY s.id`,
  );

  let processed = 0;
  let deferred = 0;
  for (const row of rows) {
    if (row.patient_id === null) {
      deferred += 1;
      continue;
    }
    const items = Array.isArray(row.raw) ? row.raw : [];
    if (items.length === 0) {
      await pool.query("UPDATE staging_denticon_treatment_plans SET processed_at = now() WHERE id = $1", [row.id]);
      continue;
    }
    const plan = rollUpTreatmentPlan(items);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: tp } = await client.query<{ id: number }>(
        `INSERT INTO treatment_plans
           (denticon_treat_plan_id, patient_id, procedure_code, proposed_fee, status, presented_date, accepted_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (denticon_treat_plan_id) DO UPDATE SET
           patient_id = EXCLUDED.patient_id,
           procedure_code = EXCLUDED.procedure_code,
           proposed_fee = EXCLUDED.proposed_fee,
           status = EXCLUDED.status,
           presented_date = EXCLUDED.presented_date,
           accepted_date = EXCLUDED.accepted_date,
           updated_at = now()
         RETURNING id`,
        [
          plan.denticonTreatPlanId,
          row.patient_id,
          plan.procedureCode,
          plan.proposedFee,
          plan.status,
          plan.presentedDate,
          plan.acceptedDate,
        ],
      );
      const treatmentPlanId = Number(tp[0]!.id);

      // treatment_completions has no unique key on treatment_plan_id, so update-or-insert
      // by hand. Case value = the plan's proposed fee until a better production figure
      // (ledger) is wired in.
      if (plan.completedDate) {
        const upd = await client.query(
          `UPDATE treatment_completions SET completed_date = $2, case_value = $3
           WHERE treatment_plan_id = $1`,
          [treatmentPlanId, plan.completedDate, plan.proposedFee],
        );
        if (upd.rowCount === 0) {
          await client.query(
            `INSERT INTO treatment_completions (treatment_plan_id, completed_date, case_value)
             VALUES ($1, $2, $3)`,
            [treatmentPlanId, plan.completedDate, plan.proposedFee],
          );
        }
      } else {
        // Plan went from complete back to incomplete (item re-opened in Denticon).
        await client.query("DELETE FROM treatment_completions WHERE treatment_plan_id = $1", [treatmentPlanId]);
      }

      await client.query("UPDATE staging_denticon_treatment_plans SET processed_at = now() WHERE id = $1", [row.id]);
      await client.query("COMMIT");
      processed += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return { processed, deferred };
}
