import type {
  ChangeFilters,
  DenticonAppointment,
  DenticonOffice,
  DenticonPaginatedResponse,
  DenticonPatient,
  DenticonPatientTypeCode,
  DenticonPractice,
  DenticonProblemDetails,
  DenticonProcedureCode,
  DenticonProvider,
  DenticonReferralType,
  DenticonSingleResponse,
  DenticonTreatmentPlanItem,
  ListAppointmentsParams,
  ListPatientsParams,
  ListProvidersParams,
  ListTreatmentPlansParams,
  PageParams,
} from "./types.js";

// Thin, typed HTTP client for the PlanetDDS / Denticon REST API.
//
// Auth: Azure API Management subscription key in the `PDDS-Subscription-Key` header (the
// key is issued per practice group, so there's no separate PGID header on this API).
// The legacy v1 API that the public GitHub sample targets used `API-AUTH-KEY`,
// `API-VENDOR-KEY` and `PGID` headers instead; those are still supported here via
// `legacy` for anyone who was issued the older credentials, but none of the typed methods
// below exist on that API — use `request()` directly for it.
//
// Base URL: https://api.planetdds.com/denticon — each area is a separate versioned API
// underneath it (patients/v0, clinical/v0, practices/v0, appointments/v0, rcm/v0, ...).

export const DENTICON_DEFAULT_BASE_URL = "https://api.planetdds.com/denticon";
export const DENTICON_MAX_PAGE_SIZE = 1000;

export interface DenticonLegacyAuth {
  authKey: string;
  vendorKey: string;
  pgId: string | number;
}

export interface DenticonClientOptions {
  subscriptionKey?: string;
  legacy?: DenticonLegacyAuth;
  baseUrl?: string;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  /** Retries for 429 / 5xx / network errors. Default 3. */
  maxRetries?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests so retry backoff doesn't actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "warn" | "debug">;
}

export class DenticonApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly problem?: DenticonProblemDetails,
  ) {
    super(message);
    this.name = "DenticonApiError";
  }
}

/**
 * Query params: scalars, or a `{DateFrom, DateTo}` object that expands to `Key.DateFrom=…`.
 * Typed as `object` (not an index signature) so the interface-based param types in
 * types.ts are accepted without casts.
 */
export type QueryParams = object;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function parseRetryAfterSeconds(res: Response, body: unknown): number | undefined {
  const header = res.headers.get("retry-after");
  if (header && /^\d+$/.test(header)) return Number(header);
  // 429 body: "Rate limit is exceeded. Try again in 99 seconds."
  const msg = (body as { message?: unknown } | null)?.message;
  const m = typeof msg === "string" ? /try again in (\d+) second/i.exec(msg) : null;
  return m ? Number(m[1]) : undefined;
}

