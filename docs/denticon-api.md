# Denticon (PlanetDDS) API integration

How this project talks to Denticon, what it pulls, and how the data lands in our schema.
Code lives in `backend/src/integrations/denticon/` (client) and `backend/src/etl/denticon/`
(sync + processing). No credentials or patient data belong in this doc.

## Which API

PlanetDDS publishes two generations of API. The public sample repo
([planetddsgithub/PlanetDDS_Api_SampleCode](https://github.com/planetddsgithub/PlanetDDS_Api_SampleCode))
is a 2015-era ASP.NET MVC page whose only real content is two jQuery calls against the
**legacy v1** API:

| | Legacy v1 (sample repo) | Current v0 (developer portal) — **what we use** |
|---|---|---|
| Base URL | `http://dev-api.denticon.com/v1/api/` | `https://api.planetdds.com/denticon/<area>/v0` |
| Auth headers | `API-AUTH-KEY`, `API-VENDOR-KEY`, `PGID` | `PDDS-Subscription-Key` (Azure API Management subscription key, issued per practice group) |
| Docs | none beyond the sample | OpenAPI 3 per area at https://developer.planetdds.com/apis |
| Example calls | `GET Appointment/List/`, `POST Appointment/Details/` (form-encoded `APPTID`) | see below |

The client (`DenticonClient`) is built for v0. It still accepts the legacy header trio
(`legacy: { authKey, vendorKey, pgId }`, env `DENTICON_LEGACY_*` / `DENTICON_PGID`) and a
custom `baseUrl`, so if PlanetDDS only issues legacy credentials the same class can call
the old endpoints via `client.request()` — but none of the typed methods exist on v1.

## Areas and endpoints used

Everything we call is read-only (`GET`). Every list endpoint is paginated
(`PageNumber` / `PageSize` ≤ 1000) and returns
`{ data, message, pageNumber, pageSize, pageCount, totalCount, totalPages }`.

| Area | Endpoint | Used for |
|---|---|---|
| practices/v0 | `GET /` | practice group name (ping) |
| practices/v0 | `GET /offices` | → `locations` (keyed on `denticon_office_id`) |
| practices/v0 | `GET /providers` | → `providers` (keyed on `denticon_provider_id`) |
| practices/v0 | `GET /referral-types` | `refTypeCode` → description, used as `patients.source` |
| patients/v0 | `GET /?OfficeId&LastChangedOn.DateFrom&LastChangedOn.DateTo` | → `staging_denticon_patients` → `patients` |
| clinical/v0 | `GET /treatment-plans?OfficeId&LastChangedOn.*` | discovers patients with plan activity |
| clinical/v0 | `GET /patients/{PatientId}/treatment-plans` | full plan item set → `staging_denticon_treatment_plans` → `treatment_plans` (+ `treatment_completions`) |

Also typed but unused so far: `GET /patients/v0/{PatientId}`, `GET /appointments/v0`,
`GET /appointments/v0/{AppointmentId}`, procedure codes, patient type codes. Other areas
(RCM ledgers/claims, Insights, Subscriptions = webhooks) exist on the portal and could be
added the same way; ledger data is the likely source for real "case value" later.

### Rules Denticon enforces (the client checks these before sending)

- Change filters: **one** of `CreatedOn`, `ModifiedOn`, `LastChangedOn` — `LastChangedOn`
  can't be combined with the others. Both `DateFrom` and `DateTo` required, ISO-8601.
- Every date range ≤ **30 days**. The sync walks longer spans in 30-day windows
  (`dateWindows.ts`).
- `/clinical/v0/treatment-plans` *requires* a date filter.
- 429 body: `{"message":"Rate limit is exceeded. Try again in N seconds."}` — the client
  sleeps N seconds (or `Retry-After`) and retries, then 5xx/network errors with
  exponential backoff; 3 retries by default.
- Errors are RFC 7807 problem details; surfaced as `DenticonApiError` with `.status` and
  `.problem`.

## Sync design

`syncDenticon` job (BullMQ queue `denticon-sync`), run by `npm run worker`:

1. **Reference** — reload offices, providers, referral types (small, no change filter).
2. **Patients**, per office — from the office's watermark (or `DENTICON_BACKFILL_DAYS`
   ago on first run) to now, in 30-day windows, `LastChangedOn`-filtered. Rows are
   upserted into staging keyed on `denticon_patient_id`; the watermark advances after
   each window so an interrupted run resumes.
3. **Treatment plans**, per office — the office-wide feed is item-level (one row per
   procedure) and only returns *changed* items, so it is used only to find touched
   patients; each touched patient's complete plan list is then fetched and stored whole
   (one staging row per plan, `raw` = array of items). Correct at the cost of one extra
   request per touched patient.
4. **Process** staging → core: upsert `patients`, roll up plan items into one
   `treatment_plans` row (fee sum, distinct procedure codes, earliest proposed date,
   accepted date, completed when *all* items are complete), and maintain
   `treatment_completions`. Plans whose patient hasn't synced yet stay unprocessed and
   are picked up next run.

Progress and last-run outcome per (entity, office) live in `denticon_sync_state`
(`GET /api/denticon/status`). One office failing (403 out of scope, persistent 5xx)
doesn't stop the others: its error is recorded, the rest sync and process, and the job
fails at the end with a summary. Records without a `patientId` / `treatPlanId` are
skipped and counted rather than stored under a null key.

### Status mapping

Denticon `treatPlanStatus` → `treatment_plans.status`:

| Denticon | Meaning | Ours |
|---|---|---|
| `A` | Accepted | `accepted` |
| `U`, `R` | Unaccepted, Referred out | `declined` |
| `D`, `H`, `L`, other | Diagnosed, Hold, Alternative | `presented` |

`patients.new_patient_flag` is derived from `firstVisitDate` only (decided 2026-09-21: a
new patient is one who completed a first visit; booked/no-show patients are not). It is a
generated column, so neither feed writes it. `createdOn` and `patientTypeCode` remain in
staging `raw` if the definition is revisited.

## Sample data and mock server (no key needed)

Until PlanetDDS issues a key, a synthetic practice group in the exact documented shapes
is available two ways:

- **Static payloads** — [`docs/samples/denticon/`](samples/denticon/): one example
  response per endpoint plus the 400/401/429 error bodies. Regenerate with
  `npm run denticon:samples`.
- **Mock API** — `npm run denticon:mock` serves the same dataset on
  `http://localhost:4900/denticon` and reproduces the API's behaviour (subscription-key
  auth, pagination envelope, 30-day cap and filter rules as RFC 7807 errors, string
  `officeId` on `/offices`, `ucrFee` only on the per-patient plan endpoint, optional 429s
  via `DENTICON_MOCK_RATE_LIMIT_EVERY`). Point the backend at it and the real client,
  sync job and dashboard run unchanged:

  ```bash
  npm run denticon:mock                     # terminal 1
  npm run seed -- --reset-only              # clear the hand-made seed rows
  DENTICON_API_BASE_URL=http://localhost:4900/denticon DENTICON_SUBSCRIPTION_KEY=mock-key npm run worker   # terminal 2
  DENTICON_API_BASE_URL=http://localhost:4900/denticon DENTICON_SUBSCRIPTION_KEY=mock-key npm run denticon:sync -- --full
  ```

  (Or put those two values in `.env`.) The generator is
  `backend/src/integrations/denticon/mock/data.ts`: seeded, so the dataset is identical
  every run — 3 offices, 13 providers, 420 patients skewed toward recent months, ~270
  treatment plans (~765 procedure items) with a documented status mix, ~670
  appointments. All identities are invented (`@example.com`, `555-` numbers). Value sets
  that are *not* confirmed against a live tenant are flagged in the file header
  (`providerType`, `sex`, `relationToResponsibleParty`, user names).

  When the real key arrives: switch the two env vars, `npm run seed -- --reset-only`,
  and run a full sync — nothing else changes.

