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

function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
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
