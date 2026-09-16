# Dental — Patient-to-Financing Funnel Analytics

A DSO performance/analytics platform (in the spirit of OS Dental) that tracks the funnel from
new patient to treatment financing: lead → treatment presented → application submitted →
approved/declined → funded → treatment completed.

## Patient path

1. Lead / New Patient (marketing source)
2. Treatment Presented
3. Financing Application Submitted (primary or subprime lender)
4. Approved / Declined
5. Funded / Used
6. Treatment Completed

See [docs/data-model.md](docs/data-model.md) for the full field-level breakdown and the open
questions still being nailed down.

## Tech stack

| Layer      | Choice                              |
|------------|--------------------------------------|
| Backend    | Node.js + TypeScript + Express       |
| Database   | PostgreSQL                           |
| Job / ETL  | BullMQ (Redis-backed) + staging tables |
| Frontend   | React + TypeScript + Tremor + Recharts |
| Auth       | Auth0                                |
| Hosting    | Render / Railway or AWS (HIPAA-compliant) |

Primary data source is the practice management system (Denticon, via the PlanetDDS REST
API, read-only) for patient/provider/location/treatment-plan data — see
[docs/denticon-api.md](docs/denticon-api.md) for the integration. Financing application data
(submitted/approved/declined/funded, by lender) comes from lender CSV exports imported
through the app — see [docs/financing-intake.md](docs/financing-intake.md) — until a
direct lender API integration is worked out.

## Repo layout

```
backend/    Node.js API + Postgres migrations + BullMQ ETL jobs
frontend/   React dashboard (funnel view, filters by location/provider/date range/lender)
docs/       Data model, open questions, and planning notes
```

## Getting started

### Backend

```bash
cd backend
cp .env.example .env   # fill in DATABASE_URL, REDIS_URL, AUTH0_*
npm install
npm run migrate         # applies SQL migrations in src/db/migrations
npm run dev              # API on http://localhost:4000
npm run worker            # BullMQ worker process (separate terminal)
npm test                  # unit tests (vitest)
```

### Denticon sync

```bash
cd backend
npm run denticon:check          # verify DENTICON_SUBSCRIPTION_KEY against the live API
npm run denticon:sync -- --full # queue a backfill (worker must be running)
curl localhost:4000/api/denticon/status
```

No key yet? `npm run denticon:mock` serves a synthetic practice group in the real API's
shapes on http://localhost:4900/denticon (key `mock-key`); example payloads are in
[docs/samples/denticon](docs/samples/denticon/). See docs/denticon-api.md.

### Financing data (lender CSV imports)

Lender application exports are imported from the dashboard's **Import Financing Data**
page (or `POST /api/finance/import`). See [docs/financing-intake.md](docs/financing-intake.md);
a sample export that matches the mock patients is in
[docs/samples/financing](docs/samples/financing/).

### Frontend

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173
```

## Status

Early scaffold — schema and API match the storyboard's step 1 ("nail the data model
down"). The Denticon integration is built and tested against the published API contract
(client, incremental sync into staging, staging → core processing, funnel stages for
treatment presented/completed) but runs no-op until a PlanetDDS subscription key is
issued. The financing half of the funnel is fed by CSV import of lender exports
(docs/financing-intake.md). See docs/data-model.md for what's still open.

## Credentials

Never commit real credentials. Copy `.env.example` to `.env` (gitignored) and fill in secrets
locally, or via your hosting provider's secret manager. Nothing sensitive belongs in this repo,
in commit messages, or in any notes/logs about this project.
