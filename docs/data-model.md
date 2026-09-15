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
- **Financing data** — no confirmed API yet. Plan is manual CSV intake into staging tables
  until a lender/Denticon integration for financing status is available.

## Open questions (from the storyboard — unresolved)

1. **What exactly counts as a "new patient"?** Walk-in vs. booked vs. first-visit-completed
   — these can disagree with each other and change the denominator for every funnel metric.
2. **How granular does application status need to be?** Storyboard lists
   submitted/pending/approved/declined, but flags that "in review" or "expired" might also be
   needed. Affects the `financing_applications.status` enum below.
3. **What fields are actually required per record?** The entity list above is a first pass
   from the storyboard, not confirmed against real Denticon field availability.
4. **Denticon integration owner/contact** — API access needs to be requested from someone at
   PlanetDDS/Denticon; not yet identified who.
5. **Open Dental** — mentioned as a possible secondary PMS to support; not scoped yet.

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
