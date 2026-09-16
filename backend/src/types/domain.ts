// Mirrors the SQL schema in src/db/migrations. Kept as plain types (not an ORM) for now —
// revisit if/when the project adopts Prisma or similar.

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

// Open question (docs/data-model.md): does this need "in_review" / "expired" too?
export type ApplicationStatus = "submitted" | "pending" | "approved" | "declined";

export type TreatmentPlanStatus = "presented" | "accepted" | "declined";

export interface Location {
  id: number;
  name: string;
}

export interface Provider {
  id: number;
  locationId: number;
  name: string;
}

export interface Patient {
  id: number;
  denticonPatientId: string | null;
  locationId: number | null;
  providerId: number | null;
  source: string | null;
  newPatientFlag: boolean;
  firstVisitDate: string | null;
}

export interface TreatmentPlan {
  id: number;
  patientId: number;
  procedureCode: string | null;
  proposedFee: number | null;
  status: TreatmentPlanStatus;
  presentedDate: string | null;
}

export interface FinancingApplication {
  id: number;
  patientId: number;
  treatmentPlanId: number | null;
  lender: Lender;
  applicationType: ApplicationType;
  status: ApplicationStatus;
  submittedDate: string | null;
  decisionDate: string | null;
  approvedAmount: number | null;
  declineReason: string | null;
}

export interface Funding {
  id: number;
  applicationId: number;
  fundedDate: string | null;
  fundedAmount: number | null;
  utilizationPct: number | null;
}

export interface TreatmentCompletion {
  id: number;
  treatmentPlanId: number;
  completedDate: string | null;
  caseValue: number | null;
}

// Shape returned by GET /api/funnel/summary — one row per stage, for the dashboard's
// stat cards + funnel chart.
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
  lender?: Lender;
  dateFrom?: string;
  dateTo?: string;
}

// Filters for the Finance Report (GET /api/finance/summary), matching the reference
// report's filter bar: Practice Name, Select Date Range, Prime vs SubPrime, Status
// Filter, Patient Type.
export interface FinanceFilters {
  locationId?: number; // "Practice Name"
  dateFrom?: string;
  dateTo?: string;
  applicationType?: ApplicationType; // "Prime vs SubPrime"
  status?: ApplicationStatus; // "Status Filter"
  newPatientsOnly?: boolean; // "Patient Type": All vs New Patients
}

export interface PeriodStat {
  current: number;
  prior: number;
  pctChange: number | null; // null when prior is 0 (can't compute a % change)
}

export interface LenderCount {
  lender: Lender;
  count: number;
}

export interface LenderRate {
  lender: Lender;
  rate: number; // 0-100
  count: number; // decisioned applications this rate is based on
}

export interface FinanceSummary {
  filters: FinanceFilters;
  newPatients: PeriodStat;
  newPatientsApplying: PeriodStat;
  pctNewPatientsApplying: { current: number | null; prior: number | null };
  applicationsByLender: LenderCount[];
  approvalRateByLender: LenderRate[];
}
