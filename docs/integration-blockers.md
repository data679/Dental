# Real-data integration: blockers and open issues

_Status as of 2026-09-18. What stands between the working MVP (synthetic data) and real
practice + lender data, with what unblocks each item and who owns it._

The pipeline itself is built and tested end to end: Denticon client → incremental sync →
staging → core tables → dashboard, and lender CSV → matching → cases → funnel. Every item
below is an external dependency, an unverified assumption, or a decision — not missing code.

## A. Denticon / PlanetDDS API

| # | Blocker | Impact | Unblocked by | Owner |
|---|---|---|---|---|
| A1 | **No API credentials.** The current API needs a `PDDS-Subscription-Key` (Azure API Management) issued per practice group through PlanetDDS's developer/partner process. Nobody has requested it and the PlanetDDS contact is unidentified. | Hard blocker. Every Denticon job no-ops without it. | Request a **v0 subscription key** from PlanetDDS support / account manager for our practice group. | Practice ops |
| A2 | **Wrong-generation sample code.** The only reference we were given (`PlanetDDS_Api_SampleCode` on GitHub) targets the legacy v1 API (`dev-api.denticon.com`, `API-AUTH-KEY` / `API-VENDOR-KEY` / `PGID`), which is not what PlanetDDS documents today. | Risk of being issued legacy vendor keys that don't work with the documented endpoints. | State explicitly in the request: *current v0 REST API at api.planetdds.com, subscription key, not legacy vendor keys*. | Practice ops |
| A3 | **Product scoping.** Keys are scoped to API "products". We need **Practices + Patients + Clinical** for the funnel; **Appointments** for the new-patient signals; **RCM** later for ledger-based case value/collections. A key missing a product returns 403 per call. | Partial data or silent gaps if scope is short. | Ask for all five products up front; `npm run denticon:check` reports 401/403 immediately. | Practice ops |
| A4 | **No financing data in Denticon at all.** None of the seven API areas has a lender, application, approval, or funding concept. Confirmed against the full OpenAPI catalogue. | The financing half of the funnel can never come from the PMS. | Lender exports (section B) — no alternative. | — |
| A5 | ~~"New patient" definition undecided.~~ **Resolved 2026-09-21:** a new patient is one who completed a first visit (`firstVisitDate`); booked/no-show patients are not. Implemented as a generated column (migration 0009). | — | — | — |
| A6 | **Undocumented value sets.** The OpenAPI specs don't enumerate `providerType`, `sex`, `relationToResponsibleParty`, `patientTypeCode` values, or the `createdBy` user strings. Our mock invents plausible ones. | Low: stored raw; only affects labels/filters built on them. | First real sync; check `staging_denticon_patients.raw`. | Dev |
| A7 | **No sandbox tenant known.** Unclear whether PlanetDDS provides a test practice group. We built our own mock server instead. | Cutover goes straight to production data. | Ask in the same request as A1. | Practice ops |
| A8 | **API constraints shape the sync** (not blockers, already handled): 30-day max window per request, `LastChangedOn` exclusive with `CreatedOn`/`ModifiedOn`, treatment plans require a date filter and are item-level (one row per procedure), 429 rate limiting with a retry hint, `officeId` typed as string on `/offices` but integer elsewhere. | A 1-year backfill is ≥12 requests per entity per office plus one per touched patient. First sync may take a while under rate limits. | Nothing; noted so nobody "fixes" it. | — |
| A9 | **Webhooks unexplored.** A Subscriptions API exists (per-office, per-entity push). We poll hourly. | Freshness is hourly, not real-time. | Post-MVP. | Dev |

## B. Lender export issues

