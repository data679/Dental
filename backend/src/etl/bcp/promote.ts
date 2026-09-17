import { pool } from "../../db/pool.js";
import type { DenticonPatient, DenticonTreatmentPlanItem } from "../../integrations/denticon/index.js";
import { processDenticonStaging, type ProcessResult } from "../denticon/processStaging.js";
import type { ReferenceData } from "../denticon/syncReference.js";
import { pick, toBool, toInt, toIso, toNum } from "./tables.js";
import type { TableReport } from "./loadService.js";

// staging_bcp_rows → the same staging_denticon_* tables the REST sync lands in, then the
// existing staging → core processor. Reusing that path means BCP and API data obey the
// same mapping rules (status codes, plan roll-up, patient matching for lender rows) and
// the dashboard doesn't know or care which feed a row came from.

export interface PromoteResult {
  offices: number;
  providers: number;
  referralTypes: number;
  patients: number;
  treatmentPlans: number;
  processed: ProcessResult;
}

type Row = { id: number; raw: Record<string, string | null> };

export async function promoteLoad(loadId: number, tables: TableReport[], log: (m: string) => void): Promise<PromoteResult> {
  const promotable = tables.filter((t) => !t.ignored && !t.blocked && t.entity);
  const byEntity = (e: string) => promotable.filter((t) => t.entity === e);

  // Reference data first so patients/plans can resolve office + provider ids.
  let offices = 0;
  for (const t of byEntity("offices")) offices += await promoteOffices(loadId, t);
  let providers = 0;
  for (const t of byEntity("providers")) providers += await promoteProviders(loadId, t);
  const referralDescriptions = new Map<string, string>();
  for (const t of byEntity("referral_types")) {
    for (const r of await currentRows(loadId, t.table)) {
      const v = pick(r.raw, t.mapped);
      if (v.refTypeCode) referralDescriptions.set(v.refTypeCode.trim(), v.refTypeDescription?.trim() || v.refTypeCode.trim());
    }
    await markProcessed(loadId, t.table);
  }

  const ref = await referenceFromDb(referralDescriptions);

  let patients = 0;
  for (const t of byEntity("patients")) patients += await promotePatients(t);

  const headers = byEntity("treatment_plans");
  const items = byEntity("treatment_plan_items");
  const treatmentPlans = items.length || headers.length ? await promoteTreatmentPlans(loadId, headers, items) : 0;

  log(`promoted: ${offices} offices, ${providers} providers, ${patients} patients, ${treatmentPlans} treatment plans → processing`);
  const processed = await processDenticonStaging(ref);
  log(`core: ${processed.patients} patients, ${processed.treatmentPlans} plans (${processed.treatmentPlansDeferred} deferred)`);
  return { offices, providers, referralTypes: referralDescriptions.size, patients, treatmentPlans, processed };
}

// ---- reference --------------------------------------------------------------------

async function promoteOffices(loadId: number, t: TableReport): Promise<number> {
  let n = 0;
  for (const r of await currentRows(loadId, t.table)) {
    const v = pick(r.raw, t.mapped);
    const officeId = toInt(v.officeId);
    if (officeId === null) continue;
    await pool.query(
      `INSERT INTO locations (name, denticon_office_id) VALUES ($1, $2)
       ON CONFLICT (denticon_office_id) DO UPDATE SET name = EXCLUDED.name`,
      [v.officeName?.trim() || `Office ${officeId}`, officeId],
    );
    n += 1;
  }
  await markProcessed(loadId, t.table);
  return n;
}

async function promoteProviders(loadId: number, t: TableReport): Promise<number> {
  const { rows: locs } = await pool.query<{ id: number; denticon_office_id: number }>(
    "SELECT id, denticon_office_id FROM locations WHERE denticon_office_id IS NOT NULL",
  );
  const locationByOffice = new Map(locs.map((l) => [Number(l.denticon_office_id), Number(l.id)]));
  let n = 0;
  let skipped = 0;
  for (const r of await currentRows(loadId, t.table)) {
    const v = pick(r.raw, t.mapped);
    const providerId = toInt(v.providerId);
    const locationId = locationByOffice.get(toInt(v.officeId) ?? -1);
    if (providerId === null || !locationId) {
      skipped += 1;
      continue;
    }
    const base = [v.firstName, v.lastName].filter((s) => s && s.trim()).map((s) => s!.trim()).join(" ");
    const name = (v.title?.trim() ? `${base}, ${v.title.trim()}` : base) || `Provider ${providerId}`;
    await pool.query(
      `INSERT INTO providers (name, location_id, denticon_provider_id, active) VALUES ($1, $2, $3, $4)
       ON CONFLICT (denticon_provider_id) DO UPDATE
         SET name = EXCLUDED.name, location_id = EXCLUDED.location_id, active = EXCLUDED.active`,
      [name, locationId, providerId, toBool(v.active)],
    );
    n += 1;
  }
  if (skipped) console.warn(`[bcp] skipped ${skipped} providers with no id or an unknown office`);
  await markProcessed(loadId, t.table);
  return n;
}

