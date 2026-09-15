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

// Thin fetch wrapper. Vite dev server proxies /api -> the backend (see vite.config.ts).
export async function getFunnelSummary(
  filters: FunnelFilters = {},
): Promise<FunnelSummaryResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, String(value));
  }

  const res = await fetch(`/api/funnel/summary?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to load funnel summary: ${res.status}`);
  }
  return res.json();
}
