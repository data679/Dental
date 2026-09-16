import type { ApplicationStatus, ApplicationType, Lender } from "../../types/domain.js";

// Canonical financing-application row + the header/value aliases that map real lender
// exports onto it. Every lender formats its portal export differently, so intake is
// alias-driven: add a header alias or a lender spelling here, not code.
//
// Column names below are what `GET /api/finance/import/template` hands out; a file that
// uses those exact headers needs no aliasing at all.

export const CANONICAL_COLUMNS = [
  "external_id",
  "lender",
  "application_type",
  "status",
  "submitted_date",
  "decision_date",
  "requested_amount",
  "approved_amount",
  "decline_reason",
  "funded_date",
  "funded_amount",
  "location",
  "patient_id",
  "chart_no",
  "patient_first_name",
  "patient_last_name",
  "patient_dob",
] as const;
export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

/** Header aliases, matched after `normalizeHeader()` (lowercase, non-alphanumerics → _). */
const HEADER_ALIASES: Record<CanonicalColumn, string[]> = {
  external_id: ["external_id", "application_id", "app_id", "application_number", "application", "reference", "reference_id", "ref", "ref_no", "account_number", "account", "loan_id", "id"],
  lender: ["lender", "lender_name", "financing_company", "financing_co", "financing_co_", "finance_company", "financer", "company", "partner", "source"],
  application_type: ["application_type", "type", "prime_subprime", "prime_vs_subprime", "tier", "program", "product_type"],
  status: ["status", "application_status", "decision", "result", "outcome", "app_status"],
  submitted_date: ["submitted_date", "submitted", "submission_date", "application_date", "app_date", "date_submitted", "created", "created_date", "date", "applied_date", "applied"],
  decision_date: ["decision_date", "decided", "decisioned", "decision", "approval_date", "approved_date", "declined_date", "date_decisioned", "decision_dt"],
  requested_amount: ["requested_amount", "requested", "amount_requested", "request_amount", "treatment_amount", "treatment_cost", "case_amount", "loan_requested"],
  approved_amount: ["approved_amount", "approved", "amount_approved", "credit_limit", "approval_amount", "approved_credit", "limit", "loan_amount"],
  decline_reason: ["decline_reason", "declined_reason", "reason", "denial_reason", "decision_reason", "notes"],
  funded_date: ["funded_date", "funded", "funding_date", "date_funded", "disbursed", "disbursement_date", "transaction_date", "purchase_date"],
  funded_amount: ["funded_amount", "amount_funded", "funding_amount", "disbursed_amount", "transaction_amount", "purchase_amount", "used_amount", "amount"],
  location: ["location", "practice", "practice_name", "office", "office_name", "merchant", "merchant_name", "store", "site", "clinic"],
  patient_id: ["patient_id", "denticon_patient_id", "pms_patient_id", "denticon_id", "pat_id"],
  chart_no: ["chart_no", "chart", "chart_number", "chart_num", "patient_chart", "account_no"],
  patient_first_name: ["patient_first_name", "first_name", "firstname", "first", "applicant_first_name", "customer_first_name", "given_name"],
  patient_last_name: ["patient_last_name", "last_name", "lastname", "last", "surname", "applicant_last_name", "customer_last_name", "family_name"],
  patient_dob: ["patient_dob", "dob", "date_of_birth", "birth_date", "birthdate", "applicant_dob", "customer_dob"],
};

// When one export header could mean two things (e.g. "amount", "date", "id") the earlier
// canonical column in this order wins. Explicit headers always beat these fallbacks.
const AMBIGUOUS_PRIORITY: CanonicalColumn[] = ["submitted_date", "funded_amount", "external_id"];

export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[#]/g, "no")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface ColumnMap {
  /** canonical column → index in the CSV row */
  byColumn: Partial<Record<CanonicalColumn, number>>;
  /** original header → canonical column (or null if ignored), for the audit record */
  byHeader: Record<string, CanonicalColumn | null>;
  unmapped: string[];
}

