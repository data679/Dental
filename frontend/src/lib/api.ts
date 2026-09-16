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

export interface FinanceSummary {
  filters: FinanceFilters;
  newPatients: PeriodStat;
  newPatientsApplying: PeriodStat;
  pctNewPatientsApplying: { current: number | null; prior: number | null };
  applicationsByLender: LenderCount[];
  approvalRateByLender: LenderRate[];
}

export interface LocationOption {
  id: number;
  name: string;
}

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
  const res = await fetch(`/api/funnel/summary?${toQueryString(filters)}`);
  if (!res.ok) throw new Error(`Failed to load funnel summary: ${res.status}`);
  return res.json();
}

export async function getFinanceSummary(filters: FinanceFilters = {}): Promise<FinanceSummary> {
  const res = await fetch(`/api/finance/summary?${toQueryString(filters)}`);
  if (!res.ok) throw new Error(`Failed to load finance summary: ${res.status}`);
  return res.json();
}

export async function getLocations(): Promise<LocationOption[]> {
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
  rejected: number;
  errors: ImportRowError[];
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
  rejected: number;
  errors: ImportRowError[];
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
  const res = await fetch("/api/finance/imports");
  if (!res.ok) throw new Error(`Failed to load imports: ${res.status}`);
  return (await res.json()).imports;
}

export async function getUnmatchedApplications(): Promise<UnmatchedApplication[]> {
  const res = await fetch("/api/finance/unmatched");
  if (!res.ok) throw new Error(`Failed to load unmatched applications: ${res.status}`);
  return (await res.json()).unmatched;
}

export async function rematchApplications(): Promise<{ checked: number; matched: number }> {
  const res = await fetch("/api/finance/rematch", { method: "POST" });
  if (!res.ok) throw new Error(`Rematch failed: ${res.status}`);
  return res.json();
}
