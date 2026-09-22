# The OS Dental Finance Report — what it measures

The report this project replaces. A real monthly export (15 practices, one month) was
supplied as a reference; the definitions below were reverse-engineered from it and
**verified arithmetically against every practice row and the total**. The export itself is
aggregated — no patient data — but it contains the group's revenue figures, so it is **not
committed to this repository** (which is public). Only the formulas live here.

The matching view is the *Practice comparison* table on the dashboard
(`byPractice` in `GET /api/finance/summary`, `backend/src/services/financeService.ts`).

## Columns and their formulas

| Column | Definition | Verified | We compute it |
|---|---|---|---|
| Practice Name | one row per practice, plus a Total row | — | yes |
| New Patients | new patients in the period | — | yes (`first_visit_date` in range — see data-model.md) |
| % of NP Applying | new patients with ≥1 application ÷ new patients | implied counts are whole numbers at every practice | yes |
| Applications | individual applications submitted | — | yes |
| Approved | applications with an approved decision | — | yes |
| Approval Rate | **Approved ÷ Applications** | exact at all 16 rows | yes — note the caveat below |
| Approval Amount | Σ approved amount | — | yes |
| Average Approval Amount | Approval Amount ÷ Approved | exact at all 16 rows | yes |
| Amount Collected From Apps | Σ amount actually funded/used | — | yes (`fundings.funded_amount`) |
| % Collected From Apps | Collected ÷ Approval Amount | exact at all 16 rows | yes — this is credit **utilisation** |
| Total Collected Amounts | practice-wide collections, all payment types | — | **no — needs PMS ledger data** |

The Total row is a true aggregate: every count and amount column sums exactly, and the
rate columns are recomputed from the totals rather than averaged.

## The one number that misleads: Approval Rate

Approval Rate counts **every application** in the denominator — including pending and
withdrawn ones — and the practice applies to several lenders per patient. So a patient who
is shopped to four lenders and approved by one contributes 1 approval and 4 applications:
a 25% "approval rate" for a patient who got financed.

In the reference month, applications outnumbered applying new patients several times over,
while approvals were close to one per applying patient. Read literally the report suggests
roughly a quarter of applications succeed; read per patient, the great majority of patients
who applied came away with an approval. **Both numbers are true and they answer different
questions** — "how efficient is our lender shopping?" versus "do our patients get
financed?".

This is why the funnel counts *cases* (docs/financing-intake.md § Multi-lender) and why the
practice table carries two extra columns the source report cannot produce:

- **Patients approved** — share of financing cases approved by at least one lender.
- **Cases funded** — cases where the patient actually drew on the credit.

`approvalRateOfDecisioned` (approved ÷ approved+declined) is also computed, for comparing
lenders to each other without pending/withdrawn noise.

## What we can't produce yet

**Total Collected Amounts** is practice-wide collections — cash, insurance, financing,
everything — so it cannot come from lender exports. It needs the PMS ledger: the Denticon
RCM API (`/rcm/v0/ledgers`) or the `dbo_Ledger` table already present in the BCP download
(landed raw today, no adapter). Once ingested it also gives the ratio the report implies
but never states: **what share of the practice's collections is financed**.

That is the strongest argument for prioritising ledger ingestion — see
`docs/integration-blockers.md`.

## Questions for whoever runs the report

1. **Date basis.** The export has a single date filter. Does it cohort on *application
   date* (our assumption — "collected" then means money against applications submitted in
   the month) or does "Amount Collected From Apps" mean money *collected* during the month,
   regardless of when the application was submitted? The two diverge at month boundaries.
2. **Two filters both named "Patient Type"** appear in the footer ("is All", "is
   Applications"). Is the second one a different dimension?
3. **Are Applications restricted to new patients?** "% of NP Applying" is about new
   patients, but the Applications column looks practice-wide. If so, the two columns have
   different populations and the ratio between them isn't applications-per-applicant.
4. **One practice reported more collected-from-apps than total collections** — impossible
   on its face, so either the two columns use different periods (financing funded this
   month against production posted in another) or it's a defect in the source report.
5. **Gardena appears twice** (a second location with the same city name). Distinct offices,
   or a duplicated record?

## Demo data

`backend/src/integrations/denticon/mock/data.ts` and
`backend/src/scripts/financingSample.ts` were retuned to the *shape* of this report — 15
offices, financing that tracks case size, several lenders per applying patient, and the
resulting low per-application approval rate — so the demo exercises the same regime. The
volumes and amounts are much smaller than a real month and none of the group's actual
figures are reproduced.
