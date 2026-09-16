import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateMockDataset } from "../integrations/denticon/mock/data.js";
import { groupTreatmentPlanItems, rollUpTreatmentPlan } from "../integrations/denticon/mapping.js";
import { toCsvLine } from "../etl/financing/csv.js";

// `npm run financing:sample` — writes docs/samples/financing/sample-lender-export.csv: a
// synthetic multi-lender export whose applicants are patients from the Denticon mock
// dataset (same seed), so importing it after a mock sync links ~95% of rows and lights up
// the financing stages of the funnel. Headers are deliberately *not* the canonical ones —
// they look like a real portal export, to exercise the alias mapping.
//
// Assumptions baked in (all invented, tune freely): 45% of patients with a plan apply;
// prime lenders first, a declined prime application is followed by a second-look
// (subprime) one 60% of the time; 60/25/8/7 approved/declined/pending/withdrawn;
// 70% of approvals fund within 3 weeks at 60–100% of the approved amount.

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/samples/financing");
const REF = process.env.FINANCING_SAMPLE_REF_DATE ? new Date(process.env.FINANCING_SAMPLE_REF_DATE) : new Date();
const data = generateMockDataset({ referenceDate: REF, seed: 20260916 });

let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const pick = <T>(arr: readonly T[]) => arr[Math.floor(rnd() * arr.length)]!;
const weighted = <T>(entries: ReadonlyArray<readonly [T, number]>): T => {
  let r = rnd() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of entries) if ((r -= w) <= 0) return v;
  return entries[entries.length - 1]![0];
};
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const us = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}/${iso.slice(0, 4)}` : "");
const money = (n: number | null) => (n === null ? "" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

const PRIME: ReadonlyArray<readonly [string, number]> = [["CareCredit", 40], ["Cherry", 20], ["Alphaeon Credit", 15], ["Proceed Finance", 10], ["Sunbit", 15]];
const SUBPRIME: ReadonlyArray<readonly [string, number]> = [["HFD", 35], ["Fortiva", 25], ["Access", 20], ["Covered Care", 20]];
const DECLINE_REASONS = ["Insufficient credit history", "Debt-to-income too high", "Recent delinquency", "Unable to verify income", "Credit score below threshold"];

const officeName = new Map(data.offices.map((o) => [Number(o.officeId), o.officeName]));
const patientsById = new Map(data.patients.map((p) => [p.patientId, p]));
const plans = [...groupTreatmentPlanItems(data.treatmentPlanItems).values()].map(rollUpTreatmentPlan);

interface Row {
  id: string; lender: string; tier: string; status: string; applied: string; decided: string | null;
  requested: number; approved: number | null; reason: string; funded: string | null; fundedAmt: number | null;
  merchant: string; first: string; last: string; dob: string; chart: string;
}
const rows: Row[] = [];
let appSeq = 100230;

for (const plan of plans) {
  if (plan.status === "declined" || !plan.presentedDate || plan.presentedDate > REF.toISOString().slice(0, 10)) continue;
  if (rnd() > 0.45) continue;
  const patient = patientsById.get(Number(plan.denticonPatientId))!;
  const requested = Math.max(300, Math.round((plan.proposedFee ?? 500) / 50) * 50);

  const makeApp = (lender: string, tier: string, appliedOn: string): Row => {
    const status = weighted([["Approved", 60], ["Declined", 25], ["Pending", 8], ["Withdrawn", 7]] as const);
    const decided = status === "Approved" || status === "Declined" ? addDays(appliedOn, weighted([[0, 70], [1, 20], [3, 10]])) : null;
    const approved = status === "Approved" ? Math.round((requested * (1 + rnd() * 0.5)) / 100) * 100 : null;
    const willFund = status === "Approved" && rnd() < 0.7;
    const fundedOn = willFund ? addDays(decided!, 3 + Math.floor(rnd() * 18)) : null;
    const fundedAmt = willFund ? Math.round(approved! * (0.6 + rnd() * 0.4)) : null;
    return {
      id: `${lender.slice(0, 2).toUpperCase()}-${appSeq++}`,
      lender, tier,
      status: willFund && rnd() < 0.5 ? "Funded" : status, // some exports say "Funded", some keep "Approved" + a funded date
      applied: appliedOn, decided, requested, approved,
      reason: status === "Declined" ? pick(DECLINE_REASONS) : "",
      funded: fundedOn && fundedOn <= REF.toISOString().slice(0, 10) ? fundedOn : null,
      fundedAmt: fundedOn && fundedOn <= REF.toISOString().slice(0, 10) ? fundedAmt : null,
      merchant: `Sample Dental – ${officeName.get(patient.officeId)}`,
      first: patient.firstName, last: patient.lastName,
      dob: patient.birthDate!.slice(0, 10), chart: rnd() < 0.15 ? patient.chartNo! : "",
    };
  };

  const applied = addDays(plan.presentedDate, Math.floor(rnd() * 6));
  const first = makeApp(weighted(PRIME), "Prime", applied);
  rows.push(first);
  if (first.status === "Declined" && rnd() < 0.6) {
    rows.push(makeApp(weighted(SUBPRIME), "SubPrime", addDays(first.decided!, Math.floor(rnd() * 3))));
  }
}

// A few rows the importer must cope with: applicants not in the PMS (unmatched), a
// lender spelled differently, and a status the mapper doesn't know (rejected).
rows.push({ ...rows[0]!, id: "CA-999001", first: "Nobody", last: "Inpms", dob: "1970-01-01", chart: "", lender: "Care Credit", status: "Approved" });
rows.push({ ...rows[1]!, id: "CH-999002", first: "Also", last: "Missing", dob: "1980-05-05", chart: "", lender: "Cherry", status: "Declined" });
rows.push({ ...rows[2]!, id: "SU-999003", lender: "Sunbit", status: "Kinda approved?" });

rows.sort((a, b) => a.applied.localeCompare(b.applied));

const headers = ["Application ID", "Financing Co.", "Program", "Decision", "Application Date", "Decision Date", "Amount Requested", "Credit Limit", "Decision Reason", "Purchase Date", "Purchase Amount", "Merchant Name", "Applicant First Name", "Applicant Last Name", "DOB", "Chart #"];
const lines = [toCsvLine(headers), ...rows.map((r) => toCsvLine([r.id, r.lender, r.tier, r.status, us(r.applied), us(r.decided), money(r.requested), money(r.approved), r.reason, us(r.funded), money(r.fundedAmt), r.merchant, r.first, r.last, us(r.dob), r.chart]))];

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "sample-lender-export.csv"), lines.join("\r\n") + "\r\n");
await writeFile(
  path.join(outDir, "README.md"),
  `# Financing sample data

