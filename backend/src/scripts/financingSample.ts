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
// Ratios are tuned to the shape of the real Finance Report this replaces (see
// docs/os-dental-report.md): roughly a third of new patients apply, each applying patient
// is shopped to several lenders, and because the report's approval rate counts every
// application, that per-application rate lands far below the share of patients who
// actually get financed. Absolute volumes are much smaller than a real month.
//
// Assumptions baked in (all invented, tune freely): ~55% of patients with a plan apply.
// Two workflows, mirroring how the practice actually works:
//   • multi-app (55% of rounds): a soft check at 2–3 prime lenders the same day
//     ("Prequalified"/"Pre-declined"), the patient picks one approval to use; some rounds
//     carry a Request ID from the portal, most don't (grouped by date window instead).
//   • single application (45%): one prime lender; a declined one is followed by a
//     second-look subprime application 60% of the time.
// 60/25/8/7 approved/declined/pending/withdrawn; ~70% of chosen approvals fund within
// 3 weeks at 60–100% of the approved amount.

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

// Which programs each lender runs, mirroring the `lenders` table seeded in migration 0010.
// The Program column written below follows this, so a subprime-only lender never produces
// a "Prime" row — the export and the configuration agree, as they would in reality.
const LENDER_TIERS: Record<string, { prime: boolean; subprime: boolean }> = {
  CareCredit: { prime: true, subprime: false },
  "Care Credit": { prime: true, subprime: false },
  "Alphaeon Credit": { prime: true, subprime: false },
  Cherry: { prime: true, subprime: true },
  "Proceed Finance": { prime: true, subprime: true },
  Sunbit: { prime: true, subprime: true },
  HFD: { prime: false, subprime: true },
  "Covered Care": { prime: false, subprime: true },
  Fortiva: { prime: false, subprime: true },
  Access: { prime: true, subprime: true },
};

/** The tier a row states: forced for single-program lenders, the round's own tier otherwise. */
function programFor(lender: string, roundTier: string): string {
  const t = LENDER_TIERS[lender];
  if (!t) return roundTier;
  if (t.prime && !t.subprime) return "Prime";
  if (t.subprime && !t.prime) return "SubPrime";
  return roundTier;
}

const PRIME: ReadonlyArray<readonly [string, number]> = [["CareCredit", 40], ["Cherry", 20], ["Alphaeon Credit", 15], ["Proceed Finance", 10], ["Sunbit", 15]];
const SUBPRIME: ReadonlyArray<readonly [string, number]> = [["HFD", 35], ["Fortiva", 25], ["Access", 20], ["Covered Care", 20]];
const DECLINE_REASONS = ["Insufficient credit history", "Debt-to-income too high", "Recent delinquency", "Unable to verify income", "Credit score below threshold"];

const officeName = new Map(data.offices.map((o) => [Number(o.officeId), o.officeName]));
const patientsById = new Map(data.patients.map((p) => [p.patientId, p]));
const plans = [...groupTreatmentPlanItems(data.treatmentPlanItems).values()].map(rollUpTreatmentPlan);

interface Row {
  id: string; lender: string; tier: string; status: string; applied: string; decided: string | null;
  requested: number; approved: number | null; reason: string; funded: string | null; fundedAmt: number | null;
  merchant: string; first: string; last: string; dob: string; chart: string; inquiry: string; requestId: string;
}
const rows: Row[] = [];
let appSeq = 100230;
let reqSeq = 5001;