export function buildQuery(params: QueryParams | undefined): string {
  if (!params) return "";
  const search = new URLSearchParams();
  const append = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === "object") {
      // {DateFrom, DateTo} → Key.DateFrom / Key.DateTo (Denticon's nested query style)
      for (const [k, v] of Object.entries(value as object)) append(`${key}.${k}`, v);
      return;
    }
    search.append(key, String(value));
  };
  for (const [k, v] of Object.entries(params)) append(k, v);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export class DenticonClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Console, "warn" | "debug">;

  constructor(opts: DenticonClientOptions) {
    if (!opts.subscriptionKey && !opts.legacy) {
      throw new Error("DenticonClient: subscriptionKey (or legacy credentials) is required");
    }
    this.baseUrl = (opts.baseUrl ?? DENTICON_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.headers = { Accept: "application/json" };
    if (opts.subscriptionKey) this.headers["PDDS-Subscription-Key"] = opts.subscriptionKey;
    if (opts.legacy) {
      this.headers["API-AUTH-KEY"] = opts.legacy.authKey;
      this.headers["API-VENDOR-KEY"] = opts.legacy.vendorKey;
      this.headers["PGID"] = String(opts.legacy.pgId);
    }
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = opts.logger ?? console;
  }

  // -------------------------------------------------------------------------------------
  // Low-level
  // -------------------------------------------------------------------------------------

  /**
   * Performs one request with retry/backoff. `path` is relative to the base URL, e.g.
   * `/patients/v0` or `/clinical/v0/treatment-plans`. Never logs headers (they carry the key).
   */
  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: { query?: QueryParams; body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}${buildQuery(opts.query)}`;
    const init: RequestInit = { method, headers: { ...this.headers } };
    if (opts.body !== undefined) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (attempt > this.maxRetries) {
          throw new DenticonApiError(
            `Denticon ${method} ${url} failed after ${attempt} attempts: ${(err as Error).message}`,
            0,
            method,
            url,
          );
        }
        await this.backoff(attempt, undefined, `network error: ${(err as Error).message}`);
        continue;
      }

      const text = await res.text();
      const body = text ? safeJson(text) : null;

      if (res.ok) return body as T;

      if (RETRYABLE_STATUSES.has(res.status) && attempt <= this.maxRetries) {
        await this.backoff(attempt, parseRetryAfterSeconds(res, body), `HTTP ${res.status}`);
        continue;
      }

      const problem = (body ?? undefined) as DenticonProblemDetails | undefined;
      const detail = problem?.detail ?? problem?.title ?? (typeof body === "string" ? body : "");
      throw new DenticonApiError(
        `Denticon ${method} ${redact(url)} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
        res.status,
        method,
        url,
        problem,
      );
    }
  }

  private async backoff(attempt: number, retryAfterSeconds: number | undefined, why: string) {
    // Honour the server's hint (429s say "try again in N seconds"), else exponential
    // 1s, 2s, 4s… capped at 60s.
    const ms =
      retryAfterSeconds !== undefined
        ? Math.min(retryAfterSeconds, 300) * 1000
        : Math.min(1000 * 2 ** (attempt - 1), 60_000);
    this.logger.warn(`[denticon] ${why}; retry ${attempt}/${this.maxRetries} in ${ms}ms`);
    await this.sleep(ms);
  }

  get<T>(path: string, query?: QueryParams): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Walks every page of a paginated list endpoint. Requests the max page size unless the
   * caller sets one; yields row-by-row so callers can stream into staging without holding
   * a whole practice group's patient list in memory.
   */
  async *paginate<T>(path: string, query: PageParams & QueryParams = {}): AsyncGenerator<T> {
    const pageSize = Math.min(query.PageSize ?? DENTICON_MAX_PAGE_SIZE, DENTICON_MAX_PAGE_SIZE);
    let pageNumber = query.PageNumber ?? 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.get<DenticonPaginatedResponse<T>>(path, {
        ...query,
        PageNumber: pageNumber,
        PageSize: pageSize,
      });
      const rows = page.data ?? [];
      for (const row of rows) yield row;
      const totalPages = page.totalPages ?? (rows.length < pageSize ? pageNumber : pageNumber + 1);
      if (rows.length === 0 || pageNumber >= totalPages) return;
      pageNumber += 1;
    }
  }

  // -------------------------------------------------------------------------------------
  // Practices API
  // -------------------------------------------------------------------------------------

  async getPractice(): Promise<DenticonPractice> {
    const res = await this.get<DenticonSingleResponse<DenticonPractice>>("/practices/v0");
    return res.data;
  }

  listOffices(params: PageParams = {}): AsyncGenerator<DenticonOffice> {
    return this.paginate<DenticonOffice>("/practices/v0/offices", params);
  }

  async getOffice(officeId: number): Promise<DenticonOffice> {
    const res = await this.get<DenticonSingleResponse<DenticonOffice>>(
      `/practices/v0/offices/${officeId}`,
    );
    return res.data;
  }

  listProviders(params: ListProvidersParams = {}): AsyncGenerator<DenticonProvider> {
    return this.paginate<DenticonProvider>("/practices/v0/providers", params);
  }

  async getProvider(providerId: number): Promise<DenticonProvider> {
    const res = await this.get<DenticonSingleResponse<DenticonProvider>>(
      `/practices/v0/providers/${providerId}`,
    );
    return res.data;
  }

  /** Not paginated on the API side. */
  async listPatientTypeCodes(): Promise<DenticonPatientTypeCode[]> {
    const res = await this.get<
      DenticonSingleResponse<DenticonPatientTypeCode[]> | DenticonPaginatedResponse<DenticonPatientTypeCode>
    >("/practices/v0/patient-type-codes");
    return Array.isArray(res.data) ? res.data : [];
  }

  listReferralTypes(params: PageParams = {}): AsyncGenerator<DenticonReferralType> {
    return this.paginate<DenticonReferralType>("/practices/v0/referral-types", params);
  }

  listProcedureCodes(params: PageParams = {}): AsyncGenerator<DenticonProcedureCode> {
    return this.paginate<DenticonProcedureCode>("/practices/v0/procedure-codes", params);
  }

  // -------------------------------------------------------------------------------------
  // Patients API
  // -------------------------------------------------------------------------------------

  listPatients(params: ListPatientsParams = {}): AsyncGenerator<DenticonPatient> {
    assertChangeFilters(params);
    return this.paginate<DenticonPatient>("/patients/v0", params);
  }

  async getPatient(patientId: number): Promise<DenticonPatient> {
    const res = await this.get<DenticonSingleResponse<DenticonPatient>>(
      `/patients/v0/${patientId}`,
    );
    return res.data;
  }

  // -------------------------------------------------------------------------------------
  // Clinical API
  // -------------------------------------------------------------------------------------

  /**
   * Treatment plan *items* (one row per procedure) across an office. Denticon requires a
   * CreatedOn / ModifiedOn / LastChangedOn range on this endpoint.
   */
  listTreatmentPlans(params: ListTreatmentPlansParams): AsyncGenerator<DenticonTreatmentPlanItem> {
    assertChangeFilters(params);
    if (!params.CreatedOn && !params.ModifiedOn && !params.LastChangedOn) {
      throw new Error(
        "listTreatmentPlans: Denticon requires CreatedOn, ModifiedOn or LastChangedOn",
      );
    }
    return this.paginate<DenticonTreatmentPlanItem>("/clinical/v0/treatment-plans", params);
  }

  async listTreatmentPlansByPatient(patientId: number): Promise<DenticonTreatmentPlanItem[]> {
    const res = await this.get<DenticonSingleResponse<DenticonTreatmentPlanItem[]>>(
      `/clinical/v0/patients/${patientId}/treatment-plans`,
    );
    return res.data ?? [];
  }

  // -------------------------------------------------------------------------------------
  // Appointments API (mirrors the two calls in the public sample code)
  // -------------------------------------------------------------------------------------

  listAppointments(params: ListAppointmentsParams = {}): AsyncGenerator<DenticonAppointment> {
    assertChangeFilters(params);
    return this.paginate<DenticonAppointment>("/appointments/v0", params);
  }

  async getAppointment(appointmentId: number): Promise<DenticonAppointment> {
    const res = await this.get<DenticonSingleResponse<DenticonAppointment>>(
      `/appointments/v0/${appointmentId}`,
    );
    return res.data;
  }
}

/** Fail fast on filter combos Denticon rejects with a 400, with a clearer message. */
function assertChangeFilters(p: ChangeFilters) {
  const set = [p.CreatedOn, p.ModifiedOn, p.LastChangedOn].filter(Boolean);
  if (p.LastChangedOn && set.length > 1) {
    throw new Error("Denticon: LastChangedOn cannot be combined with CreatedOn/ModifiedOn");
  }
  for (const [name, range] of Object.entries({
    CreatedOn: p.CreatedOn,
    ModifiedOn: p.ModifiedOn,
    LastChangedOn: p.LastChangedOn,
  })) {
    if (!range) continue;
    if (!range.DateFrom || !range.DateTo) {
      throw new Error(`Denticon: ${name} needs both DateFrom and DateTo`);
    }
    const days = (Date.parse(range.DateTo) - Date.parse(range.DateFrom)) / 86_400_000;
    if (Number.isNaN(days)) throw new Error(`Denticon: ${name} dates must be ISO-8601`);
    if (days > 30) throw new Error(`Denticon: ${name} range exceeds the 30-day maximum`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Strip a subscription key if someone passed it as a `subscription-key` query param. */
function redact(url: string): string {
  return url.replace(/(subscription-key=)[^&]+/i, "$1***");
}