export function mapHeaders(headers: string[]): ColumnMap {
  const byColumn: Partial<Record<CanonicalColumn, number>> = {};
  const byHeader: Record<string, CanonicalColumn | null> = {};
  const unmapped: string[] = [];

  // Pass 1: exact canonical names.
  headers.forEach((h, i) => {
    const n = normalizeHeader(h);
    if ((CANONICAL_COLUMNS as readonly string[]).includes(n) && byColumn[n as CanonicalColumn] === undefined) {
      byColumn[n as CanonicalColumn] = i;
      byHeader[h] = n as CanonicalColumn;
    }
  });
  // Pass 2: aliases, first unclaimed match wins; ambiguous aliases resolved by priority.
  headers.forEach((h, i) => {
    if (byHeader[h] !== undefined) return;
    const n = normalizeHeader(h);
    const candidates = (Object.keys(HEADER_ALIASES) as CanonicalColumn[]).filter(
      (col) => HEADER_ALIASES[col].includes(n) && byColumn[col] === undefined,
    );
    const pick = candidates.length > 1 ? AMBIGUOUS_PRIORITY.find((c) => candidates.includes(c)) ?? candidates[0] : candidates[0];
    if (pick) {
      byColumn[pick] = i;
      byHeader[h] = pick;
    } else {
      byHeader[h] = null;
      unmapped.push(h);
    }
  });
  return { byColumn, byHeader, unmapped };
}

// ---------------------------------------------------------------------------------------
// Value normalisation
// ---------------------------------------------------------------------------------------

const LENDER_ALIASES: Array<[Lender, string[]]> = [
  ["care_credit", ["carecredit", "care credit", "synchrony", "cc"]],
  ["alphaeon", ["alphaeon", "alphaeon credit", "comenity"]],
  ["cherry", ["cherry", "cherry financing", "withcherry"]],
  ["proceed", ["proceed", "proceed finance", "proceedfinance"]],
  ["sunbit", ["sunbit"]],
  ["hfd", ["hfd", "healthcare finance direct", "health care finance direct"]],
  ["covered_care", ["covered care", "coveredcare"]],
  ["eve", ["eve", "eve financial"]],
  ["fortiva", ["fortiva", "fortiva retail credit", "atlanticus"]],
  ["access", ["access", "access financing", "access loans", "access one"]],
];

export function normalizeLender(raw: string | undefined): Lender | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ");
  if (!v) return null;
  for (const [lender, aliases] of LENDER_ALIASES) {
    if (aliases.includes(v) || aliases.some((a) => v.startsWith(a + " "))) return lender;
  }
  return null;
}

/**
 * Default tier per lender when the export has no type column. Prime = traditional credit
 * (CareCredit, Alphaeon, Cherry, Proceed, Eve); subprime = near-prime/second-look
 * programs (HFD, Covered Care, Sunbit, Fortiva, Access). Assumption from the storyboard's
 * "primary or subprime lender" wording — override per file with an application_type column.
 */
export const DEFAULT_APPLICATION_TYPE: Record<Lender, ApplicationType> = {
  care_credit: "primary",
  alphaeon: "primary",
  cherry: "primary",
  proceed: "primary",
  eve: "primary",
  hfd: "subprime",
  covered_care: "subprime",
  sunbit: "subprime",
  fortiva: "subprime",
  access: "subprime",
};

export function normalizeApplicationType(raw: string | undefined): ApplicationType | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!v) return null;
  if (["primary", "prime", "primarylender", "tier1", "a", "first", "firstlook"].includes(v)) return "primary";
  if (["subprime", "secondary", "sub", "nearprime", "tier2", "b", "second", "secondlook"].includes(v)) return "subprime";
  return null;
}

