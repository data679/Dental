import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateMockDataset } from "../integrations/denticon/mock/data.js";

// `npm run bcp:sample [-- --out <dir>] [--zip]` — fakes a Denticon data download from the
// same deterministic mock dataset the API mock serves, so the BCP loader can be exercised
// end to end before a real download exists. Deliberately mixes the flavours we might get:
//   - bcp -c style: tab-delimited, no header, CRLF, SQL datetime text, bits as 0/1
//   - one table with a .fmt format file instead of a header
//   - one table exported with a header row and | delimiter
//   - one table we have no adapter for (ledger), to show "landed, not promoted"
// The real feed will differ; this exists so the pipeline is proven, not the column names.
// With --zip (needs 7z) the folder is also packed with password "sample", as the real
// download is AES-zipped with the requester's Denticon password.

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 && args[outIdx + 1]
  ? path.resolve(args[outIdx + 1]!)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/samples/denticon-bcp");

const data = generateMockDataset({ referenceDate: new Date("2026-09-15T12:00:00Z"), seed: 20260916 });

const sqlDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().replace("T", " ").replace("Z", "").replace(/\.\d{3}$/, ".000") : "";
const bit = (b: boolean | undefined) => (b === false ? "0" : "1");
const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const bcpLines = (rows: unknown[][]) => rows.map((r) => r.map(cell).join("\t")).join("\r\n") + "\r\n";

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Offices: bcp -c, no header, format file alongside.
await writeFile(
  path.join(outDir, "dbo_Office.txt"),
  bcpLines(data.offices.map((o) => [o.officeId, o.officeName, o.city ?? "", o.state ?? "", bit(o.officeActive), sqlDate(o.createdOn)])),
);
await writeFile(
  path.join(outDir, "dbo_Office.fmt"),
  ["14.0", "6",
    '1  SQLCHAR  0  12   "\\t"    1  OFCID       ""',
    '2  SQLCHAR  0  100  "\\t"    2  OFCNAME     SQL_Latin1_General_CP1_CI_AS',
    '3  SQLCHAR  0  50   "\\t"    3  CITY        SQL_Latin1_General_CP1_CI_AS',
    '4  SQLCHAR  0  2    "\\t"    4  STATE       SQL_Latin1_General_CP1_CI_AS',
    '5  SQLCHAR  0  1    "\\t"    5  ACTIVE      ""',
    '6  SQLCHAR  0  24   "\\r\\n"  6  CREATEDON   ""',
    ""].join("\n"),
);

// Providers: header row, pipe-delimited (an "export to text" flavour).
await writeFile(
  path.join(outDir, "Provider.txt"),
  ["PROVID|OFCID|FNAME|LNAME|TITLE|ACTIVE",
    ...data.providers.map((p) => [p.providerId, p.officeId, p.firstName, p.lastName, p.title ?? "", bit(p.active)].map(cell).join("|")),
  ].join("\r\n") + "\r\n",
);

// Referral types: tab, header.
await writeFile(
  path.join(outDir, "RefType.txt"),
  ["REFCODE\tREFDESC", ...data.referralTypes.map((r) => `${r.refTypeCode}\t${r.refTypeDescription}`)].join("\r\n") + "\r\n",
);

// Patients: bcp -c, no header, no format file → needs bcp-feed.json "columns".
// Column order is documented in the sample bcp-feed.json next to this folder.
await writeFile(
  path.join(outDir, "dbo_PatientMaster.txt"),
  bcpLines(
    data.patients.map((p) => [
      p.patientId, p.officeId, p.chartNo ?? "", p.lastName, p.firstName, sqlDate(p.birthDate), p.sex ?? "",
      bit(p.active), sqlDate(p.firstVisitDate), sqlDate(p.lastVisitDate), p.refTypeCode ?? "",
      p.preferredProviderId ?? "", sqlDate(p.lastChangedOn ?? p.modifiedOn),
    ]),
  ),
);

// Treatment plans: header table + detail table, both tab-delimited with headers.
const planIds = [...new Set(data.treatmentPlanItems.map((i) => i.treatPlanId))];
const headOf = new Map(data.treatmentPlanItems.map((i) => [i.treatPlanId, i]));
await writeFile(
  path.join(outDir, "TreatPlan.txt"),
  ["TPID\tPATID\tTPSTATUS\tPROPOSEDDATE\tACCEPTDATE\tPROVID\tMODDATE",
    ...planIds.map((id) => {
      const h = headOf.get(id)!;
      return [id, h.patientId, h.treatPlanStatus, sqlDate(h.treatPlanProposedDate), sqlDate(h.acceptedDateTime), h.providerId ?? "", sqlDate(h.lastChangedOn)].map(cell).join("\t");
    }),
  ].join("\r\n") + "\r\n",
);
await writeFile(
  path.join(outDir, "TreatPlanDetail.txt"),
  ["TPDETAILID\tTPID\tPROCCODE\tTOOTH\tFEE\tCOMPLETED\tCOMPLETEDDATE",
    ...data.treatmentPlanItems.map((i, n) =>
      [n + 1, i.treatPlanId, i.procedureCode ?? "", i.tooth ?? "", i.fee ?? "", bit(i.isCompleted), sqlDate(i.treatPlanFinishDate)].map(cell).join("\t"),
    ),
  ].join("\r\n") + "\r\n",
);

// Ledger: something the loader has no adapter for.
await writeFile(
  path.join(outDir, "dbo_Ledger.txt"),
  bcpLines(data.patients.slice(0, 50).map((p, i) => [i + 1, p.patientId, sqlDate(p.lastVisitDate), "D0120", 65, "CHG"])),
);

await writeFile(
  path.join(outDir, "README.txt"),
  "Synthetic Denticon data download for testing the BCP loader. Generated by `npm run bcp:sample`; not real patient data.\r\n",
);

// Config that fills in the one headerless table without a format file.
await writeFile(
  path.join(outDir, "..", "denticon-bcp-feed.example.json"),
  JSON.stringify(
    {
      tables: {
        patient_master: {
          entity: "patients",
          columns: ["PATID", "OFCID", "CHARTNO", "LNAME", "FNAME", "DOB", "SEX", "ACTIVE", "FIRSTVISIT", "LASTVISIT", "REFTYPE", "PROVID", "MODDATE"],
        },
        ledger: { ignore: false },
      },
    },
    null,
    2,
  ) + "\n",
);

console.log(`wrote sample download to ${outDir}`);

if (args.includes("--zip")) {
  const zip = `${outDir}.zip`;
  await rm(zip, { force: true });
  try {
    await promisify(execFile)("7z", ["a", "-tzip", "-mem=AES128", "-psample", zip, path.join(outDir, "*")]);
    console.log(`zipped (AES, password "sample") to ${zip}`);
  } catch (err) {
    console.error(`could not zip (is 7z installed?): ${(err as Error).message.split("\n")[0]}`);
  }
}
