# Data Model & Open Questions

Source: internal "What is OS Dental?" storyboard doc. This file is the working spec for
step 1 of the course of action — "nail the data model down" — plus what's still undecided.

## Funnel stages

| Stage | What it captures | Key metrics |
|---|---|---|
| New patient | Anyone who books or walks in as a new patient | # new patients (by location, provider, source) |
| Treatment presented | Patient given a treatment plan requiring financing | % of new patients presented a plan |
| Application submitted | Financing app sent to a lender (primary or subprime) | # applications submitted (by location, provider, lender) |
| Application approved | Lender approves the application | Approval rate, avg approved amount |
| Application declined | Lender declines | Decline rate, decline reasons (if available) |
| Funded | Patient actually uses the approved treatment | Funds rate, avg utilization vs. approved limit |
| Treatment completed | Case tied to the financing is completed | Time to treatment, case value |

Lenders in scope: HFD, Alphaeon, Cherry, Care Credit, Proceed, Covered Care, Eve, Sunbit.
Applications split into **primary** (better credit score) and **subprime** (lower credit
score, with down payment).

## Entities (draft — see open questions before treating as final)

- **Location** — id, name
- **Provider** — id, name, location_id
- **Patient** — id, location_id, provider_id, source (marketing channel), new_patient_flag,
  first_visit_date, created_at
- **Treatment plan** — id, patient_id, procedure_code, proposed_fee, status, presented_date
- **Financing application** — id, patient_id, treatment_plan_id, lender, application_type
  (primary | subprime), status, submitted_date, decision_date, approved_amount,
  decline_reason
- **Funding** — id, application_id, funded_date, funded_amount, utilization_pct
- **Treatment completion** — id, treatment_plan_id, completed_date, case_value

## Data sources

- **Denticon** (PlanetDDS) — practice management system API, **read-only**.
  Docs: https://developer.planetdds.com/
  Provides: patient demographics, new-patient flag / first-visit data, location, assigned
  provider, treatment plans (procedure code, proposed fee, status).
  **Status: integration built, credentials pending.** The client, incremental sync and
  staging → core processing are implemented against the published OpenAPI contract (see
  [denticon-api.md](denticon-api.md)); the `syncDenticon` job no-ops until
  `DENTICON_SUBSCRIPTION_KEY` is set. Confirmed available from the API: patient office,
  preferred provider, referral type (source), first/last visit dates, created date,
  patient type code; treatment plans at procedure level with status, fees, proposed /
  accepted / finish dates and completion flags.
- **Financing data** — Denticon has none, and no lender API is connected. Built as CSV
  intake of lender exports with header aliasing, patient matching by chart no / name + DOB,
  and idempotent upserts: see [financing-intake.md](financing-intake.md). A synthetic sample
  export lives in `docs/samples/financing/`; real lender files are still needed to confirm
  columns and the prime/subprime split.

## Example data received (MVP seed)

Since live Denticon access is blocked, an example export of a single Denticon **Patient
Ledger** screen (a test patient) was provided instead, to unblock an MVP. What it actually
showed, for reference:

- **Patient info**: name, DOB, sex, patient ID (numeric, e.g. `4000157`), provider,
  hygienist, home office, referral type, referred by/to, first/last/next visit, fee
  schedule, preferred language, address, a lender badge next to the name (e.g. "CareCredit").
- **Appointments**: date, time, office, operatory, provider, duration, status.
- **Recalls**: procedure code, interval, recall date, reason.
- **Responsible party, insurance** (carrier, group #, deductible/max remaining), **account
  balances** (current + 30/60/90/120 aging), **contract** remaining amounts (regular/ortho).

What it did **not** show: any treatment-plan record, or financing-application specifics
(submitted/approved/declined/funded, amounts) beyond that one lender badge. So this example
maps to the **patient** side of the schema, not the financing funnel side.

Given that, `backend/src/db/seed.ts` loads representative *synthetic* patients (varied
provider/location/source/first-visit-date, patient-ID numbering styled after the example)
for the MVP demo. It deliberately does **not** fabricate treatment plans, financing
applications, fundings, or completions — those funnel stages stay at 0 in the dashboard
until real (or at least example) financing data is available. No real patient data appears
anywhere in this repo, in seed data, or in logs — synthetic data only.

## Open questions (from the storyboard — unresolved)

1. **What exactly counts as a "new patient"?** Walk-in vs. booked vs. first-visit-completed
   — these can disagree with each other and change the denominator for every funnel metric.
2. **How granular does application status need to be?** Storyboard lists
   submitted/pending/approved/declined, but flags that "in review" or "expired" might also be
   needed. Affects the `financing_applications.status` enum below.
3. **What fields are actually required per record?** The entity list above is a first pass
   from the storyboard. Denticon field availability is now known (see
   [denticon-api.md](denticon-api.md)) — what's still unconfirmed is which of them the
   report actually needs.
4. **Denticon integration owner/contact** — API access needs to be requested from someone at
   PlanetDDS/Denticon; not yet identified who.
5. **Open Dental** — mentioned as a possible secondary PMS to support; not scoped yet.
6. **Appointments, recalls, insurance, and balances** (all visible on the example Patient
   Ledger) aren't modeled in the schema yet — out of scope for the funnel MVP, but likely
   needed if this platform grows beyond the funnel view.

## Course of action (from storyboard)

1. Nail the data model down (the above).
2. Get read access to the data — PMS read access + manual CSV intake for financing data —
   and confirm where each currently lives.
3. Build the funnel dashboard with basic filters: location, provider, date range, lender.

## Notes

- Tech stack, hosting, and infra choices live in the [README](../README.md).
- No real patient data, credentials, or API keys belong in this repo or in any docs/notes
  about it — reference where they're stored instead (e.g. "in `.env`", "in the hosting
  provider's secret manager").
