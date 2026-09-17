import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";

// Runs the real sync job against the mock Denticon server, into the test schema.
// Skipped unless run via `npm run test:db`.

const enabled = process.env.TEST_DB === "1";
const d = describe.skipIf(!enabled);

d("syncDenticon job (database + mock server)", () => {
  let server: Server;
  let pool: typeof import("../../../db/pool.js").pool;
  let syncDenticon: typeof import("../../jobs/syncDenticon.js").syncDenticon;

  beforeAll(async () => {
    const { createDenticonMockApp } = await import("../../../integrations/denticon/mock/server.js");
    const { generateMockDataset } = await import("../../../integrations/denticon/mock/data.js");
    const dataset = generateMockDataset({ patientCount: 60, historyDays: 100 });
    // Poison one patient and one plan item the way a flaky upstream might.
    dataset.patients.push({ ...dataset.patients[0]!, patientId: undefined as unknown as number, lastChangedOn: new Date().toISOString() });
    dataset.treatmentPlanItems.push({ ...dataset.treatmentPlanItems[0]!, treatPlanId: undefined as unknown as number });
    const { app } = createDenticonMockApp({ subscriptionKey: "k", dataset });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    process.env.DENTICON_API_BASE_URL = `http://127.0.0.1:${port}/denticon`;
    process.env.DENTICON_SUBSCRIPTION_KEY = "k";
    process.env.DENTICON_BACKFILL_DAYS = "120";
    ({ pool } = await import("../../../db/pool.js"));
    ({ syncDenticon } = await import("../../jobs/syncDenticon.js"));
    await pool.query(`TRUNCATE treatment_completions, fundings, financing_applications, treatment_plans, patients, providers, locations,
      staging_denticon_patients, staging_denticon_treatment_plans, denticon_sync_state RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool?.end();
  });

  it("syncs the good offices, records the bad one, skips id-less records, and still processes", async () => {
    await expect(syncDenticon({ data: { mode: "full", officeIds: [101, 999] } } as any)).rejects.toThrow(/1\/2 office\(s\) failed — 999: .*403/);

    const { rows: state } = await pool.query("SELECT entity, office_id, last_run_status FROM denticon_sync_state ORDER BY entity, office_id");
    expect(state).toEqual(
      expect.arrayContaining([
        { entity: "patients", office_id: 101, last_run_status: "ok" },
        { entity: "patients", office_id: 999, last_run_status: "error" },
        { entity: "reference", office_id: 0, last_run_status: "ok" },
      ]),
    );
    const { rows: [p] } = await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE denticon_patient_id = 'undefined')::int AS bad FROM patients");
    expect(p.n).toBeGreaterThan(0);
    expect(p.bad).toBe(0);
    const { rows: [tp] } = await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE denticon_treat_plan_id IS NULL)::int AS bad FROM staging_denticon_treatment_plans");
    expect(tp.n).toBeGreaterThan(0);
    expect(tp.bad).toBe(0);
  });

  it("a second incremental run only touches the tiny window since the watermark and is idempotent", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM patients");
    const r = await syncDenticon({ data: { mode: "incremental", officeIds: [101] } } as any);
    expect(r.offices).toEqual([101]);
    const after = await pool.query("SELECT count(*)::int AS n FROM patients");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const { rows: st } = await pool.query("SELECT watermark FROM denticon_sync_state WHERE entity = 'patients' AND office_id = 101");
    expect(Date.now() - new Date(st[0].watermark).getTime()).toBeLessThan(60_000);
  });
});
