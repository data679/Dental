import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// DB-backed tests for the import pipeline: duplicates, matching, upserts, and the
// "one bad row must not sink the file" guarantee. Skipped unless run via `npm run test:db`
// (which points DATABASE_URL at a throwaway schema and sets TEST_DB=1).

const enabled = process.env.TEST_DB === "1";
const d = describe.skipIf(!enabled);

let pool: typeof import("../../../db/pool.js").pool;
let importFinancingCsv: typeof import("../importService.js").importFinancingCsv;
let rematchUnmatchedApplications: typeof import("../importService.js").rematchUnmatchedApplications;
let matchPatient: typeof import("../matching.js").matchPatient;
let nameKey: typeof import("../columns.js").nameKey;

const csv = (headers: string, ...rows: string[]) => [headers, ...rows].join("\n");

afterAll(async () => {
  await pool?.end();
});
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1));

d("financing import (database)", () => {
  beforeAll(async () => {
    ({ pool } = await import("../../../db/pool.js"));
    ({ importFinancingCsv, rematchUnmatchedApplications } = await import("../importService.js"));
    ({ matchPatient } = await import("../matching.js"));
    ({ nameKey } = await import("../columns.js"));
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE treatment_completions, fundings, financing_applications, financing_cases, treatment_plans,
      patients, providers, locations, staging_financing_csv, financing_import_batches RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO locations (name) VALUES ('Carson'), ('West Covina')`);
    const p = async (dId: string, first: string, last: string, dob: string, loc: number) =>
      pool.query(
        `INSERT INTO patients (denticon_patient_id, location_id, first_name, last_name, birth_date, chart_no, first_name_key, last_name_key, first_visit_date)
         VALUES ($1, $2, $3, $4, $5, $1, $6, $7, '2026-01-15')`,
        [dId, loc, first, last, dob, nameKey(first), nameKey(last)],
      );
    await p("4000001", "Jane", "Doe", "1985-04-12", 1);
    await p("4000002", "José", "Muñoz-O'Brien", "1990-02-14", 1);
    await p("4000003", "Ann", "Lee", "1970-01-01", 2); // two "Ann Lee 1970-01-01" charts = PMS duplicate
    await p("4000004", "Ann", "Lee", "1970-01-01", 2);
    await p("4000005", "Bob", "Lee", "1970-01-01", 2); // same last name + DOB, different first name
  });

  it("imports, then re-imports the same file as updates (no duplicates), and refreshes status", async () => {
    const file = csv(
      "Application ID,Lender,Status,Application Date,Approved Amount,Last Name,DOB",
      "A1,CareCredit,Pending,9/1/2026,,Doe,4/12/1985",
      "A2,Cherry,Declined,9/2/2026,,Doe,4/12/1985",
    );
    const first = await importFinancingCsv({ csvText: file, sourceFile: "f.csv" });
    expect(first).toMatchObject({ rowCount: 2, inserted: 2, updated: 0, duplicates: 0, rejected: 0, unmatched: 0 });

    const second = await importFinancingCsv({
      csvText: file.replace("A1,CareCredit,Pending,9/1/2026,", "A1,CareCredit,Approved,9/1/2026,3000"),
      sourceFile: "f-later.csv",
    });
    expect(second).toMatchObject({ inserted: 0, updated: 2, duplicates: 0 });
    const { rows } = await pool.query("SELECT external_id, status, approved_amount::float AS amt FROM financing_applications ORDER BY external_id");
    expect(rows).toEqual([
      { external_id: "A1", status: "approved", amt: 3000 },
      { external_id: "A2", status: "declined", amt: null },
    ]);
  });

  it("flags the same application repeated within one file and keeps the first", async () => {
    const r = await importFinancingCsv({
      csvText: csv(
        "Application ID,Lender,Status,Application Date,Last Name,DOB",
        "A1,CareCredit,Approved,9/1/2026,Doe,4/12/1985",
        "A1,CareCredit,Declined,9/1/2026,Doe,4/12/1985",
        ",Sunbit,Approved,9/3/2026,Doe,4/12/1985",
        ",Sunbit,Approved,9/3/2026,Doe,4/12/1985",
      ),
      sourceFile: "dupes.csv",
    });
    expect(r).toMatchObject({ inserted: 2, updated: 0, duplicates: 2, rejected: 0 });
    const dupWarnings = r.warnings.filter((w) => /duplicate of row/.test(w.message));
    expect(dupWarnings.map((w) => w.row)).toEqual([2, 4]);
    expect(dupWarnings[0]!.message).toMatch(/duplicate of row 1 \(application A1\)/);
    expect(dupWarnings[1]!.message).toMatch(/duplicate of row 3 \(same lender, patient and date\)/);
    expect(r.warnings.filter((w) => w.row === 2 || w.row === 4)).toEqual(dupWarnings); // skipped rows get no other noise
    const { rows } = await pool.query("SELECT status FROM financing_applications WHERE external_id = 'A1'");
    expect(rows[0]!.status).toBe("approved"); // first occurrence won
    const { rows: st } = await pool.query("SELECT outcome FROM staging_financing_csv ORDER BY row_number");
    expect(st.map((s) => s.outcome)).toEqual(["inserted", "duplicate", "inserted", "duplicate"]);
  });

  it("flags a possible duplicate across files: same patient, lender, date, different id", async () => {
    await importFinancingCsv({
      csvText: csv("Application ID,Lender,Status,Application Date,Last Name,DOB", "X-1,Cherry,Approved,9/5/2026,Doe,4/12/1985"),
      sourceFile: "a.csv",
    });
    const r = await importFinancingCsv({
      csvText: csv("Application ID,Lender,Status,Application Date,Last Name,DOB", "Y-9,Cherry,Approved,9/5/2026,Doe,4/12/1985"),
      sourceFile: "b.csv",
    });
    expect(r.inserted).toBe(1);
    expect(r.warnings.some((w) => /possible duplicate of application #1/.test(w.message))).toBe(true);
    const { rows } = await pool.query("SELECT possible_duplicate_of FROM financing_applications WHERE external_id = 'Y-9'");
    expect(Number(rows[0]!.possible_duplicate_of)).toBe(1);
  });

  it("rejects only the bad rows and still commits the good ones", async () => {
    const r = await importFinancingCsv({
      csvText: csv(
        "Lender,Status,Application Date,Approved Amount,Last Name,DOB",
        "CareCredit,Approved,9/1/2026,99999999999999,Doe,4/12/1985", // would overflow NUMERIC(12,2)
        "CareCredit,Approved,9/1/2026,-5,Doe,4/12/1985",
        "Bank of Nowhere,Approved,9/1/2026,100,Doe,4/12/1985",
        "CareCredit,Maybe,9/1/2026,100,Doe,4/12/1985",
        "CareCredit,Approved,2/30/2026,100,Doe,4/12/1985",
        "CareCredit,Approved,9/1/2026,100,,",
        "Cherry,Approved,9/2/2026,100,Doe,4/12/1985", // the one good row
      ),
      sourceFile: "mixed.csv",
    });
    expect(r).toMatchObject({ rowCount: 7, inserted: 1, rejected: 6 });
    expect(r.errors.map((e) => e.row)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/over \$10,000,000/),
      expect.stringMatching(/negative approved_amount/),
      expect.stringMatching(/unknown lender/),
      expect.stringMatching(/unknown status/),
      expect.stringMatching(/invalid submitted_date/),
      expect.stringMatching(/no way to identify/),
    ]);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM financing_applications");
    expect(rows[0]!.n).toBe(1);
    const { rows: b } = await pool.query("SELECT row_count, inserted, rejected, jsonb_array_length(errors) AS errs FROM financing_import_batches");
    expect(b[0]).toMatchObject({ row_count: 7, inserted: 1, rejected: 6, errs: 6 });
  });

  it("matches through accents, hyphens, apostrophes and case", async () => {
    const r = await importFinancingCsv({
      csvText: csv("Lender,Status,Application Date,First Name,Last Name,DOB", "Sunbit,Approved,9/1/2026,JOSE,munoz obrien,2/14/1990"),
      sourceFile: "accents.csv",
    });
    expect(r.unmatched).toBe(0);
    const { rows } = await pool.query("SELECT p.denticon_patient_id, fa.match_detail FROM financing_applications fa JOIN patients p ON p.id = fa.patient_id");
    expect(rows[0]).toEqual({ denticon_patient_id: "4000002", match_detail: "last_name+dob" });
  });

  it("reports ambiguous when two charts share name and DOB, and resolves by first name when it can", async () => {
    const amb = await matchPatient({ patientLastName: "Lee", patientFirstName: "Ann", patientDob: "1970-01-01", patientId: null, chartNo: null } as any);
    expect(amb.status).toBe("ambiguous");
    expect(amb.detail).toMatch(/duplicate charts/);
    const bob = await matchPatient({ patientLastName: "Lee", patientFirstName: "Bob", patientDob: "1970-01-01", patientId: null, chartNo: null } as any);
    expect(bob).toMatchObject({ status: "matched", detail: "last_name+dob+first_name" });
    const nobody = await matchPatient({ patientLastName: "Lee", patientFirstName: null, patientDob: "1999-09-09", patientId: null, chartNo: null } as any);
    expect(nobody.status).toBe("unmatched");
  });

  it("imports unmatched rows, counts them in the funnel via their own location, and links them later", async () => {
    const r = await importFinancingCsv({
      csvText: csv("Lender,Status,Application Date,Practice,Last Name,DOB", "HFD,Approved,9/1/2026,Sample Dental – West Covina,Newcomer,3/3/1993"),
      sourceFile: "late.csv",
    });
    expect(r).toMatchObject({ inserted: 1, unmatched: 1 });
    const { rows } = await pool.query("SELECT patient_id, location_id, match_status FROM financing_applications");
    expect(rows[0]).toEqual({ patient_id: null, location_id: "2", match_status: "unmatched" });

    // The patient arrives from Denticon; the next rematch links the application and fills location.
    await pool.query(
      `INSERT INTO patients (denticon_patient_id, location_id, first_name, last_name, birth_date, first_name_key, last_name_key)
       VALUES ('4000099', 2, 'Nina', 'Newcomer', '1993-03-03', 'nina', 'newcomer')`,
    );
    const rm = await rematchUnmatchedApplications();
    expect(rm).toEqual({ checked: 1, matched: 1 });
    const { rows: after } = await pool.query("SELECT p.denticon_patient_id, fa.match_status FROM financing_applications fa JOIN patients p ON p.id = fa.patient_id");
    expect(after[0]).toEqual({ denticon_patient_id: "4000099", match_status: "matched" });
  });

  it("turns 'Funded' or a funded amount into a funding with utilisation, and warns on contradictions", async () => {
    const r = await importFinancingCsv({
      csvText: csv(
        "Application ID,Lender,Status,Application Date,Decision Date,Approved Amount,Funded Date,Funded Amount,Last Name,DOB",
        "F1,CareCredit,Funded,9/1/2026,9/1/2026,2000,9/10/2026,1500,Doe,4/12/1985",
        "F2,CareCredit,Approved,9/2/2026,9/2/2026,1000,,1500,Doe,4/12/1985", // funded > approved
        "F3,CareCredit,Declined,9/3/2026,9/3/2026,,9/12/2026,300,Doe,4/12/1985", // declined but funded
        "F4,CareCredit,Approved,9/10/2026,9/4/2026,500,,,Doe,4/12/1985", // decided before submitted
        "F5,CareCredit,Approved,,,500,,,Doe,4/12/1985", // no dates
      ),
      sourceFile: "funding.csv",
    });
    expect(r.inserted).toBe(5);
    const { rows } = await pool.query(
      `SELECT fa.external_id, fa.status, f.funded_amount::float AS funded, f.utilization_pct::float AS util
         FROM financing_applications fa LEFT JOIN fundings f ON f.application_id = fa.id ORDER BY fa.external_id`,
    );
    expect(rows).toEqual([
      { external_id: "F1", status: "approved", funded: 1500, util: 75 },
      { external_id: "F2", status: "approved", funded: 1500, util: 150 },
      { external_id: "F3", status: "approved", funded: 300, util: null },
      { external_id: "F4", status: "approved", funded: null, util: null },
      { external_id: "F5", status: "approved", funded: null, util: null },
    ]);
    const has = (row: number, re: RegExp) => r.warnings.some((w) => w.row === row && re.test(w.message));
    expect(has(2, /exceeds approved/)).toBe(true);
    expect(has(3, /status "Declined" but a funded date/)).toBe(true);
    expect(has(4, /decision date .* before submitted/)).toBe(true);
    expect(has(5, /no dates at all/)).toBe(true);
    expect(r.warnings.some((w) => /possible duplicate/.test(w.message))).toBe(false);
  });

  it("copes with a large file", async () => {
    const big = csv(
      "Application ID,Lender,Status,Application Date,Last Name,DOB",
      ...lines(3000, (i) => `B${i},Sunbit,${i % 3 ? "Approved" : "Declined"},9/${(i % 28) + 1}/2026,Doe,4/12/1985`),
    );
    const t = Date.now();
    const r = await importFinancingCsv({ csvText: big, sourceFile: "big.csv" });
    expect(r).toMatchObject({ rowCount: 3000, inserted: 3000, rejected: 0, duplicates: 0 });
    expect(Date.now() - t).toBeLessThan(60_000);
  }, 90_000);
});

d("funnel with imperfect financing data (database)", () => {
  let getFunnelSummary: typeof import("../../../services/funnelService.js").getFunnelSummary;
  beforeAll(async () => {
    ({ getFunnelSummary } = await import("../../../services/funnelService.js"));
  });

  it("counts unmatched applications by the location named in the file, and drops them under a provider filter", async () => {
    await pool.query(`TRUNCATE fundings, financing_applications, financing_cases, staging_financing_csv, financing_import_batches RESTART IDENTITY CASCADE`);
    await importFinancingCsv({
      csvText: csv(
        "Lender,Status,Application Date,Practice,Last Name,DOB,Funded Date",
        "HFD,Approved,9/1/2026,West Covina,Stranger,3/3/1993,9/5/2026", // unmatched, funded
        "Cherry,Declined,9/2/2026,,Doe,4/12/1985,", // matched → location from patient (Carson)
        "Sunbit,Approved,,Carson,Doe,4/12/1985,", // no date → invisible in date-filtered views
      ),
      sourceFile: "funnel.csv",
    });
    const stage = (s: Awaited<ReturnType<typeof getFunnelSummary>>, name: string) => s.stages.find((x) => x.stage === name)!.count;

    // Funnel counts cases: Stranger (1 case, funded) and Doe (2 rows → 1 case: the
    // undated row joins the dated one; the case is "approved" because one lender approved).
    const all = await getFunnelSummary({});
    expect([stage(all, "applications_submitted"), stage(all, "applications_approved"), stage(all, "funded")]).toEqual([2, 2, 1]);
    expect(all.financing).toEqual({ cases: 2, applications: 3, multiLenderCases: 1, avgLendersPerCase: 1.5 });

    const dated = await getFunnelSummary({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(stage(dated, "applications_submitted")).toBe(2);

    const westCovina = await getFunnelSummary({ locationId: 2 });
    expect([stage(westCovina, "applications_submitted"), stage(westCovina, "funded")]).toEqual([1, 1]);

    const carson = await getFunnelSummary({ locationId: 1 });
    expect(stage(carson, "applications_submitted")).toBe(1);

    const byProvider = await getFunnelSummary({ providerId: 999 });
    expect(stage(byProvider, "applications_submitted")).toBe(0); // unmatched rows can't satisfy a provider filter
  });
});

d("multi-lender cases (database)", () => {
  let getFinanceSummary: typeof import("../../../services/financeService.js").getFinanceSummary;
  let getFunnelSummary: typeof import("../../../services/funnelService.js").getFunnelSummary;
  beforeAll(async () => {
    ({ getFinanceSummary } = await import("../../../services/financeService.js"));
    ({ getFunnelSummary } = await import("../../../services/funnelService.js"));
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE fundings, financing_applications, financing_cases, staging_financing_csv, financing_import_batches RESTART IDENTITY CASCADE`);
  });
  const cases = async () =>
    (await pool.query("SELECT case_id, applications::int, lenders::int, approvals::int, funded, chosen_lender, outcome, opened_date::text AS opened FROM financing_case_summary ORDER BY case_id")).rows;

  it("groups one patient's same-week soft checks into one case; the funnel counts the case once", async () => {
    await importFinancingCsv({
      csvText: csv(
        "Application ID,Lender,Status,Inquiry Type,Application Date,Approved Amount,Purchase Date,Purchase Amount,Last Name,DOB",
        "CC-1,CareCredit,Prequalified,soft,9/1/2026,3000,,,Doe,4/12/1985",
        "CH-1,Cherry,Pre-approved,soft,9/1/2026,2500,9/9/2026,2400,Doe,4/12/1985", // the one the patient picked
        "SB-1,Sunbit,Declined,soft,9/2/2026,,,,Doe,4/12/1985",
        "HF-1,HFD,Approved,,10/15/2026,1500,,,Doe,4/12/1985", // 6 weeks later: a different treatment → new case
      ),
      sourceFile: "multi.csv",
    });
    expect(await cases()).toEqual([
      { case_id: "1", applications: 3, lenders: 3, approvals: 2, funded: true, chosen_lender: "cherry", outcome: "funded", opened: "2026-09-01" },
      { case_id: "2", applications: 1, lenders: 1, approvals: 1, funded: false, chosen_lender: null, outcome: "approved", opened: "2026-10-15" },
    ]);
    const f = await getFunnelSummary({});
    const by = Object.fromEntries(f.stages.map((s) => [s.stage, s.count]));
    expect([by.applications_submitted, by.applications_approved, by.funded]).toEqual([2, 2, 1]);
    expect(f.financing).toEqual({ cases: 2, applications: 4, multiLenderCases: 1, avgLendersPerCase: 2 });

    const { rows } = await pool.query("SELECT external_id, inquiry_type FROM financing_applications ORDER BY external_id");
    expect(rows).toEqual([
      { external_id: "CC-1", inquiry_type: "soft" },
      { external_id: "CH-1", inquiry_type: "soft" },
      { external_id: "HF-1", inquiry_type: null },
      { external_id: "SB-1", inquiry_type: "soft" },
    ]);
  });

  it("uses an explicit request id when the export has one, even across the date window", async () => {
    await importFinancingCsv({
      csvText: csv(
        "Request ID,Application ID,Lender,Status,Application Date,Last Name,DOB",
        "R-1,A,CareCredit,Approved,9/1/2026,Doe,4/12/1985",
        "R-1,B,Cherry,Declined,10/20/2026,Doe,4/12/1985", // same request, resubmitted much later
        "R-2,C,Sunbit,Approved,9/1/2026,Doe,4/12/1985", // same day but a different request
      ),
      sourceFile: "req.csv",
    });
    const rows = await cases();
    expect(rows.map((r) => [r.applications, r.opened])).toEqual([[2, "2026-09-01"], [1, "2026-09-01"]]);
  });

  it("reports which lender won when the patient had several approvals", async () => {
    await importFinancingCsv({
      csvText: csv(
        "Application ID,Lender,Status,Application Date,Approved Amount,Purchase Date,Purchase Amount,First Name,Last Name,DOB",
        // Doe: CareCredit + Cherry approved, chose Cherry
        "1,CareCredit,Approved,9/1/2026,3000,,,Jane,Doe,4/12/1985",
        "2,Cherry,Approved,9/1/2026,2500,9/5/2026,2400,Jane,Doe,4/12/1985",
        // Muñoz: CareCredit + Cherry + Sunbit approved, chose CareCredit
        "3,CareCredit,Approved,9/3/2026,4000,9/8/2026,3900,José,Muñoz-O'Brien,2/14/1990",
        "4,Cherry,Approved,9/3/2026,3500,,,José,Muñoz-O'Brien,2/14/1990",
        "5,Sunbit,Approved,9/3/2026,3000,,,José,Muñoz-O'Brien,2/14/1990",
        // Bob Lee: only one approval → not a "choice", excluded from win rates
        "6,Sunbit,Approved,9/4/2026,1000,9/6/2026,900,Bob,Lee,1/1/1970",
        "7,Cherry,Declined,9/4/2026,,,,Bob,Lee,1/1/1970",
      ),
      sourceFile: "wins.csv",
    });
    const s = await getFinanceSummary({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(s.multiLender).toMatchObject({
      cases: 3,
      multiLenderCases: 3,
      avgLendersPerCase: 2.33,
      casesApproved: 3,
      casesWithMultipleApprovals: 2,
      casesFunded: 3,
      casesFundedFromMultipleApprovals: 2,
      inquiries: { soft: 0, hard: 0, unknown: 7 },
    });
    expect(s.multiLender.chosenLenderWhenMultiApproved).toEqual([
      { lender: "care_credit", offered: 2, chosen: 1, winRate: 50 },
      { lender: "cherry", offered: 2, chosen: 1, winRate: 50 },
      { lender: "sunbit", offered: 1, chosen: 0, winRate: 0 },
    ]);
    // Lender-level charts still count every application.
    expect(s.applicationsByLender.map((x) => [x.lender, x.count])).toEqual([["cherry", 3], ["care_credit", 2], ["sunbit", 2]]);
  });

  it("regroups an application with the patient's case once the patient is matched later", async () => {
    await importFinancingCsv({
      csvText: csv("Application ID,Lender,Status,Application Date,Last Name,DOB", "K1,CareCredit,Approved,9/1/2026,Latecomer,5/5/1995"),
      sourceFile: "a.csv",
    });
    await importFinancingCsv({
      csvText: csv("Application ID,Lender,Status,Application Date,Last Name,DOB", "K2,Cherry,Declined,9/2/2026,Latecomer,5/5/1995"),
      sourceFile: "b.csv",
    });
    expect((await cases()).map((c) => c.applications)).toEqual([2]); // grouped by name key while unmatched
    await pool.query(
      `INSERT INTO patients (denticon_patient_id, location_id, first_name, last_name, birth_date, first_name_key, last_name_key)
       VALUES ('4000777', 1, 'Lou', 'Latecomer', '1995-05-05', 'lou', 'latecomer')`,
    );
    await rematchUnmatchedApplications();
    const after = await cases();
    expect(after).toHaveLength(1);
    expect(after[0]!.applications).toBe(2);
    const { rows } = await pool.query("SELECT DISTINCT case_key FROM financing_cases");
    expect(rows[0]!.case_key).toMatch(/^patient:/);
  });
});
