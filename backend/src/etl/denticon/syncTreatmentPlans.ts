import { pool } from "../../db/pool.js";
import {
  splitIntoWindows,
  toDenticonDateTime,
  groupTreatmentPlanItems,
  type DenticonClient,
  type DenticonTreatmentPlanItem,
} from "../../integrations/denticon/index.js";
import { getWatermark, recordRun, setWatermark } from "./syncState.js";

// Lands treatment plans in staging_denticon_treatment_plans, one row per plan holding
// *all* of that plan's item rows as a JSON array.
//
// Denticon's office-wide feed is item-level and change-filtered, so a window may only
// contain the items that changed — rolling those up alone would give a wrong fee total
// or completion state. So the office feed is used only to discover which patients have
// plan activity in the window; the complete, current plan set is then fetched per
// patient (GET /clinical/v0/patients/{id}/treatment-plans) and upserted whole. That's one
// extra call per touched patient per run — cheap for incremental syncs, slower for a
// deep backfill, but always correct.

export interface SyncTreatmentPlansOptions {
  officeId: number;
  backfillDays: number;
  now?: Date;
  full?: boolean;
}

export async function syncTreatmentPlansForOffice(
  client: DenticonClient,
  opts: SyncTreatmentPlansOptions,
): Promise<number> {
  const now = opts.now ?? new Date();
  const watermark = opts.full ? null : await getWatermark("treatment_plans", opts.officeId);
  const from = watermark ?? new Date(now.getTime() - opts.backfillDays * 86_400_000);
  const windows = splitIntoWindows(from, now);

  let plansUpserted = 0;
  try {
    for (const w of windows) {
      const touchedPatients = new Set<number>();
      for await (const item of client.listTreatmentPlans({
        OfficeId: opts.officeId,
        LastChangedOn: { DateFrom: toDenticonDateTime(w.from), DateTo: toDenticonDateTime(w.to) },
      })) {
        touchedPatients.add(item.patientId);
      }

      for (const patientId of touchedPatients) {
        const items = await client.listTreatmentPlansByPatient(patientId);
        plansUpserted += await upsertPatientPlans(patientId, opts.officeId, items);
      }

      await setWatermark("treatment_plans", opts.officeId, w.to);
      console.log(
        `[denticon] treatment plans office=${opts.officeId} ${w.from.toISOString().slice(0, 10)}..${w.to.toISOString().slice(0, 10)}: ${touchedPatients.size} patients touched`,
      );
    }
    await recordRun("treatment_plans", opts.officeId, { status: "ok", rows: plansUpserted });
    return plansUpserted;
  } catch (err) {
    await recordRun("treatment_plans", opts.officeId, { status: "error", error: err });
    throw err;
  }
}

async function upsertPatientPlans(
  patientId: number,
  officeId: number,
  items: DenticonTreatmentPlanItem[],
): Promise<number> {
  const byPlan = groupTreatmentPlanItems(items);
  for (const [treatPlanId, planItems] of byPlan) {
    const lastChanged = planItems
      .map((i) => i.lastChangedOn ?? i.modifiedOn ?? i.createdOn ?? null)
      .filter((s): s is string => Boolean(s))
      .sort()
      .at(-1) ?? null;
    await pool.query(
      `INSERT INTO staging_denticon_treatment_plans
         (raw, denticon_patient_id, denticon_treat_plan_id, office_id, last_changed_on)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (denticon_treat_plan_id) DO UPDATE SET
         raw = EXCLUDED.raw,
         denticon_patient_id = EXCLUDED.denticon_patient_id,
         office_id = EXCLUDED.office_id,
         last_changed_on = EXCLUDED.last_changed_on,
         synced_at = now(),
         processed_at = NULL`,
      [JSON.stringify(planItems), String(patientId), treatPlanId, officeId, lastChanged],
    );
  }
  return byPlan.size;
}