\`sample-lender-export.csv\` is a synthetic multi-lender application export generated by
\`npm run financing:sample\` (backend/src/scripts/financingSample.ts). Applicants are the
patients from the Denticon mock dataset, so after a mock sync (\`npm run denticon:mock\` +
\`npm run denticon:sync -- --full\`) importing this file links almost every row to a patient
and populates the applications → approved → funded funnel stages.

Headers intentionally mimic a lender portal export ("Financing Co.", "Credit Limit",
"Purchase Date", "Merchant Name") rather than our canonical column names, to exercise the
header aliasing in \`backend/src/etl/financing/columns.ts\`. The last three rows are
deliberate edge cases: two applicants who don't exist in the PMS (imported as *unmatched*)
and one unknown status (*rejected* with a row error).

Import it from the dashboard's **Import** page, or:

\`\`\`bash
curl -X POST 'http://localhost:4000/api/finance/import?sourceFile=sample-lender-export.csv' \\
     -H 'Content-Type: text/csv' --data-binary @docs/samples/financing/sample-lender-export.csv
\`\`\`

The canonical template (headers the importer needs no aliases for) is
\`GET /api/finance/import/template\`. ${rows.length} rows; every name, DOB and id is invented.
`,
);
console.log(`wrote ${rows.length} rows to ${path.join(outDir, "sample-lender-export.csv")}`);
