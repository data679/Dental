import { pool } from "../../db/pool.js";
import {
  splitIntoWindows,
  toDenticonDateTime,
  type DenticonClient,
} from "../../integrations/denticon/index.js";
import { getWatermark, recordRun, setWatermark } from "./syncState.js";

// Lands raw patient records in staging_denticon_patients, one row per Denticon patient
// (upserted, so re-running a window is harmless). Walks LastChangedOn in ≤30-day windows
// from the office's watermark (or the backfill horizon on first run) up to `now`, and
// advances the watermark after each window so an interrupted run resumes where it left off.

export interface SyncPatientsOptions {
  officeId: number;
  backfillDays: number;
  now?: Date;
  /** Ignore the stored watermark and re-walk the whole backfill horizon. */
  full?: boolean;
}

export async function syncPatientsForOffice(
  client: DenticonClient,
  opts: SyncPatientsOptions,
): Promise<number> {
  const now = opts.now ?? new Date();
  const watermark = opts.full ? null : await getWatermark("patients", opts.officeId);
  const from = watermark ?? new Date(now.getTime() - opts.backfillDays * 86_400_000);
  const windows = splitIntoWindows(from, now);

  let total = 0;
  try {
    for (const w of windows) {
      let inWindow = 0;
      for await (const p of client.listPatients({
        OfficeId: opts.officeId,
        LastChangedOn: { DateFrom: toDenticonDateTime(w.from), DateTo: toDenticonDateTime(w.to) },
      })) {
        await pool.query(
          `INSERT INTO staging_denticon_patients (raw, denticon_patient_id, office_id, last_changed_on)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (denticon_patient_id) DO UPDATE SET
             raw = EXCLUDED.raw,
             office_id = EXCLUDED.office_id,
             last_changed_on = EXCLUDED.last_changed_on,
             synced_at = now(),
             processed_at = NULL`,
          [JSON.stringify(p), String(p.patientId), Number(p.officeId), p.lastChangedOn ?? p.modifiedOn ?? null],
        );
        inWindow += 1;
      }
      total += inWindow;
      await setWatermark("patients", opts.officeId, w.to);
      console.log(
        `[denticon] patients office=${opts.officeId} ${w.from.toISOString().slice(0, 10)}..${w.to.toISOString().slice(0, 10)}: ${inWindow} rows`,
      );
    }
    await recordRun("patients", opts.officeId, { status: "ok", rows: total });
    return total;
  } catch (err) {
    await recordRun("patients", opts.officeId, { status: "error", error: err });
    throw err;
  }
}
