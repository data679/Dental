import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";

// `npm run snapshot` — exports the analytics-relevant rows to
// frontend/public/data/snapshot.json so the dashboard can run without a backend (GitHub
// Pages demo: `VITE_STATIC_SNAPSHOT=true`, see frontend/src/lib/staticApi.ts, which
// recomputes the same summaries in the browser).
//
// Only ids, dates, amounts and categorical fields are exported — no names, DOBs,
// contact details or raw lender rows. Even so, a snapshot is published to the web, so it
// refuses to run against anything that looks like a real Denticon tenant unless you
// pass --allow-real-data explicitly.

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../frontend/public/data");
const apiBase = process.env.SNAPSHOT_API_URL ?? `http://localhost:${env.PORT}`;

const looksReal = env.DENTICON_SUBSCRIPTION_KEY && !/localhost|127\.0\.0\.1/.test(env.DENTICON_API_BASE_URL);
if (looksReal && !process.argv.includes("--allow-real-data")) {
  console.error("Refusing: DENTICON_API_BASE_URL points at a real tenant. Snapshots are published; pass --allow-real-data only if you are sure.");
  process.exit(2);
}

async function fetchJson<T>(pathname: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${apiBase}${pathname}`);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[snapshot] ${pathname} unavailable (${(err as Error).message}); using empty fallback — is the API running?`);
    return fallback;
  }
}

const q = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string) => (await pool.query<T>(sql)).rows;

const snapshot = {
  generatedAt: new Date().toISOString(),
  note: "Synthetic demo data (mock Denticon practice + generated lender export). No real patients.",
  locations: await q<{ id: number; name: string }>("SELECT id::int, name FROM locations ORDER BY name"),
  providers: await q("SELECT id::int, location_id::int, name FROM providers ORDER BY name"),
  patients: await q(
    `SELECT id::int, location_id::int, provider_id::int, first_visit_date::text, new_patient_flag,
            EXISTS (SELECT 1 FROM financing_applications fa WHERE fa.patient_id = p.id) AS has_application
       FROM patients p ORDER BY id`,
  ),
  treatmentPlans: await q("SELECT id::int, patient_id::int, presented_date::text, status FROM treatment_plans ORDER BY id"),
  treatmentCompletions: await q(
    "SELECT tc.treatment_plan_id::int, tp.patient_id::int, tc.completed_date::text FROM treatment_completions tc JOIN treatment_plans tp ON tp.id = tc.treatment_plan_id",
  ),
  cases: await q(
    `SELECT cs.case_id::int AS id, cs.patient_id::int, cs.location_id::int, cs.provider_id::int, cs.opened_date::text,
            cs.applications::int, cs.lenders::int, cs.approvals::int, cs.declines::int, cs.pending::int, cs.funded,
            cs.chosen_lender,
            (SELECT array_agg(DISTINCT fa.lender::text) FROM financing_applications fa WHERE fa.case_id = cs.case_id) AS lender_list,
            (SELECT array_agg(DISTINCT fa.lender::text) FROM financing_applications fa WHERE fa.case_id = cs.case_id AND fa.status = 'approved') AS approved_lenders,
            (SELECT bool_or(p.new_patient_flag) FROM patients p WHERE p.id = cs.patient_id) AS new_patient
       FROM financing_case_summary cs ORDER BY cs.case_id`,
  ),
  applications: await q(
    `SELECT fa.id::int, fa.case_id::int, fa.lender::text, fa.application_type::text, fa.status::text,
            fa.submitted_date::text, fa.decision_date::text, fa.approved_amount::float,
            COALESCE(fa.location_id, p.location_id)::int AS location_id, fa.patient_id::int, fa.inquiry_type,
            p.new_patient_flag AS new_patient
       FROM financing_applications fa LEFT JOIN patients p ON p.id = fa.patient_id ORDER BY fa.id`,
  ),
  fundings: await q("SELECT application_id::int, funded_date::text, funded_amount::float, utilization_pct::float FROM fundings"),
  // Filter-independent views, taken from the live API so the demo shows the real shapes.
  imports: (await fetchJson<{ imports: unknown[] }>("/api/finance/imports", { imports: [] })).imports,
  // Applicant names/DOBs are dropped even though the demo data is synthetic — the
  // snapshot is a published file and the rule is "no PII in it", full stop.
  unmatched: (await fetchJson<{ unmatched: Array<Record<string, unknown>> }>("/api/finance/unmatched", { unmatched: [] })).unmatched.map(
    ({ first_name: _f, last_name: _l, dob: _d, ...rest }) => ({ ...rest, first_name: null, last_name: null, dob: null }),
  ),
  dataQuality: (() => {
    return null as unknown; // filled below
  })(),
  denticonStatus: await fetchJson<unknown>("/api/denticon/status", null),
};
{
  const dq = await fetchJson<{ checks?: Array<{ id: string; examples: unknown[] }> } | null>("/api/data-quality", null);
  if (dq?.checks) {
    for (const c of dq.checks) if (c.id === "duplicate_patients") c.examples = []; // detail carries names
  }
  snapshot.dataQuality = dq;
}

await mkdir(outDir, { recursive: true });
const file = path.join(outDir, "snapshot.json");
await writeFile(file, JSON.stringify(snapshot));

console.log(
  `[snapshot] ${file}: ${snapshot.patients.length} patients, ${snapshot.treatmentPlans.length} plans, ${snapshot.cases.length} cases, ${snapshot.applications.length} applications` +
    ` (${(await (await import("node:fs/promises")).stat(file)).size / 1024 | 0} KB)`,
);

await pool.end();