for (const plan of plans) {
  if (plan.status === "declined" || !plan.presentedDate || plan.presentedDate > REF.toISOString().slice(0, 10)) continue;
  // Financing tracks the size of the case: a $400 hygiene plan is paid at the desk, a
  // $6,000 implant or ortho case is what gets shopped to lenders. This is also why the
  // real report's average approval amount runs into the thousands.
  const planFee = plan.proposedFee ?? 500;
  const applyChance = planFee >= 4000 ? 0.95 : planFee >= 2000 ? 0.85 : planFee >= 900 ? 0.62 : 0.26;
  if (rnd() > applyChance) continue;
  const patient = patientsById.get(Number(plan.denticonPatientId))!;
  const requested = Math.max(300, Math.round((plan.proposedFee ?? 500) / 50) * 50);

  const today = REF.toISOString().slice(0, 10);
  const makeApp = (lender: string, tier: string, appliedOn: string, opts: { soft?: boolean; fund?: boolean; requestId?: string } = {}): Row => {
    const status = weighted([["Approved", 28], ["Declined", 55], ["Pending", 9], ["Withdrawn", 8]] as const);
    const decided = status === "Approved" || status === "Declined" ? addDays(appliedOn, weighted([[0, 70], [1, 20], [3, 10]])) : null;
    const approved = status === "Approved" ? Math.round((requested * (1.2 + rnd() * 2.2)) / 100) * 100 : null;
    const willFund = status === "Approved" && (opts.fund ?? rnd() < 0.7);
    const fundedOn = willFund ? addDays(decided!, 3 + Math.floor(rnd() * 18)) : null;
    const fundedAmt = willFund ? Math.round(Math.min(requested, approved! * (0.3 + rnd() * 0.5))) : null;
    // Soft checks come back as prequal wording in most portals.
    const shown = opts.soft
      ? ({ Approved: "Prequalified", Declined: "Pre-declined", Pending: "Pending", Withdrawn: "Withdrawn" } as const)[status]
      : status;
    return {
      id: `${lender.slice(0, 2).toUpperCase()}-${appSeq++}`,
      lender,
      tier: programFor(lender, tier),
      status: willFund && rnd() < 0.5 ? "Funded" : shown, // some exports say "Funded", some keep the approval + a funded date
      applied: appliedOn, decided, requested, approved,
      reason: status === "Declined" ? pick(DECLINE_REASONS) : "",
      funded: fundedOn && fundedOn <= today ? fundedOn : null,
      fundedAmt: fundedOn && fundedOn <= today ? fundedAmt : null,
      merchant: `Sample Dental – ${officeName.get(patient.officeId)}`,
      first: patient.firstName, last: patient.lastName,
      dob: patient.birthDate!.slice(0, 10), chart: rnd() < 0.15 ? patient.chartNo! : "",
      inquiry: opts.soft ? "Soft" : "Hard",
      requestId: opts.requestId ?? "",
    };
  };

  const applied = addDays(plan.presentedDate, Math.floor(rnd() * 6));
  if (rnd() < 0.85) {
    // Multi-app round: 2–3 distinct prime lenders, same day, soft pulls; the patient uses
    // at most one of the approvals.
    // Practices shop one treatment to several lenders at once — the real report averages
    // close to four applications per applying patient.
    const lenders = new Set<string>();
    const target = weighted([[2, 20], [3, 35], [4, 30], [5, 15]] as const);
    let guard = 0;
    while (lenders.size < target && guard++ < 40) lenders.add(weighted(rnd() < 0.7 ? PRIME : SUBPRIME));
    const requestId = rnd() < 0.3 ? `REQ-${reqSeq++}` : undefined;
    const round = [...lenders].map((l) => makeApp(l, "Prime", applied, { soft: true, fund: false, requestId }));
    const approvals = round.filter((r) => r.approved !== null);
    if (approvals.length && rnd() < 0.75) {
      // Patient picks one: prefer the biggest approval 70% of the time, else any.
      const chosen = rnd() < 0.7 ? approvals.reduce((a, b) => (b.approved! > a.approved! ? b : a)) : pick(approvals);
      const fundedOn = addDays(chosen.decided!, 3 + Math.floor(rnd() * 18));
      if (fundedOn <= today) {
        chosen.funded = fundedOn;
        // Patients rarely draw the whole limit — the report's collected ÷ approved runs ~30%.
        chosen.fundedAmt = Math.round(Math.min(chosen.requested, chosen.approved! * (0.3 + rnd() * 0.5)));
        if (rnd() < 0.5) chosen.status = "Funded";
      }
    }
    rows.push(...round);
    if (!approvals.length && rnd() < 0.6) {
      rows.push(makeApp(weighted(SUBPRIME), "SubPrime", addDays(applied, 1 + Math.floor(rnd() * 3)), { requestId }));
    }
  } else {
    const first = makeApp(weighted(PRIME), "Prime", applied);
    rows.push(first);
    if (first.status === "Declined" && rnd() < 0.6) {
      rows.push(makeApp(weighted(SUBPRIME), "SubPrime", addDays(first.decided!, Math.floor(rnd() * 3))));
    }
  }
}

// A few rows the importer must cope with: applicants not in the PMS (unmatched), a
// lender spelled differently, and a status the mapper doesn't know (rejected).
rows.push({ ...rows[0]!, id: "CA-999001", first: "Nobody", last: "Inpms", dob: "1970-01-01", chart: "", lender: "Care Credit", tier: programFor("Care Credit", "Prime"), status: "Approved", funded: null, fundedAmt: null });
rows.push({ ...rows[1]!, id: "CH-999002", first: "Also", last: "Missing", dob: "1980-05-05", chart: "", lender: "Cherry", tier: programFor("Cherry", "Prime"), status: "Declined", funded: null, fundedAmt: null });
rows.push({ ...rows[2]!, id: "SU-999003", lender: "Sunbit", tier: programFor("Sunbit", "Prime"), status: "Kinda approved?" });

rows.sort((a, b) => a.applied.localeCompare(b.applied));

const headers = ["Application ID", "Request ID", "Financing Co.", "Program", "Inquiry Type", "Decision", "Application Date", "Decision Date", "Amount Requested", "Credit Limit", "Decision Reason", "Purchase Date", "Purchase Amount", "Merchant Name", "Applicant First Name", "Applicant Last Name", "DOB", "Chart #"];
const lines = [toCsvLine(headers), ...rows.map((r) => toCsvLine([r.id, r.requestId, r.lender, r.tier, r.inquiry, r.status, us(r.applied), us(r.decided), money(r.requested), money(r.approved), r.reason, us(r.funded), money(r.fundedAmt), r.merchant, r.first, r.last, us(r.dob), r.chart]))];

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
header aliasing in \`backend/src/etl/financing/columns.ts\`. About half the rounds are
**multi-app**: a soft check at 2–3 lenders on the same day ("Prequalified" /
"Pre-declined", Inquiry Type = Soft), with the patient using at most one approval; some
carry a Request ID, most are grouped by date window. The last three rows are deliberate
edge cases: two applicants who don't exist in the PMS (imported as *unmatched*) and one
unknown status (*rejected* with a row error).

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