### Candidate "new patient" signals in the API

Decided: `firstVisitDate` (see `data-model.md`). Kept for reference — the alternatives
considered, all captured by the sync (patients in staging `raw`; appointments typed but
not yet synced):

| Signal | Where | Meaning |
|---|---|---|
| `firstVisitDate` | patient | first completed visit — "first-visit-completed" definition |
| `createdOn` | patient | chart created — "booked/registered" definition |
| `patientTypeCode` | patient | practice-assigned type, e.g. `01` = New Patient (codes from `/practices/v0/patient-type-codes`) |
| `isNewPatient` | appointment | "not completed registration yet" — the booked-but-not-seen state |
| `appointmentStatus` = Missed/Cancelled on the first appointment | appointment | booked-but-never-came |

## Running it

```bash
cd backend
npm run migrate            # adds denticon_* columns + denticon_sync_state (0004)
npm run denticon:check     # verifies the key: practice, offices, providers, 1 page of patients
npm run worker             # executes queued syncs; also schedules DENTICON_SYNC_CRON
npm run denticon:sync -- --full            # or: curl -X POST localhost:4000/api/denticon/sync
curl localhost:4000/api/denticon/status
```

Env (see `backend/.env.example`): `DENTICON_SUBSCRIPTION_KEY` (required),
`DENTICON_API_BASE_URL`, `DENTICON_OFFICE_IDS`, `DENTICON_BACKFILL_DAYS`,
`DENTICON_SYNC_CRON`, legacy `DENTICON_LEGACY_AUTH_KEY` / `DENTICON_LEGACY_VENDOR_KEY` /
`DENTICON_PGID`.

Without a key every job no-ops and `/api/denticon/ping` returns 503, so the rest of the
app keeps working on seed data.

## Getting credentials

A subscription key comes from PlanetDDS (developer portal sign-up + their partner
process) and is scoped to a practice group and a set of "products" (API areas). The key
needs at least the **Practices**, **Patients** and **Clinical** APIs for this sync. A 401
from `denticon:check` means the key is wrong; a 403 usually means the product/office
scope doesn't include what was requested.
