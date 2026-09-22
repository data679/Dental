import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DB-backed tests for the BCP loader, against the synthetic download in
// docs/samples/denticon-bcp (regenerate with `npm run bcp:sample`). Skipped unless run via
// `npm run test:db`.

const enabled = process.env.TEST_DB === "1";
const d = describe.skipIf(!enabled);
const SLOW = 120_000;

const sampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../docs/samples/denticon-bcp");
const sampleConfigPath = path.resolve(sampleDir, "..", "denticon-bcp-feed.example.json");

const TRUNCATE = `TRUNCATE treatment_completions, fundings, financing_applications, financing_cases, treatment_plans, patients,
  providers, locations, staging_denticon_patients, staging_denticon_treatment_plans, denticon_sync_state,
  staging_bcp_rows, bcp_loads RESTART IDENTITY CASCADE`;

d("bcp loader (database)", () => {
  let pool: typeof import("../../../db/pool.js").pool;
  let loadFeed: typeof import("../loadService.js").loadFeed;
  let config: import("../tables.js").FeedConfig;
  let work: string;

  beforeAll(async () => {
    ({ pool } = await import("../../../db/pool.js"));
    ({ loadFeed } = await import("../loadService.js"));
    config = JSON.parse(await readFile(sampleConfigPath, "utf8"));
    work = await mkdtemp(path.join(tmpdir(), "bcp-db-test-"));
    await pool.query(TRUNCATE);
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
    await pool?.end();
  });

  const coreSnapshot = async () => {
    const { rows: patients } = await pool.query(
      `SELECT p.denticon_patient_id, l.denticon_office_id, p.first_name, p.last_name, p.birth_date::text, p.chart_no,
              p.first_visit_date::text, p.source, pr.denticon_provider_id, p.active
         FROM patients p JOIN locations l ON l.id = p.location_id LEFT JOIN providers pr ON pr.id = p.provider_id
        ORDER BY p.denticon_patient_id`,
    );
    const { rows: plans } = await pool.query(
      `SELECT tp.denticon_treat_plan_id, p.denticon_patient_id, tp.procedure_code, tp.proposed_fee::text, tp.status,
              tp.presented_date::text, tp.accepted_date::text, tc.completed_date::text, tc.case_value::text
         FROM treatment_plans tp JOIN patients p ON p.id = tp.patient_id
         LEFT JOIN treatment_completions tc ON tc.treatment_plan_id = tp.id
        ORDER BY tp.denticon_treat_plan_id`,
    );
    return { patients, plans };
  };

  it("loads the sample download: every adapter table promoted, unknown table kept raw", async () => {
    const r = await loadFeed(sampleDir, { config, log: () => {} });
    expect(r.status).toBe("ok");
    expect(r.error).toBeNull();
    const byTable = Object.fromEntries(r.tables.map((t) => [t.table, t]));
    // Counts come from the fixture itself (regenerate it with `npm run bcp:sample` and
    // these still hold) — what's asserted is the invariants: a first load inserts every
    // row it read, each adapter table is promoted in full, and the unknown table is not.
    expect(byTable.patient_master).toMatchObject({ entity: "patients", blocked: null, unchanged: 0 });
    expect(byTable.patient_master.inserted).toBe(byTable.patient_master.rows);
    expect(byTable.patient_master.rows).toBeGreaterThan(100);
    expect(byTable.office).toMatchObject({ entity: "offices", columnSource: "format-file", blocked: null });
    expect(byTable.provider).toMatchObject({ entity: "providers", delimiter: "|", hasHeader: true });
    expect(byTable.ref_type).toMatchObject({ entity: "referral_types", hasHeader: true });
    expect(byTable.treat_plan).toMatchObject({ entity: "treatment_plans" });
    expect(byTable.treat_plan_detail).toMatchObject({ entity: "treatment_plan_items" });
    expect(byTable.treat_plan_detail.rows).toBeGreaterThan(byTable.treat_plan.rows); // items are per-procedure
    expect(byTable.ledger).toMatchObject({ entity: null, blocked: expect.stringMatching(/no adapter/) });
    expect(byTable.ledger.inserted).toBe(byTable.ledger.rows);
    expect(byTable.readme).toBeUndefined();
    expect(r.promoted).toMatchObject({
      offices: byTable.office.rows,
      providers: byTable.provider.rows,
      referralTypes: byTable.ref_type.rows,
      patients: byTable.patient_master.rows,
      treatmentPlans: byTable.treat_plan.rows,
    });
    expect(r.promoted!.processed).toMatchObject({
      patients: byTable.patient_master.rows,
      treatmentPlans: byTable.treat_plan.rows,
      treatmentPlansDeferred: 0,
    });

    const { rows: [c] } = await pool.query(
      `SELECT (SELECT count(*) FROM patients)::int AS patients, (SELECT count(*) FROM treatment_plans)::int AS plans,
              (SELECT count(*) FROM treatment_completions)::int AS done, (SELECT count(*) FROM locations)::int AS locations,
              (SELECT count(*) FROM providers)::int AS providers,
              (SELECT count(*) FROM staging_bcp_rows WHERE processed_at IS NULL)::int AS raw_unprocessed,
              (SELECT count(*) FROM staging_denticon_patients WHERE source = 'bcp')::int AS bcp_staged`,
    );
    expect(c).toMatchObject({
      patients: byTable.patient_master.rows,
      plans: byTable.treat_plan.rows,
      locations: byTable.office.rows,
      providers: byTable.provider.rows,
      raw_unprocessed: byTable.ledger.rows, // the table with no adapter stays raw
      bcp_staged: byTable.patient_master.rows,
    });
    expect(c.done).toBeGreaterThan(0);

    // Referral descriptions resolved through the ref_type table.
    const { rows: src } = await pool.query("SELECT DISTINCT source FROM patients WHERE source IS NOT NULL ORDER BY 1");
    expect(src.map((s) => s.source)).toContain("Website / Online Booking");

    const { rows: [load] } = await pool.query("SELECT status, jsonb_array_length(tables)::int AS n FROM bcp_loads WHERE id = $1", [r.loadId]);
    expect(load).toEqual({ status: "ok", n: 7 });
  }, SLOW);

  it("re-loading the same download is a no-op", async () => {
    const before = await coreSnapshot();
    const firstLoad = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM staging_bcp_rows");
    const r = await loadFeed(sampleDir, { config, log: () => {} });
    expect(r.status).toBe("ok");
    expect(r.tables.filter((t) => !t.ignored).every((t) => t.inserted === 0 && t.unchanged === t.rows)).toBe(true);
    expect(r.promoted).toMatchObject({ patients: 0, treatmentPlans: 0 });
    expect(r.promoted!.processed).toMatchObject({ patients: 0, treatmentPlans: 0 });
    expect(await coreSnapshot()).toEqual(before);
    const { rows: [c] } = await pool.query("SELECT count(*)::int AS n FROM staging_bcp_rows");
    expect(c.n).toBe(firstLoad.rows[0]!.n); // no duplicate raw rows
    expect(c.n).toBe(r.tables.filter((t) => !t.ignored).reduce((n, t) => n + t.rows, 0));
  }, SLOW);

  it("tomorrow's dump: only changed rows land and only their entities are re-promoted", async () => {
    // Copy the sample, then edit one patient's last name and mark one plan item completed.
    const dir = path.join(work, "day2");
    await rm(dir, { recursive: true, force: true });
    const { cp } = await import("node:fs/promises");
    await cp(sampleDir, dir, { recursive: true });

    const { rows: [before] } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM patients");
    const pm = path.join(dir, "dbo_PatientMaster.txt");
    const lines = (await readFile(pm, "utf8")).split("\r\n");
    const target = lines[0]!.split("\t");
    target[3] = "Renamed";
    lines[0] = target.join("\t");
    await writeFile(pm, lines.join("\r\n"));

    const det = path.join(dir, "TreatPlanDetail.txt");
    const dl = (await readFile(det, "utf8")).split("\r\n");
    // Header: TPDETAILID TPID PROCCODE TOOTH FEE COMPLETED COMPLETEDDATE. Find a plan whose
    // items are all incomplete and complete every one of them.
    const rowsByPlan = new Map<string, number[]>();
    dl.slice(1).forEach((l, i) => {
      if (!l) return;
      const tp = l.split("\t")[1]!;
      rowsByPlan.set(tp, [...(rowsByPlan.get(tp) ?? []), i + 1]);
    });
    const openPlan = [...rowsByPlan.entries()].find(([, idx]) => idx.every((i) => dl[i]!.split("\t")[5] === "0"))!;
    for (const i of openPlan[1]) {
      const f = dl[i]!.split("\t");
      f[5] = "1";
      f[6] = "2026-09-16 17:00:00.000";
      dl[i] = f.join("\t");
    }
    await writeFile(det, dl.join("\r\n"));

    const r = await loadFeed(dir, { config, log: () => {} });
    expect(r.status).toBe("ok");
    const byTable = Object.fromEntries(r.tables.map((t) => [t.table, t]));
    expect(byTable.patient_master).toMatchObject({ inserted: 1 });
    expect(byTable.patient_master.unchanged).toBe(byTable.patient_master.rows - 1);
    expect(byTable.treat_plan_detail).toMatchObject({ inserted: openPlan[1].length });
    expect(byTable.treat_plan_detail.unchanged).toBe(byTable.treat_plan_detail.rows - openPlan[1].length);
    expect(byTable.treat_plan).toMatchObject({ inserted: 0 });
    expect(r.promoted).toMatchObject({ patients: 1, treatmentPlans: 1 });

    const { rows: [p] } = await pool.query("SELECT last_name FROM patients WHERE denticon_patient_id = $1", [target[0]]);
    expect(p.last_name).toBe("Renamed");
    const { rows: [tc] } = await pool.query(
      `SELECT tc.completed_date::text FROM treatment_completions tc JOIN treatment_plans tp ON tp.id = tc.treatment_plan_id
        WHERE tp.denticon_treat_plan_id = $1`,
      [Number(openPlan[0])],
    );
    expect(tc?.completed_date).toBe("2026-09-16");

    // The superseded rows are still in staging (history), but not "current".
    const { rows: [stale] } = await pool.query(
      "SELECT count(*)::int AS n FROM staging_bcp_rows WHERE table_name = 'patient_master' AND last_seen_load_id <> $1",
      [r.loadId],
    );
    expect(stale.n).toBe(1);
  }, SLOW);

  it("a wrong password / unreadable archive is recorded as a failed load and promotes nothing", async () => {
    const zip = path.resolve(sampleDir + ".zip");
    const before = await coreSnapshot();
    const r = await loadFeed(zip, { config, password: "definitely-wrong", log: () => {} });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/password/i);
    expect(r.promoted).toBeNull();
    expect(await coreSnapshot()).toEqual(before);
    const { rows: [load] } = await pool.query("SELECT status, error FROM bcp_loads WHERE id = $1", [r.loadId]);
    expect(load.status).toBe("error");
    expect(load.error).not.toContain("definitely-wrong");
  }, SLOW);

  it("--only restricts landing; a bad row in a table doesn't sink the load", async () => {
    const dir = path.join(work, "only");
    await rm(dir, { recursive: true, force: true });
    const { cp } = await import("node:fs/promises");
    await cp(sampleDir, dir, { recursive: true });
    const { rows: [before] } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM patients");
    const pm = path.join(dir, "dbo_PatientMaster.txt");
    await writeFile(pm, (await readFile(pm, "utf8")) + "notanid\t101\tX\tBad\tRow\t\t\t1\t\t\t\t\t\r\n");
    const r = await loadFeed(dir, { config, only: ["patient_master"], log: () => {} });
    expect(r.status).toBe("ok");
    expect(r.tables.filter((t) => !t.ignored).map((t) => t.table)).toEqual(["patient_master"]);
    expect(r.tables.find((t) => t.table === "patient_master")).toMatchObject({ inserted: 1 });
    expect(r.promoted).toMatchObject({ patients: 0 });
    const { rows: [c] } = await pool.query("SELECT count(*)::int AS n FROM patients");
    expect(c.n).toBe(before!.n); // the unpromoted bad row never reached the core table
  }, SLOW);
});
