import type { Job } from "bullmq";
import { pool } from "../../db/pool.js";

// Stub: pulls patient/treatment-plan records from Denticon's read-only API and lands them
// in staging_denticon_patients / staging_denticon_treatment_plans as raw JSON. A separate
// processing step (not yet written) upserts staging rows into the core tables once the
// open questions in docs/data-model.md are resolved (esp. "what counts as new patient").
//
// Blocked on: Denticon API access/credentials (see backend/.env.example,
// DENTICON_API_BASE_URL / DENTICON_API_KEY) — nobody has requested access yet.
export async function syncDenticonPatients(_job: Job): Promise<{ inserted: number }> {
  if (!process.env.DENTICON_API_KEY) {
    console.warn("[etl] syncDenticonPatients: no DENTICON_API_KEY set, skipping (stub)");
    return { inserted: 0 };
  }

  // TODO: call Denticon API (https://developer.planetdds.com/), then:
  // await pool.query(
  //   "INSERT INTO staging_denticon_patients (raw, denticon_patient_id) VALUES ($1, $2)",
  //   [rawRecord, rawRecord.patientId],
  // );
  void pool;
  return { inserted: 0 };
}
