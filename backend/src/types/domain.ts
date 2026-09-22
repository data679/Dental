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
  /** Derived in the DB: has completed a first visit. Booked/no-show patients are false. */
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
  /** null = unknown (lender runs both programs and the export didn't say). */
  applicationType: ApplicationType | null;
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
  applicationType?: ApplicationType | "unknown"; // "Prime vs SubPrime" (unknown = tier not stated for a both-program lender)
  status?: ApplicationStatus; // "Status Filter"
  /** Finer than `status`: withdrawn / expired / in_review / … (see migration 0011). */
  statusDetail?: string;
  /** 'open' | 'decided' | 'abandoned' — did the application die, or is it still live? */
  outcomeClass?: "open" | "decided" | "abandoned";
  newPatientsOnly?: boolean; // "Patient Type": All vs New Patients (first visit within the period)
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

/**
 * Multi-app view. A "case" is one patient's round of applications for one treatment
 * (docs/financing-intake.md § Multi-lender); practices often soft-check several lenders
 * at once and let the patient pick from the approvals.
 */
export interface MultiLenderSummary {
  cases: number;
  multiLenderCases: number; // applied to 2+ lenders
  avgLendersPerCase: number | null;
  casesApproved: number; // approved by at least one lender
  casesWithMultipleApprovals: number; // patient had a choice
  casesFunded: number;
  casesFundedFromMultipleApprovals: number;
  inquiries: { soft: number; hard: number; unknown: number }; // application rows by pull type
  /** Among cases with 2+ approvals: how often each approving lender was the one used. */
  chosenLenderWhenMultiApproved: Array<{ lender: Lender; offered: number; chosen: number; winRate: number | null }>;
}

/**
 * One row of the practice comparison table — the column set of the OS Dental Finance
 * Report (docs/os-dental-report.md), plus the case-level figures that report can't show.
 */
export interface PracticeRow {
  locationId: number | null; // null on the Total row
  name: string;
  newPatients: number;
  newPatientsApplying: number;
  pctNewPatientsApplying: number | null;
  applications: number;
  approved: number;
  declined: number;
  /** approved ÷ applications (OS Dental's definition — includes pending/withdrawn). */
  approvalRate: number | null;
  /** approved ÷ decisioned — the rate a lender would quote. */
  approvalRateOfDecisioned: number | null;
  approvalAmount: number;
  averageApprovalAmount: number | null;
  collectedFromApps: number;
  /** collected ÷ approved amount — utilisation of the credit that was extended. */
  pctCollectedFromApps: number | null;
  /** Practice-wide collections. null until PMS ledger data is ingested. */
  totalCollected: number | null;
  pctOfCollectionsFinanced: number | null;
  cases: number;
  casesApproved: number;
  /** Share of PATIENTS approved — what the per-application rate hides under multi-app. */
  caseApprovalRate: number | null;
  casesFunded: number;
}

export interface StatusBreakdownRow {
  status: ApplicationStatus;
  statusDetail: string | null;
  /** 'open' = still awaiting a decision, 'decided', 'abandoned' = withdrawn/expired/cancelled. */
  outcomeClass: "open" | "decided" | "abandoned" | null;
  count: number;
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
