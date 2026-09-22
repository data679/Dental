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
  applicationType?: ApplicationType | "unknown";
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

export interface StatusBreakdownRow {
  status: ApplicationStatus;
  statusDetail: string | null;
  outcomeClass: "open" | "decided" | "abandoned" | null;
  count: number;
}

export interface PracticeRow {
  locationId: number | null;
  name: string;
  newPatients: number;
  newPatientsApplying: number;
  pctNewPatientsApplying: number | null;
  applications: number;
  approved: number;
  declined: number;
  approvalRate: number | null;
  approvalRateOfDecisioned: number | null;
  approvalAmount: number;
  averageApprovalAmount: number | null;
  collectedFromApps: number;
  pctCollectedFromApps: number | null;
  totalCollected: number | null;
  pctOfCollectionsFinanced: number | null;
  cases: number;
  casesApproved: number;
  caseApprovalRate: number | null;
  casesFunded: number;
}

export interface FinanceSummary {
  filters: FinanceFilters;
  newPatients: PeriodStat;
  newPatientsApplying: PeriodStat;
  pctNewPatientsApplying: { current: number | null; prior: number | null };
  applicationsByLender: LenderCount[];
  approvalRateByLender: LenderRate[];
  multiLender: MultiLenderSummary;
  byPractice: PracticeRow[];
  byPracticeTotal: PracticeRow;
  statusBreakdown: StatusBreakdownRow[];
}

export interface LocationOption {
  id: number;
  name: string;
}

/** Lender configuration from GET /api/lenders: label + which programs it runs. */
export interface LenderOption {
  code: Lender;
  label: string;
  offers_prime: boolean;
  offers_subprime: boolean;
  active: boolean;
  applications?: number;
  /** Applications on file whose tier is unknown (lender runs both programs, export didn't say). */
  unknown_tier?: number;
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

export interface LenderGovernanceRow {
  code: Lender;
  label: string;
  active: boolean;
  offersPrime: boolean;
  offersSubprime: boolean;
  classificationSource: "unconfirmed" | "inferred_from_data" | "lender_confirmed";
  exportOwner: string | null;
  exportCadence: string;
  exportGraceDays: number;
  portalUrl: string | null;
  lastImportAt: string | null;
  lastImportFile: string | null;
  daysSinceLastImport: number | null;
  expectedEveryDays: number | null;
  feedStatus: "ok" | "due" | "overdue" | "never" | "no_schedule";
  applications: number;
  observed: {
    decisioned: number;
    approvalRateOfDecisioned: number | null;
    avgApprovedAmount: number | null;
    medianApprovedAmount: number | null;
    unknownTier: number;
    statedPrime: number;
    statedSubprime: number;
  };
  classificationHint: string;
}

export interface LenderGovernanceResponse {
  lenders: LenderGovernanceRow[];
  summary: { unassigned: number; noCadence: number; overdue: number; never: number; unconfirmedTier: number };
}

export async function getLenderGovernance(): Promise<LenderGovernanceResponse> {
  if (STATIC_MODE) return (await staticApi()).getLenderGovernance();
  const res = await fetch("/api/lenders/governance");
  if (!res.ok) throw new Error(`Failed to load lender governance: ${res.status}`);
  return res.json();
}

export async function updateLender(code: string, patch: Record<string, unknown>): Promise<void> {
  if (STATIC_MODE) throw new Error("Editing lender settings needs the backend — it's disabled in the demo.");
  const res = await fetch(`/api/lenders/${code}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Update failed: ${res.status}`);
}

export async function getLenders(): Promise<LenderOption[]> {
  if (STATIC_MODE) return (await staticApi()).getLenders();
  const res = await fetch("/api/lenders");
  if (!res.ok) throw new Error(`Failed to load lenders: ${res.status}`);
  return (await res.json()).lenders;
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

// ---- Denticon data download (BCP) feed ----------------------------------------------

export interface BcpStatus {
  configured: boolean;
  inbox: string | null;
  pendingFiles: string[];
  lastLoad: {
    id: number;
    fileName: string | null;
    finishedAt: string;
    stale: boolean;
    tables: Array<{ table: string; entity: string | null; rows: number; inserted: number; blocked: string | null }>;
  } | null;
  lastError: { id: number; fileName: string | null; at: string; error: string } | null;
  staging: Array<{ table: string; total: number; unprocessed: number }>;
}

export async function getBcpStatus(): Promise<BcpStatus | null> {
  if (STATIC_MODE) return null;
  const res = await fetch("/api/bcp/status");
  if (!res.ok) throw new Error(`Failed to load BCP feed status: ${res.status}`);
  return res.json();
}
