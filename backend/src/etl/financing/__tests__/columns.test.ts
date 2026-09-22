import { describe, expect, it } from "vitest";
import {
  DEFAULT_LENDER_TIERS,
  mapHeaders,
  normalizeAmount,
  normalizeDate,
  normalizeLender,
  normalizeRow,
  normalizeStatus,
} from "../columns.js";

describe("mapHeaders", () => {
  it("maps a CareCredit-style export via aliases and reports the rest", () => {
    const headers = ["Application ID", "Financing Co.", "Decision", "Application Date", "Credit Limit", "Merchant Name", "Applicant First Name", "Applicant Last Name", "DOB", "Promo Code"];
    const m = mapHeaders(headers);
    expect(m.byHeader).toMatchObject({
      "Application ID": "external_id",
      "Financing Co.": "lender",
      Decision: "status",
      "Application Date": "submitted_date",
      "Credit Limit": "approved_amount",
      "Merchant Name": "location",
      "Applicant First Name": "patient_first_name",
      "Applicant Last Name": "patient_last_name",
      DOB: "patient_dob",
      "Promo Code": null,
    });
    expect(m.unmapped).toEqual(["Promo Code"]);
  });

  it("lets exact canonical headers win over aliases and resolves ambiguous ones by priority", () => {
    const m = mapHeaders(["date", "amount", "id", "lender", "status", "submitted_date"]);
    expect(m.byHeader.submitted_date).toBe("submitted_date");
    expect(m.byHeader.date).toBeNull(); // submitted_date already claimed by the exact header; "date" is too vague to reassign
    expect(m.byHeader.amount).toBe("funded_amount");
    expect(m.byHeader.id).toBe("external_id");
  });
});

describe("value normalisers", () => {
  it("recognises lender spellings", () => {
    expect(normalizeLender("CareCredit")).toBe("care_credit");
    expect(normalizeLender("Care Credit (Synchrony)")).toBe("care_credit");
    expect(normalizeLender("Synchrony")).toBe("care_credit");
    expect(normalizeLender("HFD")).toBe("hfd");
    expect(normalizeLender("Healthcare Finance Direct")).toBe("hfd");
    expect(normalizeLender("Proceed Finance")).toBe("proceed");
    expect(normalizeLender("Covered Care")).toBe("covered_care");
    expect(normalizeLender("Bob's Loans")).toBeNull();
  });

  it("maps statuses, and treats funded/used as approved + funding", () => {
    expect(normalizeStatus("Approved")).toEqual({ status: "approved", impliesFunded: false });
    expect(normalizeStatus("DENIED")).toEqual({ status: "declined", impliesFunded: false });
    expect(normalizeStatus("In Review")).toEqual({ status: "pending", impliesFunded: false });
    expect(normalizeStatus("Funded")).toEqual({ status: "approved", impliesFunded: true });
    expect(normalizeStatus("Expired")).toEqual({ status: "submitted", impliesFunded: false });
    expect(normalizeStatus("???")).toBeNull();
  });

  it("parses US and ISO dates, rejects impossible ones", () => {
    expect(normalizeDate("9/1/2026")).toBe("2026-09-01");
    expect(normalizeDate("09-01-2026")).toBe("2026-09-01");
    expect(normalizeDate("2026-09-01T14:00:00Z")).toBe("2026-09-01");
    expect(normalizeDate("Sep 1, 2026")).toBe("2026-09-01");
    expect(normalizeDate("2/30/2026")).toBe("invalid");
    expect(normalizeDate("")).toBeNull();
  });

  it("parses currency", () => {
    expect(normalizeAmount("$1,234.50")).toBe(1234.5);
    expect(normalizeAmount("(200)")).toBe(-200);
    expect(normalizeAmount("n/a")).toBeNull();
    expect(normalizeAmount("twelve")).toBe("invalid");
  });
});