/** Status plus whether the row implies funding (status "funded"/"used" ⇒ approved + funding). */
export function normalizeStatus(raw: string | undefined): { status: ApplicationStatus; impliesFunded: boolean } | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ");
  if (!v) return null;
  if (/^(approved|approve|accepted|conditionally approved|prequalified|pre approved|preapproved|qualified)$/.test(v)) {
    return { status: "approved", impliesFunded: false };
  }
  if (/^(funded|used|disbursed|booked|activated|purchased|complete|completed)$/.test(v)) {
    return { status: "approved", impliesFunded: true };
  }
  if (/^(declined|decline|denied|deny|rejected|reject|not approved|unapproved)$/.test(v)) {
    return { status: "declined", impliesFunded: false };
  }
  if (/^(pending|in review|review|processing|under review|awaiting|open|referred|manual review)$/.test(v)) {
    return { status: "pending", impliesFunded: false };
  }
  if (/^(submitted|applied|new|received|started|incomplete|withdrawn|cancelled|canceled|expired)$/.test(v)) {
    // Withdrawn/expired/cancelled applications never reached a decision; keep them as
    // "submitted" so they count in the top of the funnel and nowhere else.
    return { status: "submitted", impliesFunded: false };
  }
  return null;
}

/** Accepts ISO (2026-09-01, with or without time), US (9/1/2026, 09-01-2026), and "Sep 1, 2026". */
export function normalizeDate(raw: string | undefined): string | null | "invalid" {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(v);
  if (m) return build(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[ T].*)?$/.exec(v);
  if (m) return build(m[3]!, m[1]!, m[2]!);
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/.exec(v);
  if (m) return build(`20${m[3]}`, m[1]!, m[2]!);
  const ms = Date.parse(v);
  if (!Number.isNaN(ms) && /[a-z]/i.test(v)) return new Date(ms).toISOString().slice(0, 10);
  return "invalid";

  function build(y: string, mo: string, d: string): string | "invalid" {
    const yy = Number(y), mm = Number(mo), dd = Number(d);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "invalid";
    const date = new Date(Date.UTC(yy, mm - 1, dd));
    if (date.getUTCMonth() !== mm - 1) return "invalid";
    return date.toISOString().slice(0, 10);
  }
}

