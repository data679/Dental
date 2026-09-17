import { inspectFeed } from "../etl/bcp/loadService.js";
import { ArchiveError } from "../etl/bcp/archive.js";

// `npm run bcp:inspect -- <download.zip | folder> [--rows 5] [--json]`
// Reads a Denticon data download without touching the database and reports, per file:
// encoding, delimiter, whether a header was found, the column names it will use, which
// adapter claims it, which required columns are missing, and a few sample rows. This is
// the first thing to run on a new download, and its output is what to compare against
// the data dictionary before filling in bcp-feed.json.

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
if (!source) {
  console.error("usage: npm run bcp:inspect -- <download.zip | folder> [--rows N] [--json]");
  process.exit(2);
}
const rowsIdx = args.indexOf("--rows");
const sampleRows = rowsIdx >= 0 ? Number(args[rowsIdx + 1]) || 3 : 3;

const report = await inspectFeed(source, { sampleRows }).catch((err: unknown) => {
  if (err instanceof ArchiveError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
});

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`${report.fileName}: ${report.files.length} data file(s)${report.otherFiles.length ? `, ${report.otherFiles.length} other (${report.otherFiles.slice(0, 5).join(", ")}${report.otherFiles.length > 5 ? ", …" : ""})` : ""}`);
for (const t of report.tables) {
  console.log("");
  console.log(`▸ ${t.table}  (${t.file}, ${fmtBytes(t.bytes)}, ${t.rows} rows${t.ragged ? `, ${t.ragged} ragged` : ""})`);
  if (t.ignored) {
    console.log(`   ignored: ${t.blocked}`);
    continue;
  }
  console.log(`   delimiter=${show(t.delimiter)} encoding=${t.encoding} header=${t.hasHeader ? "yes" : "no"} columns=${t.columns.length} (${t.columnSource})`);
  console.log(`   columns: ${t.columns.slice(0, 25).join(", ")}${t.columns.length > 25 ? `, … (+${t.columns.length - 25})` : ""}`);
  if (t.entity) {
    console.log(`   adapter: ${t.entity}`);
    const mapped = Object.entries(t.mapped).map(([k, v]) => `${k}←${v}`).join(", ");
    if (mapped) console.log(`   mapped:  ${mapped}`);
    if (t.missingRequired.length) console.log(`   MISSING (required): ${t.missingRequired.join(", ")}`);
    if (t.missingOptional.length) console.log(`   missing (optional): ${t.missingOptional.join(", ")}`);
  }
  console.log(t.blocked ? `   ✗ not promoted: ${t.blocked}` : `   ✓ will be promoted`);
  for (const s of t.sample ?? []) {
    const cells = Object.entries(s).slice(0, 12).map(([k, v]) => `${k}=${v === null ? "∅" : JSON.stringify(v)}`);
    console.log(`   · ${cells.join("  ")}${Object.keys(s).length > 12 ? "  …" : ""}`);
  }
}
if (report.problems.length) {
  console.log("");
  console.log("Problems:");
  for (const p of report.problems) console.log(` - ${p}`);
}

function show(d: string): string {
  return d === "\t" ? "TAB" : d === "" ? "SOH" : JSON.stringify(d);
}
function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}
