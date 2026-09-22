import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Proves the BCP path and the REST-sync path produce identical core rows from the same
// mock dataset, so the dashboard is indifferent to which feed is live. Skipped unless run
// via `npm run test:db`.

const enabled = process.env.TEST_DB === "1";
const d = describe.skipIf(!enabled);

const sampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../docs/samples/denticon-bcp");
const sampleConfigPath = path.resolve(sampleDir, "..", "denticon-bcp-feed.example.json");

const TRUNCATE = `TRUNCATE treatment_completions, fundings, financing_applications, financing_cases, treatment_plans, patients,
  providers, locations, staging_denticon_patients, staging_denticon_treatment_plans, denticon_sync_state,
  staging_bcp_rows, bcp_loads RESTART IDENTITY CASCADE`;

d("bcp vs REST sync parity (database + mock server)", () => {
  let server: Server;
  let pool: typeof import("../../../db/pool.js").pool;

  beforeAll(async () => {
    // env.ts snapshots process.env on first import (pool.js pulls it in), so the mock
    // server must be up and the vars set before anything from src/ is imported.
    const { createDenticonMockApp } = await import("../../../integrations/denticon/mock/server.js");
    const { generateMockDataset } = await import("../../../integrations/denticon/mock/data.js");
    // Same seed/reference date as `npm run bcp:sample`.
    const dataset = generateMockDataset({ referenceDate: new Date("2026-09-15T12:00:00Z"), seed: 20260916 });
    const { app } = createDenticonMockApp({ subscriptionKey: "k", dataset });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    process.env.DENTICON_API_BASE_URL = `http://127.0.0.1:${port}/denticon`;
    process.env.DENTICON_SUBSCRIPTION_KEY = "k";
    process.env.DENTICON_BACKFILL_DAYS = "3000";
    ({ pool } = await import("../../../db/pool.js"));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  it("the same dataset through the API mock and through the BCP files yields the same core rows", async () => {
    const { syncDenticon } = await import("../../jobs/syncDenticon.js");
    const { loadFeed } = await import("../loadService.js");
    const config = JSON.parse(await readFile(sampleConfigPath, "utf8"));

    const snapshot = async () => {
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
      const { rows: refs } = await pool.query("SELECT denticon_office_id, name FROM locations ORDER BY 1");
      const { rows: provs } = await pool.query("SELECT denticon_provider_id, name, active FROM providers ORDER BY 1");
      return { patients, plans, refs, provs };
    };

    await pool.query(TRUNCATE);
    await syncDenticon({ data: { mode: "full" } } as never);
    const viaApi = await snapshot();
    // Whatever the generated dataset's size, both paths must describe the same practice.
    expect(viaApi.patients.length).toBeGreaterThan(100);
    expect(viaApi.plans.length).toBeGreaterThan(50);

    await pool.query(TRUNCATE);
    const r = await loadFeed(sampleDir, { config, log: () => {} });
    expect(r.status).toBe("ok");
    const viaBcp = await snapshot();

    expect(viaBcp.refs).toEqual(viaApi.refs);
    expect(viaBcp.provs).toEqual(viaApi.provs);
    expect(viaBcp.patients).toEqual(viaApi.patients);
    expect(viaBcp.plans).toEqual(viaApi.plans);
  }, 180_000);
});
