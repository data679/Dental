export interface FunnelStageSummary {
  stage:
    | "new_patients"
    | "treatment_presented"
    | "applications_submitted"
    | "applications_approved"
    | "funded"
    | "treatment_completed";
  count: number;
}

export interface FunnelFilters {
  locationId?: number;
  providerId?: number;
  lender?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface FunnelSummaryResponse {
  filters: FunnelFilters;
  stages: FunnelStageSummary[];
  /** How the financing stages were built: cases (one patient's round) vs raw application rows. */
  financing: {
    cases: number;
    applications: number;
    multiLenderCases: number;
    avgLendersPerCase: number | null;
  };
}

export type Lender =
  | "hfd"
  | "alphaeon"
  | "cherry"
  | "care_credit"
  | "proceed"
  | "covered_care"
  | "eve"
  | "sunbit"
  | "fortiva"
  | "access";

export type ApplicationType = "primary" | "subprime";
export type ApplicationStatus = "submitted" | "pending" | "approved" | "declined";

export interface FinanceFilters {
  locationId?: number;
  dateFrom?: string;
  dateTo?: string;
  applicationType?: ApplicationType;
  status?: ApplicationStatus;
  newPatientsOnly?: boolean;
}

export interface PeriodStat {
  current: number;
  prior: number;
  pctChange: number | null;
}

export interface LenderCount {
  lender: Lender;
  count: number;
}

export interface LenderRate {
  lender: Lender;
  rate: number;
  count: number;
}

export interface MultiLenderSummary {
  cases: number;
  multiLenderCases: number;
  avgLendersPerCase: number | null;
  casesApproved: number;
  casesWithMultipleApprovals: number;
  casesFunded: number;
  casesFundedFromMultipleApprovals: number;
  inquiries: { soft: number; hard: number; unknown: number };
  chosenLenderWhenMultiApproved: Array<{ lender: Lender; offered: number; chosen: number; winRate: number | null }>;
}

export interface FinanceSummary {
  filters: FinanceFilters;
  newPatients: PeriodStat;
  newPatientsApplying: PeriodStat;
  pctNewPatientsApplying: { current: number | null; prior: number | null };
  applicationsByLender: LenderCount[];
  approvalRateByLender: LenderRate[];
  multiLender: MultiLenderSummary;
}

export interface LocationOption {
  id: number;
  name: string;
}

/**
 * Backend-free demo mode (GitHub Pages): summaries are computed in the browser from
 * public/data/snapshot.json instead of fetched from /api. See staticApi.ts.
 */
export const STATIC_MODE = import.meta.env.VITE_STATIC_SNAPSHOT === "true";
const staticApi = () => import("./staticApi");

function toQueryString(params: object): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, String(value));
  }
  return usp.toString();
}

// Thin fetch wrappers. Vite dev server proxies /api -> the backend (see vite.config.ts).

export async function getFunnelSummary(
  filters: FunnelFilters = {},
): Promise<FunnelSummaryResponse> {
  if (STATIC_MODE) return (await staticApi()).getFunnelSummary(filters);
  const res = await fetch(`/api/funnel/summary?${toQueryString(filters)}`);
  if (!res.ok) throw new Error(`Failed to load funnel summary: ${res.status}`);
  return res.json();
}

export async function getFinanceSummary(filters: FinanceFilters = {}): Promise<FinanceSummary> {
  if (STATIC_MODE) return (await staticApi()).getFinanceSummary(filters);
  const res = await fetch(`/api/finance/summary?${toQueryString(filters)}`);
  if (!res.ok) throw new Error(`Failed to load finance summary: ${res.status}`);
  return res.json();
}

export async function getLocations(): Promise<LocationOption[]> {
  if (STATIC_MODE) return (await staticApi()).getLocations();
  const res = await fetch("/api/locations");
  if (!res.ok) throw new Error(`Failed to load locations: ${res.status}`);
  const data = await res.json();
  return data.locations;
}

// ---------------------------------------------------------------------------------------
// Financing CSV intake (POST /api/finance/import and friends) — see docs/financing-intake.md
// ---------------------------------------------------------------------------------------

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportResult {
  batchId: number;
  rowCount: number;
  inserted: number;
  updated: number;
  unmatched: number;
  duplicates: number;
  rejected: number;
  errors: ImportRowError[];
  warnings: ImportRowError[];
  notes: string[];
  columnMap: Record<string, string | null>;
  unmappedHeaders: string[];
}

export interface ImportFailure {
  error: string;
  headers?: string[];
  columnMap?: Record<string, string | null>;
  unmappedHeaders?: string[];
  missingRequired?: string[];
}

export interface ImportBatch {
  id: number;
  source_file: string;
  imported_by: string | null;
  imported_at: string;
  row_count: number;
  inserted: number;
  updated: number;
  unmatched: number;
  duplicates: number;
  rejected: number;
  errors: ImportRowError[];
  warnings: ImportRowError[];
}

export interface DataQualityCheck {
  id: string;
  title: string;
  severity: "error" | "warning" | "info";
  hint: string;
  count: number;
  examples: Array<{ label: string; detail: string }>;
}

export interface DataQualityReport {
  generatedAt: string;
  summary: { errors: number; warnings: number };
  checks: DataQualityCheck[];
}

export async function getDataQuality(): Promise<DataQualityReport> {
  if (STATIC_MODE) return (await staticApi()).getDataQuality();
  const res = await fetch("/api/data-quality");
  if (!res.ok) throw new Error(`Failed to load data quality report: ${res.status}`);
  return res.json();
}

export interface UnmatchedApplication {
  id: number;
  lender: Lender;
  status: ApplicationStatus;
  submitted_date: string | null;
  external_id: string | null;
  match_status: string;
  match_detail: string | null;
  location: string | null;
  first_name: string | null;
  last_name: string | null;
  dob: string | null;
}

export async function importFinancingCsv(file: File): Promise<ImportResult> {
  if (STATIC_MODE) throw new Error("Importing is disabled in the demo — it needs the backend. Run the app locally (see README) to import a file.");
  const csv = await file.text();
  const res = await fetch(`/api/finance/import?sourceFile=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: csv,
  });
  const body = (await res.json()) as ImportResult | ImportFailure;
  if (!res.ok || "error" in body) {
    const f = body as ImportFailure;
    const detail = f.missingRequired?.length
      ? ` Headers found: ${(f.headers ?? []).join(", ")}.`
      : "";
    throw new Error(`${f.error ?? `Import failed (${res.status})`}${detail}`);
  }
  return body as ImportResult;
}

export async function getImportBatches(): Promise<ImportBatch[]> {
  if (STATIC_MODE) return (await staticApi()).getImportBatches();
  const res = await fetch("/api/finance/imports");
  if (!res.ok) throw new Error(`Failed to load imports: ${res.status}`);
  return (await res.json()).imports;
}

export async function getUnmatchedApplications(): Promise<UnmatchedApplication[]> {
  if (STATIC_MODE) return (await staticApi()).getUnmatchedApplications();
  const res = await fetch("/api/finance/unmatched");
  if (!res.ok) throw new Error(`Failed to load unmatched applications: ${res.status}`);
  return (await res.json()).unmatched;
}

export async function rematchApplications(): Promise<{ checked: number; matched: number }> {
  if (STATIC_MODE) throw new Error("Re-matching is disabled in the demo — it needs the backend.");
  const res = await fetch("/api/finance/rematch", { method: "POST" });
  if (!res.ok) throw new Error(`Rematch failed: ${res.status}`);
  return res.json();
}
