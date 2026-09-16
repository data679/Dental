// Response models for the PlanetDDS / Denticon REST API (v0), transcribed from the
// OpenAPI definitions published at https://developer.planetdds.com/ (Patients, Clinical,
// Practices, Appointments APIs). Only the fields this project reads are typed strictly;
// everything else is kept loose so a new field from Denticon never breaks a sync.
//
// Note: the GitHub sample (PlanetDDS_Api_SampleCode) targets the *legacy* v1 API at
// dev-api.denticon.com with API-AUTH-KEY / API-VENDOR-KEY / PGID headers. The current
// documented API is the one modelled here; see docs/denticon-api.md for the mapping.

/** Every list endpoint wraps its rows in this envelope. */
export interface DenticonPaginatedResponse<T> {
  data: T[];
  message?: string;
  pageNumber: number;
  pageSize: number;
  pageCount: number; // rows on this page
  totalCount: number;
  totalPages: number;
}

/** Single-object endpoints (GET /{PatientId}, GET /practices) use this envelope. */
export interface DenticonSingleResponse<T> {
  data: T;
  message?: string;
}

/** RFC 7807 body returned on 4xx/5xx. */
export interface DenticonProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  traceId?: string;
}

/** Body returned on 429 — "Rate limit is exceeded. Try again in 99 seconds." */
export interface DenticonTooManyRequests {
  message: string;
  statusCode?: number;
}

// ---------------------------------------------------------------------------------------
// Practices API — https://api.planetdds.com/denticon/practices/v0
// ---------------------------------------------------------------------------------------

export interface DenticonPractice {
  pgId: number;
  practiceGroupName: string;
  active?: boolean;
  [key: string]: unknown;
}

export interface DenticonOffice {
  officeId: string; // NB: string here, but integer everywhere else (OfficeId filters)
  officeName: string;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  zipcode?: string | null;
  timeZone?: string | null;
  officeActive?: boolean;
  createdOn?: string | null;
  modifiedOn?: string | null;
  [key: string]: unknown;
}

export interface DenticonProvider {
  providerId: number;
  providerShortId?: string | null;
  firstName: string;
  lastName: string;
  title?: string | null;
  providerType?: string | null;
  active?: boolean;
  officeId: number;
  nationalProviderId?: string | null;
  createdOn?: string | null;
  modifiedOn?: string | null;
  [key: string]: unknown;
}

export interface DenticonPatientTypeCode {
  code: string;
  description: string;
}

export interface DenticonReferralType {
  refTypeCode: string;
  refTypeDescription: string;
}

