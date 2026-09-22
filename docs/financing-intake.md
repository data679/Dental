# Financing data intake (lender CSV exports)

Denticon has no financing/lender data (see [denticon-api.md](denticon-api.md)), so the
application → approved → funded half of the funnel is fed by importing each lender's
application export. This is the "manual CSV intake" path from the storyboard, built so a
lender API can replace the file step later without touching the tables.

Code: `backend/src/etl/financing/` (parser, column mapping, matching, import service),
`backend/src/routes/financeImport.ts`, `frontend/src/pages/ImportPage.tsx`.

## How to import

- **UI**: dashboard → *Import Financing Data* → drop the CSV. The result shows inserted /
  updated / unmatched / rejected counts, per-row errors, and exactly how each header in
  the file was interpreted.
- **API**: `POST /api/finance/import` with `Content-Type: text/csv` (query `sourceFile`,
  `importedBy`) or JSON `{ csv, sourceFile, importedBy }`.
- **Template**: `GET /api/finance/import/template` — the canonical headers with one
  example row. A file using these headers needs no aliasing.

Re-importing a file is safe: rows upsert on the lender's application id (`external_id`),
or on lender + patient identifiers + submitted date when the export has no id.

## Columns

Only `lender` and `status` are required. Header matching is case/punctuation-insensitive
and alias-driven (`columns.ts` → `HEADER_ALIASES`), so "Financing Co.", "Credit Limit",
"Purchase Date", "Merchant Name", "Applicant Last Name" all map without configuration.
Add a new lender's spellings there when its export shows up.

| Canonical column | Used for |
|---|---|
| `external_id` | idempotent re-import key; lender's application/reference number |
| `lender` | CareCredit, Alphaeon, Cherry, Proceed, Sunbit, HFD, Covered Care, Eve, Fortiva, Access (many spellings accepted) |
| `application_type` | prime / subprime (aliases: Program, Tier, Product Type…). See **Tiers** below — some lenders run only one program, some both. |
| `status` | approved · declined · pending · submitted. "Funded"/"Used" ⇒ approved + a funding record; "Withdrawn"/"Expired"/"Cancelled" ⇒ submitted (top of funnel only) |
| `submitted_date`, `decision_date` | ISO or US formats. Decision date defaults to submitted date for decisioned rows |
| `requested_amount`, `approved_amount` | currency strings accepted (`$1,234.50`) |
| `decline_reason` | kept only for declined rows |
| `funded_date`, `funded_amount` | either one ⇒ funding record; amount defaults to approved amount; utilization % = funded / approved |
| `location` | practice/office name → `locations` (exact, else unique substring match) |
| `patient_id` / `chart_no` / `patient_first_name` / `patient_last_name` / `patient_dob` | patient matching (below) |

## Tiers: prime, subprime, or both

Lenders differ: some are prime-only (a traditional credit card program), some are
subprime-only (second-look / in-house programs), and some run **both** — for those, the
same lender can approve one patient under prime and another under a second-look program.
So a fixed tier per lender is wrong. The rule, per application:

1. If the export states the tier (a Program / Tier / Product column), that's the tier
   (`application_type_source = 'file'`). If it contradicts the lender configuration
   (a "subprime" row for a prime-only lender) the row is kept as stated and flagged.
2. Else, if the lender runs exactly one program, that program (`lender_only_tier`).
3. Else the tier is **unknown** (`NULL`, `source = 'unknown'`): the row imports and
   counts everywhere except under the Prime vs SubPrime filter; the import result says
   once, per lender, how many rows this affected; the data-quality report lists them.

A later file that states the tier fills it in; a later silent file never clears it.

The configuration lives in the `lenders` table (`GET /api/lenders`, `PUT /api/lenders/:code`)
with these starting values — **to be confirmed by whoever runs the applications**:

| Lender | Programs | Starting value based on |
|---|---|---|
| CareCredit | prime | Synchrony card program |
| Alphaeon | prime | Comenity card program |
| Cherry | prime + subprime | multiple lending partners |
| Proceed | prime + subprime | broad-approval positioning |
| Sunbit | prime + subprime | near-prime focus, but both |
| HFD | subprime | in-house / no-credit-check style |
| Covered Care | subprime | second-look |
| Fortiva | subprime | second-look |
| Access, Eve | prime + subprime | unknown — set to both so nothing is guessed |

After changing a lender's programs, `POST /api/lenders/:code/retier` re-derives the tier of
that lender's applications whose tier didn't come from a file; file-stated tiers are never
touched. The SQL `lender` enum still defines which codes exist — adding a brand-new lender
is a migration plus a `lenders` row.

## Patient matching

Lender exports identify people by name and date of birth. Matching ladder, first hit wins:

1. `patient_id` = Denticon patient id
2. `chart_no` (unique hit only)
3. last name + DOB; if several, first-name initial breaks the tie; still several ⇒ **ambiguous**
4. first + last name with no DOB — unique hit only

Unmatched/ambiguous applications are still imported and **still count in the funnel's
financing stages** (they carry their own location from the file); they just can't be
filtered by provider or flagged as new-patient. They're listed on the Import page and
retried automatically after every Denticon sync (`rematchUnmatchedApplications`), or via
*Retry matching* / `POST /api/finance/rematch`. The Denticon sync populates
`patients.first_name/last_name/birth_date/chart_no` for this purpose.

## Validation, duplicates and warnings

Every row ends up in exactly one bucket, and the import result / history says which:

