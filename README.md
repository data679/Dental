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
[docs/denticon-api.md](docs/denticon-api.md) for the integration, and
[docs/denticon-bcp.md](docs/denticon-bcp.md) for the alternative feed: the scheduled
full-database "Denticon Download" (BCP) export, which needs no API key. Financing application data
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
npm run test:db           # + database-backed tests, in a throwaway schema
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

### Denticon data download (BCP feed)

The practice group already receives a scheduled full-database export from Denticon
(Utilities → Denticon Download). The loader reads it without an API key:

```bash
npm run bcp:sample -- --zip                       # synthetic download for testing (password "sample")
npm run bcp:inspect -- path/to/download.zip       # what's inside, no DB: delimiter, columns, adapter per table
npm run bcp:load -- path/to/download.zip          # land + promote into the same tables the API sync uses
curl localhost:4000/api/bcp/status
```

Set `DENTICON_BCP_PASSWORD` (the zip password) and, for the schedule, `DENTICON_BCP_INBOX`
so the worker sweeps the drop folder. Column names for headerless files go in
`backend/bcp-feed.json`. See [docs/denticon-bcp.md](docs/denticon-bcp.md).

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

## The report this replaces

[docs/os-dental-report.md](docs/os-dental-report.md) documents the OS Dental Finance
Report's exact column definitions (verified against a real export) and the one column that
needs PMS ledger data we don't ingest yet.

## Demo on GitHub Pages

A backend-free build of the dashboard is deployed by
[.github/workflows/pages.yml](.github/workflows/pages.yml) on every push to `main`. It
computes the same summaries in the browser from a committed snapshot of the **synthetic**
demo data (`frontend/public/data/snapshot.json`), with all filters live; importing is
disabled there. Refresh the snapshot with:

```bash
cd backend && npm run snapshot && npm run snapshot:verify   # API must be running
```

`snapshot:verify` diffs the browser-side math against the live API. One-time repo setup:
*Settings → Pages → Source: GitHub Actions*. The snapshot script refuses to export from a
real Denticon tenant unless told to, and never includes names, DOBs or contact details.

## Status

Early scaffold — schema and API match the storyboard's step 1 ("nail the data model
down"). The Denticon integration is built and tested against the published API contract
(client, incremental sync into staging, staging → core processing, funnel stages for
treatment presented/completed) but runs no-op until a PlanetDDS subscription key is
issued. A second Denticon feed — the scheduled BCP data download — has a loader ready
(docs/denticon-bcp.md) and is waiting on the first real file. The financing half of the funnel is fed by CSV import of lender exports
(docs/financing-intake.md). See docs/data-model.md for what's still open.

## Credentials

Never commit real credentials. Copy `.env.example` to `.env` (gitignored) and fill in secrets
locally, or via your hosting provider's secret manager. Nothing sensitive belongs in this repo,
in commit messages, or in any notes/logs about this project.
