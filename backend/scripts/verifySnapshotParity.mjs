// `npm run snapshot:verify` (= `npx tsx scripts/verifySnapshotParity.mjs`) — proves the browser-side summaries in
// frontend/src/lib/staticApi.ts match the live API for a set of filter combinations.
// Needs the API running (npm run dev) and a fresh `npm run snapshot`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.SNAPSHOT_API_URL ?? "http://localhost:4000";
const snapshotPath = path.resolve(here, "../../frontend/public/data/snapshot.json");
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));

// Run under tsx so the frontend's .ts module loads; shim the browser-only bits it touches.
globalThis.fetch = ((orig) => async (url, init) => {
  if (String(url).endsWith("data/snapshot.json")) return new Response(JSON.stringify(snapshot), { status: 200 });
  return orig(url, init);
})(globalThis.fetch);
const staticApi = await import(pathToFileURL(path.resolve(here, "../../frontend/src/lib/staticApi.ts")).href);

const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const live = async (p) => (await fetch(`${api}${p}`)).json();

const funnelFilters = [
  {},
  { dateFrom: "2026-01-01", dateTo: "2026-09-17" },
  { locationId: 1, dateFrom: "2026-06-01" },
  { locationId: 2, lender: "care_credit" },
  { providerId: 5, dateFrom: "2026-01-01" },
  { dateFrom: "2025-01-01", dateTo: "2025-12-31" },
];
const financeFilters = [
  {},
  { dateFrom: "2026-01-01", dateTo: "2026-09-17" },
  { dateFrom: "2026-01-01", dateTo: "2026-09-17", locationId: 2 },
  { dateFrom: "2026-01-01", dateTo: "2026-09-17", applicationType: "subprime" },
  { dateFrom: "2026-01-01", dateTo: "2026-09-17", status: "approved" },
  { dateFrom: "2026-01-01", dateTo: "2026-09-17", newPatientsOnly: true },
  { dateFrom: "2025-06-01", dateTo: "2026-03-31", locationId: 3 },
];

let failures = 0;
const norm = (v) => JSON.stringify(v, (k, x) => (k === "filters" ? undefined : x));
const diff = (label, a, b) => {
  if (norm(a) === norm(b)) return console.log(`✓ ${label}`);
  failures += 1;
  console.log(`✗ ${label}\n   api:    ${norm(a).slice(0, 400)}\n   static: ${norm(b).slice(0, 400)}`);
};

for (const f of funnelFilters) {
  const [a, b] = await Promise.all([live(`/api/funnel/summary?${qs(f)}`), staticApi.getFunnelSummary(f)]);
  diff(`funnel ${JSON.stringify(f)}`, { stages: a.stages, financing: a.financing }, { stages: b.stages, financing: b.financing });
}
for (const f of financeFilters) {
  const [a, b] = await Promise.all([live(`/api/finance/summary?${qs(f)}`), staticApi.getFinanceSummary(f)]);
  // lender lists: compare as sorted sets (API tie order is not part of the contract)
  const sortL = (x) => ({ ...x, applicationsByLender: [...x.applicationsByLender].sort((p, q) => p.lender.localeCompare(q.lender)), approvalRateByLender: [...x.approvalRateByLender].sort((p, q) => p.lender.localeCompare(q.lender)) });
  diff(`finance ${JSON.stringify(f)}`, sortL(a), sortL(b));
}
diff("locations", await live("/api/locations").then((r) => r.locations.map((l) => ({ id: Number(l.id), name: l.name }))), await staticApi.getLocations());

console.log(failures ? `\n${failures} mismatch(es)` : "\nall parity checks passed");
process.exit(failures ? 1 : 0);