| Outcome | Meaning | Examples |
|---|---|---|
| **rejected** | not usable; nothing written for this row, the rest of the file still imports | unknown lender or status, unparseable date, amount that isn't a number or is ≥ $10M (would overflow the column), negative amount, no identifier at all (no id, chart no, or name) |
| **duplicate** | same application appears earlier in the *same* file — first occurrence kept | same application id twice; same lender + patient + date twice when there's no id |
| **updated** | the application was already on file from an earlier import and was refreshed | re-uploading last month's export with new statuses |
| **inserted** | new application | |

On top of that, a row can carry **warnings** — it was imported, but something looks off:
contradictory status (declined but a funded amount ⇒ treated as funded), decision or
funded date before the submitted date, dates in the future, funded > approved, unknown
prime/subprime value (treated as not stated — may leave the tier unknown), impossible DOB (ignored for matching),
day-first dates that were auto-detected (31/12/2025), a blank submitted date (another date
is used, or the row is flagged as invisible to date filters), and **possible duplicates
across files** — same patient, lender and submitted date under a different reference id
(imported, but `possible_duplicate_of` is set and it's listed in the data-quality report).

File-level **notes** say once what the whole file lacks (no DOB column, no amount column,
no application id, no location…) instead of repeating it per row. Repeated header names
are kept apart as `Amount`, `Amount (2)`.

### Data-quality report

`GET /api/data-quality` (shown on the Import page) runs a fixed set of SQL checks over
the whole warehouse and lists counts + examples: possible duplicate patient charts (same
name + DOB, different Denticon ids), possible duplicate applications, duplicate location
names, unlinked applications, applications with no submitted date, approved with no
amount, funded > approved, decided before submitted, patients missing location/provider/
first visit, plans missing fee/date, and Denticon staging rows still waiting. Adding a
check is one entry in `backend/src/routes/dataQuality.ts`.

### Tests

`npm test` covers the parser, header mapping, and every normaliser rule above with
hostile inputs. `npm run test:db` additionally runs the import service, matching, funnel
queries and the Denticon sync job against a throwaway schema (`dental_test`) inside the
dev database — duplicates within and across files, accent/punctuation-insensitive
matching, ambiguous charts, one-bad-row-doesn't-sink-the-file, rematch after a sync, a
3,000-row file, a forbidden office, and id-less upstream records.

## Multi-lender applications ("multi-app") and cases

The practice often shops one treatment to several lenders at once: a soft check at two or
three lenders the same day, then the patient picks one of the approvals to use. Counting
application rows makes that look like waste (3 submitted, 2 approved, 1 funded = "two
approvals lost"), so the funnel counts **cases** instead.

**A case** = one patient's round of applications for one treatment. Rows join a case when:

1. the export carries a request/multi-app id (`case_id` column; aliases: "Request ID",
   "Multi-App ID", "Prequal ID"…) — rows with the same id are one case, whatever the dates; else
2. the same patient (or, while unmatched, the same applicant name + DOB) submitted within
   **`FINANCING_CASE_WINDOW_DAYS`** (default 14) of the case's opened date; else
3. a new case is opened.

A case's outcome is derived, never stored (`financing_case_summary` view):
`funded` if any application funded → `approved` if any approved → `pending` → `declined`
only if *all* declined → else `submitted`. `chosen_lender` is the funded one.

**Soft vs hard**: `inquiry_type` per application from an "Inquiry Type"/"Soft Pull"
column, or inferred from wording ("Prequalified", "Pre-approved", "Pre-declined" ⇒ soft).

What this changes:
- **Funnel**: *Financing requested → Approved by a lender → Funded* count cases opened in
  the range. The response also carries `financing: { cases, applications,
  multiLenderCases, avgLendersPerCase }` so the raw row count is never hidden.
- **Lender charts** (applications by lender, approval rate) still count every
  application — each lender did decide on its own application.
- **New multi-lender block** (`multiLender` in `/api/finance/summary`, card on the
  dashboard): share of cases that went to 2+ lenders, cases where the patient had a
  choice (2+ approvals), and *win rate* — among cases with several approvals, how often
  each approving lender was the one the patient used.
- `GET /api/finance/cases` lists cases with their applications for review;
  `POST /api/finance/cases/rebuild` regroups everything (run after changing the window
  or when upgrading a database that predates cases). Matching an application to a patient
  later automatically moves it into that patient's case.
- Data quality adds "cases funded through more than one lender" (window too wide, or two
  treatments) and "applications not grouped into a case".

Assumptions to confirm with real files: the 14-day window (a second treatment within two
weeks would be merged), and whether portals export a request id at all.

## Where it lands

`staging_financing_csv` (every row, raw + normalised + outcome, keyed to a
`financing_import_batches` row) → `financing_applications` (one per application) →
`fundings` (one per funded application). Funnel stages: applications submitted in the
date range, of which approved, of which funded — same date basis so the funnel is
monotonic. Finance report: applications by lender, approval rate = approved ÷
(approved + declined).

## Sample file

`docs/samples/financing/sample-lender-export.csv` (`npm run financing:sample`) — 114
rows across 8 lenders whose applicants are the Denticon **mock** patients, with portal-style
headers, two applicants missing from the PMS and one bad status. Import it after a mock
sync to see the complete funnel.

## Next steps

- Real lender file: paste its headers into `HEADER_ALIASES` if anything shows as
  *ignored* in the import result, and confirm which programs each lender runs (`lenders` table, § Tiers).
- Auth: the import endpoints write data and are unauthenticated until Auth0 is wired in.
- Lender APIs (CareCredit/Sunbit have partner APIs) can feed `NormalizedApplication`
  records straight into `upsertApplication` — the CSV layer is just one producer.
