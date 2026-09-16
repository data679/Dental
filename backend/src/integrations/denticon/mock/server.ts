import express, { type Request, type Response } from "express";
import { generateMockDataset, type MockDataOptions, type MockDataset } from "./data.js";
import type { DenticonPaginatedResponse } from "../types.js";

// Stand-in for https://api.planetdds.com/denticon while we wait for a real key. Serves
// the synthetic dataset from ./data.ts with the same envelope, headers, filter rules,
// pagination and error shapes as the documented v0 API, so the real client + sync job
// run against it unchanged:
//
//   DENTICON_API_BASE_URL=http://localhost:4900/denticon
//   DENTICON_SUBSCRIPTION_KEY=mock-key
//
// Behaviours reproduced on purpose: subscription-key auth (401), 30-day range cap and
// filter-combination rules (400 problem details), treatment-plans requiring a date
// filter, PageSize max 1000, string officeId on /offices, optional 429 every N requests.

export interface MockServerOptions extends MockDataOptions {
  subscriptionKey?: string;
  /** Return a 429 on every Nth request (0 = never). Exercises the client's retry path. */
  rateLimitEvery?: number;
  dataset?: MockDataset;
}

const DAY = 86_400_000;

function problem(res: Response, status: number, title: string, detail: string, instance: string) {
  res.status(status).json({
    type: `https://tools.ietf.org/html/rfc9110#section-15.${status >= 500 ? 6 : 5}.${status % 100}`,
    title,
    status,
    detail,
    instance,
    traceId: `MOCK:${Date.now().toString(36)}`,
  });
}

function paginate<T>(rows: T[], q: Request["query"]): DenticonPaginatedResponse<T> {
  const pageSize = Math.min(Math.max(Number(q.PageSize ?? 50) || 50, 1), 1000);
  const pageNumber = Math.max(Number(q.PageNumber ?? 1) || 1, 1);
  const data = rows.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
  return {
    data,
    message: "Success",
    pageNumber,
    pageSize,
    pageCount: data.length,
    totalCount: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
  };
}

type Range = { from: number; to: number } | null;

/** Parses `Key.DateFrom` / `Key.DateTo` and enforces Denticon's rules. Returns an error string or the range. */
function parseRange(q: Request["query"], key: string): Range | string {
  const from = q[`${key}.DateFrom`];
  const to = q[`${key}.DateTo`];
  if (from === undefined && to === undefined) return null;
  if (from === undefined || to === undefined) return `${key}: both DateFrom and DateTo must be provided.`;
  const f = Date.parse(String(from));
  const t = Date.parse(String(to));
  if (Number.isNaN(f) || Number.isNaN(t)) return `${key}: dates must be ISO-8601.`;
  if (t < f) return `${key}: DateTo must be after DateFrom.`;
  if (t - f > 30 * DAY) return `${key}: the date range must not exceed 30 days.`;
  return { from: f, to: t };
}

interface ChangeFilters {
  createdOn: Range;
  modifiedOn: Range;
  lastChangedOn: Range;
}

function parseChangeFilters(q: Request["query"]): ChangeFilters | string {
  const createdOn = parseRange(q, "CreatedOn");
  const modifiedOn = parseRange(q, "ModifiedOn");
  const lastChangedOn = parseRange(q, "LastChangedOn");
  for (const r of [createdOn, modifiedOn, lastChangedOn]) if (typeof r === "string") return r;
  if (lastChangedOn && (createdOn || modifiedOn)) {
    return "LastChangedOn cannot be combined with CreatedOn or ModifiedOn.";
  }
  return { createdOn: createdOn as Range, modifiedOn: modifiedOn as Range, lastChangedOn: lastChangedOn as Range };
}

const inRange = (value: unknown, r: Range) => {
  if (!r) return true;
  const ms = Date.parse(String(value ?? ""));
  return !Number.isNaN(ms) && ms >= r.from && ms <= r.to;
};

function applyChangeFilters<T extends Record<string, unknown>>(rows: T[], f: ChangeFilters): T[] {
  return rows.filter(
    (r) => inRange(r.createdOn, f.createdOn) && inRange(r.modifiedOn, f.modifiedOn) && inRange(r.lastChangedOn, f.lastChangedOn),
  );
}