/** "$1,234.50", "1234.5", "(200)" → number; blank → null; garbage → "invalid". */
export function normalizeAmount(raw: string | undefined): number | null | "invalid" {
  const v = (raw ?? "").trim();
  if (!v || v === "-" || v.toLowerCase() === "n/a") return null;
  const negative = /^\(.*\)$/.test(v);
  const cleaned = v.replace(/[$,\s()]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return "invalid";
  const n = Number(cleaned) * (negative ? -1 : 1);
  return Math.round(n * 100) / 100;
}

export function normalizeText(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return v ? v : null;
}

// ---------------------------------------------------------------------------------------
// Row → canonical record
// ---------------------------------------------------------------------------------------

export interface NormalizedApplication {
  externalId: string | null;
  lender: Lender;
  applicationType: ApplicationType;
  status: ApplicationStatus;
  submittedDate: string | null;
  decisionDate: string | null;
  requestedAmount: number | null;
  approvedAmount: number | null;
  declineReason: string | null;
  fundedDate: string | null;
  fundedAmount: number | null;
  location: string | null;
  patientId: string | null; // Denticon patient id
  chartNo: string | null;
  patientFirstName: string | null;
  patientLastName: string | null;
  patientDob: string | null;
  /** Stable key for re-imports of files without an external id. */
  dedupeKey: string;
}

export interface RowError {
  row: number; // 1-based data row number (header excluded)
  message: string;
}

export function normalizeRow(
  values: string[],
  headers: string[],
  map: ColumnMap,
  rowNumber: number,
): { ok: true; record: NormalizedApplication; raw: Record<string, string> } | { ok: false; error: RowError; raw: Record<string, string> } {
  const get = (col: CanonicalColumn) => {
    const i = map.byColumn[col];
    return i === undefined ? undefined : values[i];
  };
  const raw: Record<string, string> = {};
  headers.forEach((h, i) => (raw[h] = values[i] ?? ""));
  const fail = (message: string) => ({ ok: false as const, error: { row: rowNumber, message }, raw });

  const lender = normalizeLender(get("lender"));
  if (!lender) return fail(`unknown lender "${get("lender") ?? ""}"`);

  const statusRaw = get("status");
  const status = normalizeStatus(statusRaw);
  if (!status) return fail(statusRaw ? `unknown status "${statusRaw}"` : "status is required");

  const dates = {
    submittedDate: normalizeDate(get("submitted_date")),
    decisionDate: normalizeDate(get("decision_date")),
    fundedDate: normalizeDate(get("funded_date")),
    patientDob: normalizeDate(get("patient_dob")),
  };
  for (const [k, v] of Object.entries(dates)) if (v === "invalid") return fail(`invalid date in ${k}: "${get(k === "patientDob" ? "patient_dob" : (k.replace(/Date$/, "_date") as CanonicalColumn))}"`);

  const amounts = {
    requestedAmount: normalizeAmount(get("requested_amount")),
    approvedAmount: normalizeAmount(get("approved_amount")),
    fundedAmount: normalizeAmount(get("funded_amount")),
  };
  for (const [k, v] of Object.entries(amounts)) if (v === "invalid") return fail(`invalid amount in ${k}`);

  const typeRaw = get("application_type");
  const applicationType = normalizeApplicationType(typeRaw) ?? (typeRaw?.trim() ? null : DEFAULT_APPLICATION_TYPE[lender]);
  if (!applicationType) return fail(`unknown application type "${typeRaw}"`);

  const externalId = normalizeText(get("external_id"));
  const patientLastName = normalizeText(get("patient_last_name"));
  const patientFirstName = normalizeText(get("patient_first_name"));
  const patientId = normalizeText(get("patient_id"));
  const chartNo = normalizeText(get("chart_no"));
  if (!externalId && !patientId && !chartNo && !patientLastName) {
    return fail("row has no way to identify the application (needs an id, chart no, or patient name)");
  }

  // Funding can be expressed as a status ("Funded") or as a funded date/amount.
  const fundedDate = dates.fundedDate as string | null;
  const fundedAmount = amounts.fundedAmount as number | null;
  const impliesFunded = status.impliesFunded || fundedDate !== null || (fundedAmount !== null && fundedAmount > 0);
  const finalStatus = impliesFunded ? "approved" : status.status;

  const record: NormalizedApplication = {
    externalId,
    lender,
    applicationType,
    status: finalStatus,
    submittedDate: dates.submittedDate as string | null,
    decisionDate: (dates.decisionDate as string | null) ?? (finalStatus === "approved" || finalStatus === "declined" ? (dates.submittedDate as string | null) : null),
    requestedAmount: amounts.requestedAmount as number | null,
    approvedAmount: amounts.approvedAmount as number | null,
    declineReason: finalStatus === "declined" ? normalizeText(get("decline_reason")) : null,
    fundedDate: impliesFunded ? (fundedDate ?? (dates.decisionDate as string | null) ?? (dates.submittedDate as string | null)) : null,
    fundedAmount: impliesFunded ? (fundedAmount ?? amounts.approvedAmount as number | null) : null,
    location: normalizeText(get("location")),
    patientId,
    chartNo,
    patientFirstName,
    patientLastName,
    patientDob: dates.patientDob as string | null,
    dedupeKey: "",
  };
  record.dedupeKey = externalId
    ? `${lender}:${externalId}`
    : [lender, patientId ?? chartNo ?? `${(patientLastName ?? "").toLowerCase()}|${(patientFirstName ?? "").toLowerCase()}|${record.patientDob ?? ""}`, record.submittedDate ?? ""].join(":");
  return { ok: true, record, raw };
}
