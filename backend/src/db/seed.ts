import { pool } from "./pool.js";

// MVP seed data. PlanetDDS/Denticon API access isn't available yet (behind an
// authorization we don't hold), so this loads representative synthetic patients modeled
// on the fields actually visible in a real Denticon "Patient Ledger" screen (provider,
// home office, referral source, first-visit date, patient ID format) — see
// docs/data-model.md for exactly what that example showed and what it didn't.
//
// Deliberately NOT seeded: treatment plans, financing applications, fundings, treatment
// completions. The example data only covered the patient/appointment side, not the
// financing funnel, so those stages stay at 0 in the dashboard until real (or at least
// example) financing data shows up — no fabricated numbers there.
//
// This is dev-only and destructive (truncates first) — never point it at a real dataset.

const LOCATIONS = ["West Covina", "Carson"];

const PROVIDERS: Array<{ name: string; location: string }> = [
  { name: "Bishoy Besada, DDS", location: "West Covina" },
  { name: "Amrit Sandhu, DDS", location: "West Covina" },
  { name: "Lena Ortiz, DDS", location: "Carson" },
];

// Referral Type / Referred By, as seen on the ledger ("z ORTHO CHATS", etc.) — kept
// generic/synthetic here rather than copying real referral partner names.
const SOURCES = ["Ortho referral", "Google Ads", "Walk-in", "Patient referral", "Insurance directory"];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Dev-only reset, in dependency order.
    await client.query(`
      TRUNCATE treatment_completions, fundings, financing_applications, treatment_plans,
        patients, providers, locations,
        staging_denticon_patients, staging_denticon_treatment_plans, denticon_sync_state
        RESTART IDENTITY CASCADE;
    `);

    // `npm run seed -- --reset-only`: wipe and stop, e.g. before syncing from the Denticon
    // mock (`npm run denticon:mock`) so its offices don't sit next to the synthetic ones.
    if (process.argv.includes("--reset-only")) {
      await client.query("COMMIT");
      console.log("[seed] tables reset, no rows inserted (--reset-only)");
      client.release();
      await pool.end();
      return;
    }

    const locationIds = new Map<string, number>();
    for (const name of LOCATIONS) {
      const { rows } = await client.query<{ id: number }>(
        "INSERT INTO locations (name) VALUES ($1) RETURNING id",
        [name],
      );
      locationIds.set(name, rows[0].id);
    }

    const providerIds: number[] = [];
    for (const p of PROVIDERS) {
      const { rows } = await client.query<{ id: number }>(
        "INSERT INTO providers (location_id, name) VALUES ($1, $2) RETURNING id",
        [locationIds.get(p.location), p.name],
      );
      providerIds.push(rows[0].id);
    }

    // ~14 synthetic patients spread over the last 60 days, patient-id style matching the
    // example ledger's "4000157"-style ID (fake numbers, no relation to any real patient).
    const patientCount = 14;
    for (let i = 0; i < patientCount; i++) {
      const denticonId = String(4000100 + i);
      const provider = randomFrom(providerIds);
      const location = randomFrom([...locationIds.values()]);
      const source = randomFrom(SOURCES);
      const firstVisit = daysAgo(Math.floor(Math.random() * 60));

      await client.query(
        `INSERT INTO patients
           (denticon_patient_id, location_id, provider_id, source, first_visit_date)
         VALUES ($1, $2, $3, $4, $5)`,
        [denticonId, location, provider, source, firstVisit],
      );
    }

    await client.query("COMMIT");
    console.log(`[seed] inserted ${LOCATIONS.length} locations, ${PROVIDERS.length} providers, ${patientCount} patients`);
    console.log("[seed] treatment plans / financing applications / fundings left empty — no example data for those stages yet");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    if (!pool.ended) client.release();
  }

  if (!pool.ended) await pool.end();
}

seed().catch((err) => {
  console.error("[seed] failed", err);
  process.exit(1);
});
