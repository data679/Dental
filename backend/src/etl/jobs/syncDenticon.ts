import type { Job } from "bullmq";
import { env } from "../../config/env.js";
import { getDenticonClient, isDenticonConfigured } from "../../integrations/denticon/index.js";
import { syncReferenceData } from "../denticon/syncReference.js";
import { syncPatientsForOffice } from "../denticon/syncPatients.js";
import { syncTreatmentPlansForOffice } from "../denticon/syncTreatmentPlans.js";
import { processDenticonStaging } from "../denticon/processStaging.js";
import { recordRun } from "../denticon/syncState.js";

export interface SyncDenticonPayload {
  /** `incremental` (default) resumes from each office's watermark; `full` re-walks the backfill horizon. */
  mode?: "incremental" | "full";
  /** Restrict to these Denticon office ids (defaults to DENTICON_OFFICE_IDS, else all offices). */
  officeIds?: number[];
  /** Skip the staging → core step (useful when debugging the landing side). */
  skipProcessing?: boolean;
}

export interface SyncDenticonResult {
  offices: number[];
  patientsLanded: number;
  treatmentPlansLanded: number;
  processed: { patients: number; treatmentPlans: number; treatmentPlansDeferred: number } | null;
  skipped?: string;
}

// Pulls offices/providers/referral types, then patients and treatment plans per office
// from the Denticon REST API into staging, then promotes staging rows into the core
// tables. Safe to re-run: every write is an upsert keyed on Denticon ids and progress is
// tracked per (entity, office) in denticon_sync_state.
export async function syncDenticon(job: Job<SyncDenticonPayload>): Promise<SyncDenticonResult> {
  const data = job.data ?? {};
  if (!isDenticonConfigured()) {
    console.warn("[etl] syncDenticon: DENTICON_SUBSCRIPTION_KEY not set, skipping");
    return { offices: [], patientsLanded: 0, treatmentPlansLanded: 0, processed: null, skipped: "not configured" };
  }

  const client = getDenticonClient();
  const full = data.mode === "full";

  let ref;
  try {
    ref = await syncReferenceData(client);
    await recordRun("reference", 0, { status: "ok", rows: ref.offices.length });
  } catch (err) {
    await recordRun("reference", 0, { status: "error", error: err });
    throw err;
  }

  const requested = data.officeIds?.length ? data.officeIds : env.DENTICON_OFFICE_IDS;
  const offices = requested.length
    ? requested
    : ref.offices.filter((o) => o.active).map((o) => o.officeId);

  let patientsLanded = 0;
  let treatmentPlansLanded = 0;
  const failures: Array<{ officeId: number; error: string }> = [];
  for (const officeId of offices) {
    // One office failing (403 out of scope, transient 5xx after retries) must not stop the
    // others; its error is recorded in denticon_sync_state and re-raised at the end.
    try {
      patientsLanded += await syncPatientsForOffice(client, {
        officeId,
        backfillDays: env.DENTICON_BACKFILL_DAYS,
        full,
      });
      treatmentPlansLanded += await syncTreatmentPlansForOffice(client, {
        officeId,
        backfillDays: env.DENTICON_BACKFILL_DAYS,
        full,
      });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      console.error(`[denticon] office ${officeId} failed: ${message}`);
      failures.push({ officeId, error: message });
    }
  }

  // Whatever did land gets promoted, even if some offices failed.
  const processed = data.skipProcessing ? null : await processDenticonStaging(ref);

  if (failures.length) {
    throw new Error(
      `Denticon sync: ${failures.length}/${offices.length} office(s) failed — ` +
        failures.map((f) => `${f.officeId}: ${f.error}`).join("; ") +
        ` (other offices synced: ${patientsLanded} patients, ${treatmentPlansLanded} plans)`,
    );
  }
  return { offices, patientsLanded, treatmentPlansLanded, processed };
}
