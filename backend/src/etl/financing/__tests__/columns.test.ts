import { describe, expect, it } from "vitest";
import {
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

  it("builds a canonical record, defaulting the tier per lender", () => {
    const r = normalizeRow(row({ "Application ID": "A1", Lender: "Sunbit", Status: "Approved", "Application Date": "8/3/2026", "Approved Amount": "$1,500", Practice: "Carson", "Last Name": "Chen", "First Name": "Avery", DOB: "1990-02-14" }), headers, map, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record).toMatchObject({
      externalId: "A1",
      lender: "sunbit",
      applicationType: "subprime",
      status: "approved",
      submittedDate: "2026-08-03",
      decisionDate: "2026-08-03", // defaults to submitted date for decisioned rows
      approvedAmount: 1500,
      fundedDate: null,
      location: "Carson",
      patientLastName: "Chen",
      patientDob: "1990-02-14",
      dedupeKey: "sunbit:A1",
    });
    expect(r.raw["Lender"]).toBe("Sunbit");
  });

  it("derives funding from a funded date/amount even when status just says approved", () => {
    const r = normalizeRow(row({ Lender: "CareCredit", Status: "Approved", "Application Date": "2026-08-01", "Approved Amount": "3000", "Funded Date": "2026-08-10", "Funded Amount": "2450", "Last Name": "Doe", DOB: "1985-04-12" }), headers, map, 2);
    expect(r.ok && r.record.fundedDate).toBe("2026-08-10");
    expect(r.ok && r.record.fundedAmount).toBe(2450);
    expect(r.ok && r.record.applicationType).toBe("primary");
    expect(r.ok && r.record.dedupeKey).toBe("care_credit:doe||1985-04-12:2026-08-01");
  });

  it("honours an explicit type column and rejects unusable rows with a reason", () => {
    const typed = normalizeRow(row({ Lender: "CareCredit", Status: "Declined", "Last Name": "Doe", Type: "SubPrime" }), headers, map, 3);
    expect(typed.ok && typed.record.applicationType).toBe("subprime");

    const noLender = normalizeRow(row({ Lender: "Mystery Bank", Status: "Approved", "Last Name": "Doe" }), headers, map, 4);
    expect(noLender.ok).toBe(false);
    expect(!noLender.ok && noLender.error.message).toMatch(/unknown lender/);

    const noIdentity = normalizeRow(row({ Lender: "Cherry", Status: "Approved" }), headers, map, 5);
    expect(!noIdentity.ok && noIdentity.error.message).toMatch(/identify/);

    const badDate = normalizeRow(row({ Lender: "Cherry", Status: "Approved", "Last Name": "Doe", "Application Date": "13/45/2026" }), headers, map, 6);
    expect(!badDate.ok && badDate.error.message).toMatch(/invalid date/);
  });
});