describe("normalizeRow", () => {
  const headers = ["Application ID", "Lender", "Status", "Application Date", "Approved Amount", "Funded Date", "Funded Amount", "Practice", "Last Name", "First Name", "DOB", "Type"];
  const map = mapHeaders(headers);
  const row = (over: Partial<Record<(typeof headers)[number], string>>) =>
    headers.map((h) => over[h] ?? "");

  it("builds a canonical record; a single-program lender gets its tier without a column", () => {
    const r = normalizeRow(row({ "Application ID": "A1", Lender: "HFD", Status: "Approved", "Application Date": "8/3/2026", "Approved Amount": "$1,500", Practice: "Carson", "Last Name": "Chen", "First Name": "Avery", DOB: "1990-02-14" }), headers, map, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record).toMatchObject({
      externalId: "A1",
      lender: "hfd",
      applicationType: "subprime",
      applicationTypeSource: "lender_only_tier",
      status: "approved",
      submittedDate: "2026-08-03",
      decisionDate: "2026-08-03", // defaults to submitted date for decisioned rows
      approvedAmount: 1500,
      fundedDate: null,
      location: "Carson",
      patientLastName: "Chen",
      patientDob: "1990-02-14",
      dedupeKey: "hfd:A1",
    });
    expect(r.raw["Lender"]).toBe("HFD");
  });

  it("tiers: file wins; both-program lenders are unknown without a column; contradictions warn", () => {
    // Cherry runs both programs → silent file ⇒ unknown, not a guess
    const both = normalizeRow(row({ Lender: "Cherry", Status: "Approved", "Last Name": "Doe", DOB: "1/1/1990" }), headers, map, 1);
    expect(both.ok && both.record.applicationType).toBeNull();
    expect(both.ok && both.record.applicationTypeSource).toBe("unknown");
    // …and with a Program column it's known
    const stated = normalizeRow(row({ Lender: "Cherry", Status: "Approved", "Last Name": "Doe", DOB: "1/1/1990", Type: "SubPrime" }), headers, map, 2);
    expect(stated.ok && stated.record).toMatchObject({ applicationType: "subprime", applicationTypeSource: "file" });
    // CareCredit is prime-only: a file saying subprime is kept but flagged
    const contra = normalizeRow(row({ Lender: "CareCredit", Status: "Approved", "Last Name": "Doe", DOB: "1/1/1990", Type: "SubPrime" }), headers, map, 3);
    expect(contra.ok && contra.record.applicationType).toBe("subprime");
    expect(contra.warnings.map((w) => w.message)).toContainEqual(expect.stringMatching(/configured as prime only/));
    // configuration is injectable (what the lenders table provides at import time)
    const custom = normalizeRow(row({ Lender: "Cherry", Status: "Approved", "Last Name": "Doe", DOB: "1/1/1990" }), headers, map, 4, {
      lenderTiers: { ...DEFAULT_LENDER_TIERS, cherry: { prime: true, subprime: false } },
    });
    expect(custom.ok && custom.record).toMatchObject({ applicationType: "primary", applicationTypeSource: "lender_only_tier" });
  });

  it("derives funding from a funded date/amount even when status just says approved", () => {
    const r = normalizeRow(row({ Lender: "CareCredit", Status: "Approved", "Application Date": "2026-08-01", "Approved Amount": "3000", "Funded Date": "2026-08-10", "Funded Amount": "2450", "Last Name": "Doe", DOB: "1985-04-12" }), headers, map, 2);
    expect(r.ok && r.record.fundedDate).toBe("2026-08-10");
    expect(r.ok && r.record.fundedAmount).toBe(2450);
    expect(r.ok && r.record.applicationType).toBe("primary");
    expect(r.ok && r.record.dedupeKey).toBe("care_credit:doe||1985-04-12:2026-08-01");
  });

  it("honours an explicit type column and rejects unusable rows with a reason", () => {
    const typed = normalizeRow(row({ Lender: "Cherry", Status: "Declined", "Last Name": "Doe", Type: "SubPrime" }), headers, map, 3);
    expect(typed.ok && typed.record.applicationType).toBe("subprime");

    const noLender = normalizeRow(row({ Lender: "Mystery Bank", Status: "Approved", "Last Name": "Doe" }), headers, map, 4);
    expect(noLender.ok).toBe(false);
    expect(!noLender.ok && noLender.error.message).toMatch(/unknown lender/);

    const noIdentity = normalizeRow(row({ Lender: "Cherry", Status: "Approved" }), headers, map, 5);
    expect(!noIdentity.ok && noIdentity.error.message).toMatch(/identify/);

    const badDate = normalizeRow(row({ Lender: "Cherry", Status: "Approved", "Last Name": "Doe", "Application Date": "13/45/2026" }), headers, map, 6);
    expect(!badDate.ok && badDate.error.message).toMatch(/invalid submitted_date/);
  });
});

