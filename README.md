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

Primary data source is the practice management system (Denticon, via the PlanetDDS API,
read-only) for patient/provider/location/treatment-plan data. Financing application data
(submitted/approved/declined/funded, by lender) starts as manual CSV intake into staging
tables until a direct lender/API integration is worked out.

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
```

### Frontend

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173
```

## Status

Early scaffold — schema and API are stubs matching the storyboard's step 1 ("nail the data
model down"). No live Denticon or lender integration yet. See docs/data-model.md for what's
still open.

## Credentials

Never commit real credentials. Copy `.env.example` to `.env` (gitignored) and fill in secrets
locally, or via your hosting provider's secret manager. Nothing sensitive belongs in this repo,
in commit messages, or in any notes/logs about this project.
