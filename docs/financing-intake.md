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
| `application_type` | prime / subprime. Defaults per lender when absent (prime: CareCredit, Alphaeon, Cherry, Proceed, Eve; subprime: HFD, Covered Care, Sunbit, Fortiva, Access — an assumption, override per file) |
| `status` | approved · declined · pending · submitted. "Funded"/"Used" ⇒ approved + a funding record; "Withdrawn"/"Expired"/"Cancelled" ⇒ submitted (top of funnel only) |
| `submitted_date`, `decision_date` | ISO or US formats. Decision date defaults to submitted date for decisioned rows |
| `requested_amount`, `approved_amount` | currency strings accepted (`$1,234.50`) |
| `decline_reason` | kept only for declined rows |
| `funded_date`, `funded_amount` | either one ⇒ funding record; amount defaults to approved amount; utilization % = funded / approved |
| `location` | practice/office name → `locations` (exact, else unique substring match) |
| `patient_id` / `chart_no` / `patient_first_name` / `patient_last_name` / `patient_dob` | patient matching (below) |

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
  *ignored* in the import result, and confirm the prime/subprime default per lender.
- Auth: the import endpoints write data and are unauthenticated until Auth0 is wired in.
- Lender APIs (CareCredit/Sunbit have partner APIs) can feed `NormalizedApplication`
  records straight into `upsertApplication` — the CSV layer is just one producer.