async function referenceFromDb(referralDescriptions: Map<string, string>): Promise<ReferenceData> {
  const [{ rows: locs }, { rows: provs }] = await Promise.all([
    pool.query<{ id: number; denticon_office_id: number; name: string }>(
      "SELECT id, denticon_office_id, name FROM locations WHERE denticon_office_id IS NOT NULL",
    ),
    pool.query<{ id: number; denticon_provider_id: number }>(
      "SELECT id, denticon_provider_id FROM providers WHERE denticon_provider_id IS NOT NULL",
    ),
  ]);
  return {
    locationIdByOffice: new Map(locs.map((l) => [Number(l.denticon_office_id), Number(l.id)])),
    providerIdByDenticon: new Map(provs.map((p) => [Number(p.denticon_provider_id), Number(p.id)])),
    referralDescriptions,
    offices: locs.map((l) => ({ officeId: Number(l.denticon_office_id), name: l.name, active: true })),
  };
}

// ---- patients ---------------------------------------------------------------------

async function promotePatients(t: TableReport): Promise<number> {
  let n = 0;
  let skipped = 0;
  const done: number[] = [];
  const flushDone = async () => {
    if (done.length === 0) return;
    await pool.query("UPDATE staging_bcp_rows SET processed_at = now() WHERE id = ANY($1::bigint[])", [done]);
    done.length = 0;
  };
  for (const r of await unprocessedRows(t.table)) {
    const v = pick(r.raw, t.mapped);
    const patientId = toInt(v.patientId);
    const officeId = toInt(v.officeId);
    if (patientId === null || officeId === null) {
      skipped += 1;
      done.push(r.id);
      continue;
    }
    const p: DenticonPatient = {
      pgId: 0,
      patientId,
      officeId,
      chartNo: v.chartNo,
      firstName: v.firstName ?? "",
      lastName: v.lastName ?? "",
      birthDate: toIso(v.birthDate),
      active: toBool(v.active),
      firstVisitDate: toIso(v.firstVisitDate),
      lastVisitDate: toIso(v.lastVisitDate),
      refTypeCode: v.refTypeCode,
      preferredProviderId: toInt(v.preferredProviderId),
      lastChangedOn: toIso(v.lastChangedOn),
      // Keep the untouched BCP row too, so nothing from the dump is lost at this hop.
      bcp: r.raw,
    };
    await pool.query(
      `INSERT INTO staging_denticon_patients (raw, denticon_patient_id, office_id, last_changed_on, source)
       VALUES ($1, $2, $3, $4, 'bcp')
       ON CONFLICT (denticon_patient_id) DO UPDATE SET
         raw = EXCLUDED.raw, office_id = EXCLUDED.office_id, last_changed_on = EXCLUDED.last_changed_on,
         source = 'bcp', synced_at = now(), processed_at = NULL`,
      [JSON.stringify(p), String(patientId), officeId, p.lastChangedOn],
    );
    done.push(r.id);
    n += 1;
    if (done.length >= 500) await flushDone();
  }
  await flushDone();
  if (skipped) console.warn(`[bcp] skipped ${skipped} patient rows with no patient/office id`);
  return n;
}

// ---- treatment plans --------------------------------------------------------------