export interface DenticonProcedureCode {
  code: string;
  description: string;
  productionTypeId?: number;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------------------
// Patients API — https://api.planetdds.com/denticon/patients/v0
// ---------------------------------------------------------------------------------------

export interface DenticonPatient {
  pgId: number;
  patientId: number;
  responsiblePartyId?: number | null;
  officeId: number;
  chartNo?: string | null;
  firstName: string;
  lastName: string;
  birthDate?: string | null;
  sex?: string | null;
  active?: boolean;
  firstVisitDate?: string | null; // UTC
  lastVisitDate?: string | null; // UTC
  createdOn?: string | null;
  modifiedOn?: string | null;
  lastChangedOn?: string | null;
  refTypeCode?: string | null; // referral source (maps to our patients.source)
  referredById?: number | null;
  preferredProviderId?: number | null;
  preferredHygienistId?: number | null;
  patientTypeCode?: string | null;
  patientTypeDescription?: string | null;
  isOrtho?: boolean;
  // Contact/demographic fields (email, phones, address, opt-ins…) are present in the
  // payload and stored raw in staging, but deliberately not typed/used here — the funnel
  // only needs identifiers, office, provider, referral source and visit dates.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------
// Clinical API — https://api.planetdds.com/denticon/clinical/v0
// ---------------------------------------------------------------------------------------

/**
 * A=Accepted; D=Diagnosed; H=Hold; L=Alternative; R=Referred Out; U=Unaccepted.
 * (From the treatPlanStatus field description in the Clinical API definition.)
 */
export type DenticonTreatPlanStatus = "A" | "D" | "H" | "L" | "R" | "U";

/** PS=Sent; PD=Covered; PU=Uncovered; PN=Unaccepted. */
export type DenticonPreAuthStatus = "PS" | "PD" | "PU" | "PN";

/**
 * One row per *procedure* on a treatment plan (the API is item-level, not plan-level):
 * the same treatPlanId repeats across rows with different procedureCode/tooth/fee.
 */
export interface DenticonTreatmentPlanItem {
  patientId: number;
  treatPlanId: number;
  treatPlanNumber?: number;
  treatPlanStatus: DenticonTreatPlanStatus | string;
  treatPlanDescription?: string | null;
  treatPlanPhaseId?: number;
  treatPlanPhaseDescription?: string | null;
  treatPlanOrderId?: number;
  treatPlanProposedDate?: string | null;
  treatPlanAuthDate?: string | null;
  treatPlanStartDate?: string | null;
  treatPlanFinishDate?: string | null;
  treatPlanScheduledDate?: string | null;
  treatPlanScheduledDateTime?: string | null;
  acceptedDateTime?: string | null;
  preAuthStatus?: DenticonPreAuthStatus | string | null;
  providerId?: number | null;
  procedureCode?: string | null;
  adaCode?: string | null;
  description?: string | null;
  isScheduled?: boolean;
  isCompleted?: boolean;
  fee?: number | null;
  ucrFee?: number | null;
  estimatedInsurance?: number | null;
  estimatedPatient?: number | null;
  discount?: string | null;
  tooth?: string | null;
  surface?: string | null;
  createdOn?: string | null;
  modifiedOn?: string | null;
  lastChangedOn?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------
// Appointments API — https://api.planetdds.com/denticon/appointments/v0
// Not used by the funnel yet, but typed so the client covers what the sample code shows.
// ---------------------------------------------------------------------------------------

export type DenticonAppointmentStatus =
  | "Scheduled" | "Confirmed" | "Left Message" | "In Operatory" | "In Reception" | "Posted"
  | "Missed" | "Unconfirmed" | "Cancelled" | "Checked out" | "Available" | "Unknown";

export interface DenticonAppointmentProcedure {
  appointmentDetailId: number;
  procedureCode: string;
  description?: string | null;
  treatmentPlanId?: number | null;
  tooth?: string | null;
  surface?: string | null;
}

export interface DenticonAppointment {
  pgId?: number;
  officeId: number;
  appointmentId: number;
  patientId: number;
  firstName?: string | null;
  lastName?: string | null;
  cellPhone?: string | null;
  workPhone?: string | null;
  homePhone?: string | null;
  email?: string | null;
  procedureType?: number | null;
  appointmentDate: string; // UTC
  appointmentStatus?: DenticonAppointmentStatus | string | null;
  providerId?: number | null;
  operatoryId?: number | null;
  appointmentLength?: number | null; // minutes
  /** "Is Patient new (not completed registration yet)" — a candidate new-patient signal. */
  isNewPatient?: boolean;
  isAsap?: boolean;
  createdOn?: string | null;
  createdBy?: string | null;
  modifiedOn?: string | null;
  modifiedBy?: string | null;
  fee?: number | null;
  procedureCodes?: DenticonAppointmentProcedure[] | null;
  isCancelled?: boolean;
  isMissed?: boolean;
  isBlock?: boolean;
  /** Whether the appointment has ledger activity (i.e. was posted/charged). */
  isTransaction?: boolean;
  /** Comma-delimited 2-char patient type codes, e.g. "00,01,CH"; null/"" when none. */
  patientTypeCode?: string | null;
  lastChangedOn?: string | null;
  statusHistory?: unknown[] | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------
// Query parameter shapes
// ---------------------------------------------------------------------------------------

/** ISO-8601 date-time string, e.g. 2026-09-01T00:00:00.000Z or 2026-09-01T00:00:00-07:00. */
export type DenticonDateTime = string;

export interface DateRangeFilter {
  DateFrom: DenticonDateTime;
  DateTo: DenticonDateTime;
}

export interface PageParams {
  PageNumber?: number;
  /** Max 1000, default 50. */
  PageSize?: number;
}

/**
 * Change-tracking filters shared by GET patients / treatment-plans / appointments.
 * Denticon enforces: at most one of CreatedOn / ModifiedOn / LastChangedOn, both ends of
 * the range present, and a range no longer than 30 days.
 */
export interface ChangeFilters {
  OfficeId?: number;
  CreatedOn?: DateRangeFilter;
  ModifiedOn?: DateRangeFilter;
  LastChangedOn?: DateRangeFilter;
}

export type ListPatientsParams = ChangeFilters & PageParams;
export type ListTreatmentPlansParams = ChangeFilters & PageParams & { PatientId?: number };
export type ListAppointmentsParams = ChangeFilters &
  PageParams & { PatientId?: number; AppointmentDate?: DateRangeFilter };
export type ListProvidersParams = PageParams & { OfficeId?: number };