describe("edge cases", () => {
  const H = ["Lender", "Status", "Application Date", "Approved Amount", "Funded Amount", "Type", "Last Name", "First Name", "DOB"];
  const M = mapHeaders(H);
  const run = (over: Partial<Record<(typeof H)[number], string>>, today = "2026-09-17") =>
    normalizeRow(H.map((h) => over[h] ?? ""), H, M, 1, { today });
  const base = { Lender: "Cherry", Status: "Approved", "Application Date": "9/1/2026", "Last Name": "Doe", DOB: "1/1/1990" };

  it("keeps both columns when a header name repeats", () => {
    const headers = ["Lender", "Status", "Amount", "Amount", "Last Name"];
    const m = mapHeaders(headers);
    expect(Object.keys(m.byHeader)).toEqual(["Lender", "Status", "Amount", "Amount (2)", "Last Name"]);
    expect(m.byHeader["Amount"]).toBe("funded_amount");
    expect(m.byHeader["Amount (2)"]).toBeNull();
    const r = normalizeRow(["Cherry", "Approved", "100", "200", "Doe"], headers, m, 1);
    expect(r.raw).toEqual({ Lender: "Cherry", Status: "Approved", Amount: "100", "Amount (2)": "200", "Last Name": "Doe" });
  });

  it("reads an unambiguous day-first date and says so; rejects an impossible one", () => {
    const r = run({ ...base, "Application Date": "31/12/2025" });
    expect(r.ok && r.record.submittedDate).toBe("2025-12-31");
    expect(r.warnings.map((w) => w.message)).toContainEqual(expect.stringMatching(/read as day-first/));
    expect(normalizeDate("13/45/2026")).toBe("invalid");
    expect(normalizeDate("1/2/2026")).toBe("2026-01-02"); // ambiguous → US
  });

  it("rejects amounts that would overflow the database, and negatives", () => {
    expect(run({ ...base, "Approved Amount": "99999999999999" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/over \$10,000,000/) } });
    expect(run({ ...base, "Approved Amount": "(500)" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/negative/) } });
    expect(run({ ...base, "Approved Amount": "$9,999,999.99" }).ok).toBe(true);
  });

  it("treats an unrecognised tier value as not stated, with a warning, instead of rejecting the row", () => {
    const r = run({ ...base, Type: "Standard" });
    expect(r.ok && r.record.applicationType).toBeNull(); // Cherry runs both programs
    expect(r.warnings[0]!.message).toMatch(/unknown application type "Standard" — treated as not stated/);
    const hfd = run({ ...base, Lender: "HFD", Type: "Standard" });
    expect(hfd.ok && hfd.record.applicationType).toBe("subprime");
  });

  it("drops an impossible DOB from matching but keeps the row", () => {
    const future = run({ ...base, DOB: "1/1/2090" });
    expect(future.ok && future.record.patientDob).toBeNull();
    expect(future.warnings.map((w) => w.message)).toContainEqual(expect.stringMatching(/in the future/));
    const ancient = run({ ...base, DOB: "1/1/1850" });
    expect(ancient.ok && ancient.record.patientDob).toBeNull();
    expect(ancient.warnings.map((w) => w.message)).toContainEqual(expect.stringMatching(/over 120 years/));
  });

  it("warns on future dates and on funded > approved, and flips declined+funded to funded", () => {
    const r = run({ ...base, "Application Date": "12/25/2026", "Approved Amount": "100", "Funded Amount": "500", Status: "Declined" });
    expect(r.ok && r.record.status).toBe("approved");
    const msgs = r.warnings.map((w) => w.message);
    expect(msgs).toContainEqual(expect.stringMatching(/submitted date 2026-12-25 is in the future/));
    expect(msgs).toContainEqual(expect.stringMatching(/exceeds approved/));
    expect(msgs).toContainEqual(expect.stringMatching(/status "Declined" but a funded amount/));
  });

  it("uses another date when submitted is blank, and says when there are none", () => {
    const H2 = ["Lender", "Status", "Decision Date", "Last Name", "DOB"];
    const M2 = mapHeaders(H2);
    const withDecision = normalizeRow(["Cherry", "Approved", "9/3/2026", "Doe", "1/1/1990"], H2, M2, 1);
    expect(withDecision.ok && withDecision.record.submittedDate).toBe("2026-09-03");
    expect(withDecision.warnings[0]!.message).toMatch(/no submitted date — using the earliest other date/);
    const none = normalizeRow(["Cherry", "Approved", "", "Doe", "1/1/1990"], H2, M2, 2);
    expect(none.ok && none.record.submittedDate).toBeNull();
    expect(none.warnings[0]!.message).toMatch(/no dates at all/);
  });

  it("only nags about missing per-row identifiers/amounts when the file has those columns", () => {
    const noCols = mapHeaders(["Lender", "Status", "Last Name"]);
    const r = normalizeRow(["Cherry", "Approved", "Doe"], ["Lender", "Status", "Last Name"], noCols, 1);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    const withCols = run({ ...base, DOB: "", "Approved Amount": "" });
    expect(withCols.warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/approved with no approved amount/),
      expect.stringMatching(/matching by name only/),
    ]);
  });

  it("builds the same dedupe key regardless of name punctuation, case or accents", () => {
    const a = run({ ...base, "Last Name": "Muñoz-O'Brien", "First Name": "José" });
    const b = run({ ...base, "Last Name": "MUNOZ OBRIEN", "First Name": "jose" });
    expect(a.ok && b.ok && a.record.dedupeKey).toBe(b.ok && b.record.dedupeKey);
    expect(a.ok && a.record.dedupeKey).toBe("cherry:munozobrien|jose|1990-01-01:2026-09-01");
  });
});