| # | Issue | Impact | Unblocked by | Owner |
|---|---|---|---|---|
| B1 | **No real export from any lender yet** (CareCredit, Sunbit, Cherry, Alphaeon, Proceed, HFD, Fortiva, Access, Covered Care, Eve). Every header alias, status word and date/amount format in the importer is inferred, not observed. | The importer may map a real file wrongly or reject rows. It reports exactly how it read each header, so this is fast to fix — but only with a file in hand. | **One export from one lender** (even a month, even old). Then each further lender as they come. | Practice ops / finance |
| B2 | **Patient identity is name + DOB.** Lender portals don't know PMS ids. Matching ladder is Denticon id → chart no → last name + DOB → name only. Real duplicate charts in Denticon return *ambiguous* by design; exports without a DOB column fall to name-only matching. | Some applications stay unlinked (still counted in the funnel, but not filterable by provider / new-patient). | Confirm which identifiers each portal exports; ask front desk to type the chart number into the lender application's reference field where the portal allows it. | Finance + front desk |
| B3 | **Which programs each lender runs is a starting guess.** Some lenders are prime-only, some subprime-only, some run both; the `lenders` table holds the current configuration (financing-intake.md § Tiers). For both-program lenders the export must carry a Program/Tier column or the tier is recorded as unknown. | Prime vs SubPrime filter is only as good as the configuration + the export's tier column. | Whoever runs the applications confirms the table (`PUT /api/lenders/:code`); check each lender's export for a tier column. | Finance |
| B4 | **Multi-app grouping window is a guess (14 days).** Applications for the same patient within 14 days are treated as one case. A second treatment inside two weeks would be merged; a portal request id would avoid guessing but we don't know if any portal exports one. | Case counts (funnel financing stages) could be slightly over-merged. | Confirm from real files; window is one env variable (`FINANCING_CASE_WINDOW_DAYS`). | Finance |
| B5 | **Soft vs hard pull relies on wording** ("Prequalified" / "Pre-approved" ⇒ soft) or an explicit column. | Soft/hard split may be blank for lenders that don't say. | Real files. | Finance |
| B6 | **Funding data may live in a different export than applications.** Some portals report *transactions* (purchase date/amount) separately from *applications* (decision). We handle both in one file or via re-import, but haven't seen the real split. | "Funded" stage could lag or be missing for some lenders. | Real files; possibly two files per lender per period. | Finance |
| B7 | **Location naming.** Exports name the practice as the portal's *merchant* name; we match to our locations by name (exact, then unique substring). Multi-location merchant ids are unknown. | Unmatched merchant names fall back to the patient's location, or blank if unmatched. | Merchant-name → location list from finance; one-time alias entry. | Finance |
| B8 | **Manual, ownerless process.** Exports must be downloaded and uploaded by someone on a cadence; nothing is scheduled. Lender APIs (CareCredit, Sunbit have partner programs) need agreements we don't have. | Data freshness depends on a person. | Name an owner and a cadence (monthly is fine to start). | Practice ops |
| B9 | **PII in transit.** Lender exports contain names, DOBs and sometimes addresses; the import endpoints are **unauthenticated** until Auth0 is wired, and the app isn't hosted anywhere HIPAA-appropriate yet. | Must not point real files at a public deployment. Local use only for now. | Auth0 on the import/Denticon routes; HIPAA-eligible hosting with a BAA (Render/Railway/AWS). | Dev |

## B-bis. Reference report received (2026-09-22)

An aggregated monthly Finance Report export was supplied — no patient data, so nothing in
section B's privacy concerns applies to it. It resolves several unknowns and adds one:

- The exact metric definitions the practice expects are now known and implemented
  (docs/os-dental-report.md); the practice-comparison table matches them column for column.
- **New dependency:** "Total Collected Amounts" is practice-wide collections and can only
  come from the PMS ledger (`dbo_Ledger` in the BCP download, landed raw today with no
  adapter, or `/rcm/v0/ledgers`). It is the one column of the report we cannot yet produce,
  and it also unlocks "what share of collections is financed". This raises ledger
  ingestion from "later" to the top of the post-cutover list.
- It confirms multi-lender applying is the norm, not an edge case.
- Five questions for the report owner are listed at the end of docs/os-dental-report.md.

## C. What to send, verbatim

**To PlanetDDS support / account manager**
> We're integrating our practice group with the Denticon REST API (api.planetdds.com, v0). Please issue a developer-portal subscription key for practice group [name / PGID] with the Practices, Patients, Clinical, Appointments and RCM products, read-only use. We do not need legacy v1 vendor keys. Is a sandbox practice group available for testing? Who is our technical contact for API questions?

**To each lender rep (or the portal's export page)**
> Please provide an application-level export for [practice] covering [one recent month], including: application/reference id, applicant name and date of birth, submission date, decision and decision date, approved/credit-limit amount, funded/purchase date and amount, merchant/location name, and whether the check was a soft prequalification or a full application, if your export distinguishes them.

**Internal decisions needed**
1. ~~Definition of "new patient"~~ — decided (A5).
2. Confirm which programs each lender runs — prime, subprime, or both (B3). The criteria
   and the per-lender evidence are in the *Lender feeds & classification* panel; mark each
   one `lender_confirmed` as it is checked.
3. Who owns lender exports and how often (B8) — enter the owner and cadence in the same
   panel; overdue feeds are then flagged automatically.

## D. Once unblocked — cutover steps

1. Put the key in `backend/.env` → `npm run denticon:check` (verifies scope in seconds).
2. `npm run seed -- --reset-only` → `npm run worker` → `npm run denticon:sync -- --full`.
3. Import the first real lender file on the Import page; read the header-mapping table and warnings; add aliases to `columns.ts` for anything shown as *ignored*.
4. Review *Data quality* on the Import page (unlinked applications, duplicate charts, missing dates).
5. Only after Auth0 + hosting: move off local.
