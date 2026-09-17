import { pool } from "../db/pool.js";
import { loadFeed } from "../etl/bcp/loadService.js";
import { ArchiveError } from "../etl/bcp/archive.js";

// `npm run bcp:load -- <download.zip | folder> [--skip-promote] [--only patients,offices]`
// Loads a Denticon data download straight into the database in this process (no worker
// needed). Re-running on the same download is a no-op apart from a new bcp_loads row.
// For the scheduled feed, set DENTICON_BCP_INBOX and let the worker sweep it instead.

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
if (!source) {
  console.error("usage: npm run bcp:load -- <download.zip | folder> [--skip-promote] [--only table,table]");
  process.exit(2);
}
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : undefined;

const result = await loadFeed(source, { skipPromote: args.includes("--skip-promote"), only }).catch((err: unknown) => {
  if (err instanceof ArchiveError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
});

console.log("");
console.log(`load #${result.loadId}: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
for (const t of result.tables) {
  console.log(
    `  ${t.table.padEnd(28)} ${String(t.rows).padStart(8)} rows  ${String(t.inserted).padStart(8)} new  ${String(t.unchanged).padStart(8)} same  ${t.ignored ? "ignored" : t.blocked ? `✗ ${t.blocked}` : `→ ${t.entity}`}`,
  );
}
if (result.promoted) {
  const p = result.promoted;
  console.log(`  promoted: ${p.offices} offices, ${p.providers} providers, ${p.patients} patients, ${p.treatmentPlans} plans; core: ${p.processed.patients} patients, ${p.processed.treatmentPlans} plans`);
}
for (const p of result.problems) console.log(`  ! ${p}`);

await pool.end();
process.exit(result.status === "ok" ? 0 : 1);