async function promoteTreatmentPlans(loadId: number, headers: TableReport[], items: TableReport[]): Promise<number> {
  // Any plan with a new/changed header or item row gets re-rolled from the current
  // snapshot of all its rows (a plan is one staging record holding every item).
  const dirty = new Set<number>();
  const dirtyRowIds: number[] = [];
  for (const t of [...headers, ...items]) {
    for (const r of await unprocessedRows(t.table)) {
      const id = toInt(pick(r.raw, t.mapped).treatPlanId);
      if (id !== null) dirty.add(id);
      dirtyRowIds.push(r.id);
    }
  }
  if (dirty.size === 0) return 0;

  const headerByPlan = new Map<number, Record<string, string | null>>();
  for (const t of headers) {
    for (const r of await currentRows(loadId, t.table)) {
      const v = pick(r.raw, t.mapped);
      const id = toInt(v.treatPlanId);
      if (id !== null && dirty.has(id)) headerByPlan.set(id, v);
    }
  }
  const itemsByPlan = new Map<number, DenticonTreatmentPlanItem[]>();
  for (const t of items) {
    for (const r of await currentRows(loadId, t.table)) {
      const v = pick(r.raw, t.mapped);
      const id = toInt(v.treatPlanId);
      if (id === null || !dirty.has(id)) continue;
      const h = headerByPlan.get(id) ?? {};
      const patientId = toInt(v.patientId ?? h.patientId);
      if (patientId === null) continue;
      const item: DenticonTreatmentPlanItem = {
        patientId,
        treatPlanId: id,
        treatPlanStatus: (v.treatPlanStatus ?? h.treatPlanStatus ?? "") as string,
        treatPlanProposedDate: toIso(v.treatPlanProposedDate ?? h.treatPlanProposedDate),
        acceptedDateTime: toIso(v.acceptedDateTime ?? h.acceptedDateTime),
        treatPlanFinishDate: toIso(v.treatPlanFinishDate ?? h.treatPlanFinishDate),
        providerId: toInt(v.providerId ?? h.providerId),
        procedureCode: v.procedureCode,
        fee: toNum(v.fee),
        isCompleted: isCompletedValue(v.isCompleted, v.treatPlanFinishDate),
        lastChangedOn: toIso(v.lastChangedOn ?? h.lastChangedOn),
        bcp: r.raw,
      };
      const list = itemsByPlan.get(id);
      if (list) list.push(item);
      else itemsByPlan.set(id, [item]);
    }
  }
  // Header-only plans (no item table in the export) still get one synthetic item so the
  // plan reaches the funnel with its status and dates; fee/procedures stay null.
  for (const [id, h] of headerByPlan) {
    if (itemsByPlan.has(id)) continue;
    const patientId = toInt(h.patientId);
    if (patientId === null) continue;
    const finish = toIso(h.treatPlanFinishDate);
    itemsByPlan.set(id, [
      {
        patientId,
        treatPlanId: id,
        treatPlanStatus: h.treatPlanStatus ?? "",
        treatPlanProposedDate: toIso(h.treatPlanProposedDate),
        acceptedDateTime: toIso(h.acceptedDateTime),
        treatPlanFinishDate: finish,
        providerId: toInt(h.providerId),
        isCompleted: finish !== null,
        lastChangedOn: toIso(h.lastChangedOn),
        bcp: h,
      },
    ]);
  }

  let n = 0;
  for (const [id, list] of itemsByPlan) {
    const head = list[0]!;
    await pool.query(
      `INSERT INTO staging_denticon_treatment_plans (raw, denticon_patient_id, denticon_treat_plan_id, office_id, last_changed_on, source)
       VALUES ($1, $2, $3, NULL, $4, 'bcp')
       ON CONFLICT (denticon_treat_plan_id) DO UPDATE SET
         raw = EXCLUDED.raw, denticon_patient_id = EXCLUDED.denticon_patient_id,
         last_changed_on = EXCLUDED.last_changed_on, source = 'bcp', synced_at = now(), processed_at = NULL`,
      [JSON.stringify(list), String(head.patientId), id, head.lastChangedOn ?? null],
    );
    n += 1;
  }
  if (dirtyRowIds.length) {
    await pool.query("UPDATE staging_bcp_rows SET processed_at = now() WHERE id = ANY($1::bigint[])", [dirtyRowIds]);
  }
  return n;
}

function isCompletedValue(flag: string | null, finishDate: string | null): boolean {
  if (flag !== null && flag !== undefined && flag !== "") {
    const s = flag.trim().toLowerCase();
    if (["1", "true", "t", "y", "yes", "c", "completed", "complete", "done", "posted"].includes(s)) return true;
    if (["0", "false", "f", "n", "no", "p", "planned", "open", "pending"].includes(s)) return false;
  }
  return toIso(finishDate) !== null;
}

// ---- staging access ---------------------------------------------------------------

async function unprocessedRows(table: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    "SELECT id, raw FROM staging_bcp_rows WHERE table_name = $1 AND processed_at IS NULL ORDER BY id",
    [table],
  );
  return rows.map((r) => ({ id: Number(r.id), raw: r.raw }));
}

/** Every row of the table as of this load — the current snapshot of the source table. */
async function currentRows(loadId: number, table: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    "SELECT id, raw FROM staging_bcp_rows WHERE table_name = $1 AND last_seen_load_id = $2 ORDER BY id",
    [table, loadId],
  );
  return rows.map((r) => ({ id: Number(r.id), raw: r.raw }));
}

async function markProcessed(loadId: number, table: string): Promise<void> {
  await pool.query(
    "UPDATE staging_bcp_rows SET processed_at = now() WHERE table_name = $1 AND last_seen_load_id = $2 AND processed_at IS NULL",
    [table, loadId],
  );
}