export function createDenticonMockApp(opts: MockServerOptions = {}) {
  const key = opts.subscriptionKey ?? "mock-key";
  const data = opts.dataset ?? generateMockDataset(opts);
  const app = express();
  app.use(express.json());
  let requests = 0;

  app.use("/denticon", (req, res, next) => {
    requests += 1;
    if (req.header("PDDS-Subscription-Key") !== key && req.query["subscription-key"] !== key) {
      res.status(401).json({
        statusCode: 401,
        message: "Access denied due to missing subscription key. Make sure to include subscription key when making requests to an API.",
      });
      return;
    }
    if (opts.rateLimitEvery && requests % opts.rateLimitEvery === 0) {
      res.status(429).json({ message: "Rate limit is exceeded. Try again in 1 seconds.", statusCode: 429 });
      return;
    }
    next();
  });

  const officeIds = new Set(data.offices.map((o) => Number(o.officeId)));
  const officeFilter = (req: Request, res: Response): number | null | false => {
    if (req.query.OfficeId === undefined) return null;
    const id = Number(req.query.OfficeId);
    if (!officeIds.has(id)) {
      problem(res, 403, "Forbidden", `Office ${req.query.OfficeId} is not within the authorized scope.`, req.path);
      return false;
    }
    return id;
  };

  // Practices ------------------------------------------------------------------------------
  app.get("/denticon/practices/v0", (_req, res) => res.json({ data: data.practice, message: "Success" }));
  app.get("/denticon/practices/v0/offices", (req, res) => res.json(paginate(data.offices, req.query)));
  app.get("/denticon/practices/v0/offices/:id", (req, res) => {
    const o = data.offices.find((x) => x.officeId === req.params.id);
    return o ? res.json({ data: o, message: "Success" }) : problem(res, 404, "Not Found", "Office not found.", req.path);
  });
  app.get("/denticon/practices/v0/providers", (req, res) => {
    const office = officeFilter(req, res);
    if (office === false) return;
    res.json(paginate(office === null ? data.providers : data.providers.filter((p) => p.officeId === office), req.query));
  });
  app.get("/denticon/practices/v0/providers/:id", (req, res) => {
    const p = data.providers.find((x) => x.providerId === Number(req.params.id));
    return p ? res.json({ data: p, message: "Success" }) : problem(res, 404, "Not Found", "Provider not found.", req.path);
  });
  app.get("/denticon/practices/v0/referral-types", (req, res) => res.json(paginate(data.referralTypes, req.query)));
  app.get("/denticon/practices/v0/patient-type-codes", (_req, res) => res.json({ data: data.patientTypeCodes, message: "Success" }));
  app.get("/denticon/practices/v0/procedure-codes", (req, res) => res.json(paginate(data.procedureCodes, req.query)));

  // Patients -------------------------------------------------------------------------------
  app.get("/denticon/patients/v0", (req, res) => {
    const office = officeFilter(req, res);
    if (office === false) return;
    const filters = parseChangeFilters(req.query);
    if (typeof filters === "string") return problem(res, 400, "Bad Request", filters, req.path);
    let rows = office === null ? data.patients : data.patients.filter((p) => p.officeId === office);
    rows = applyChangeFilters(rows, filters);
    res.json(paginate(rows, req.query));
  });
  app.get("/denticon/patients/v0/:id", (req, res) => {
    const p = data.patients.find((x) => x.patientId === Number(req.params.id));
    return p ? res.json({ data: p, message: "Success" }) : problem(res, 404, "Not Found", "Patient not found.", req.path);
  });

  // Clinical -------------------------------------------------------------------------------
  const patientOffice = new Map(data.patients.map((p) => [p.patientId, p.officeId]));
  app.get("/denticon/clinical/v0/treatment-plans", (req, res) => {
    const office = officeFilter(req, res);
    if (office === false) return;
    const filters = parseChangeFilters(req.query);
    if (typeof filters === "string") return problem(res, 400, "Bad Request", filters, req.path);
    if (!filters.createdOn && !filters.modifiedOn && !filters.lastChangedOn) {
      return problem(res, 400, "Bad Request", "Either CreatedOn, ModifiedOn or LastChangedOn date range is required.", req.path);
    }
    let rows = data.treatmentPlanItems;
    if (office !== null) rows = rows.filter((i) => patientOffice.get(i.patientId) === office);
    if (req.query.PatientId !== undefined) rows = rows.filter((i) => i.patientId === Number(req.query.PatientId));
    rows = applyChangeFilters(rows, filters);
    // The office-wide feed omits ucrFee (only the by-patient endpoint has it).
    res.json(paginate(rows.map(({ ucrFee: _u, ...rest }) => rest), req.query));
  });
  app.get("/denticon/clinical/v0/patients/:id/treatment-plans", (req, res) => {
    const id = Number(req.params.id);
    if (!patientOffice.has(id)) return problem(res, 404, "Not Found", "Patient not found.", req.path);
    res.json({ data: data.treatmentPlanItems.filter((i) => i.patientId === id), message: "Success" });
  });

  // Appointments ---------------------------------------------------------------------------
  app.get("/denticon/appointments/v0", (req, res) => {
    const office = officeFilter(req, res);
    if (office === false) return;
    const filters = parseChangeFilters(req.query);
    if (typeof filters === "string") return problem(res, 400, "Bad Request", filters, req.path);
    const apptDate = parseRange(req.query, "AppointmentDate");
    if (typeof apptDate === "string") return problem(res, 400, "Bad Request", apptDate, req.path);
    let rows = data.appointments;
    if (office !== null) rows = rows.filter((a) => a.officeId === office);
    if (req.query.PatientId !== undefined) rows = rows.filter((a) => a.patientId === Number(req.query.PatientId));
    rows = applyChangeFilters(rows, filters).filter((a) => inRange(a.appointmentDate, apptDate));
    res.json(paginate(rows, req.query));
  });
  app.get("/denticon/appointments/v0/:id", (req, res) => {
    const a = data.appointments.find((x) => x.appointmentId === Number(req.params.id));
    return a ? res.json({ data: a, message: "Success" }) : problem(res, 404, "Not Found", "Appointment not found.", req.path);
  });

  app.use("/denticon", (req, res) => problem(res, 404, "Not Found", `No mock route for ${req.method} ${req.path}`, req.path));

  return { app, data, stats: () => ({ requests }) };
}
