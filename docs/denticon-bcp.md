# Denticon data download (BCP) feed

Denticon can produce a bulk export of the practice group's whole database: **Utilities →
Denticon Download** in the Denticon UI ("BCP downloads" in PlanetDDS's wording — SQL
Server's Bulk Copy Program). Our practice group already receives this as a **scheduled
feed**, which makes it the fastest route to real data: no API subscription key, no 30-day
filter cap, no rate limits, and every table, not just the ones the REST API exposes.

This document covers what the feed is, how the loader treats it, and what to do when the
first real download arrives. The REST API integration ([denticon-api.md](denticon-api.md))
stays in place; both land in the same staging tables and the dashboard doesn't know which
one fed it.

## What PlanetDDS delivers

From the PlanetDDS support articles ("How can we obtain a data download?", "What is our
password to extract the data?", "How are we able to understand the various fields in the
Data Download?"):

- Requested under Utilities → Denticon Download for the signed-in PGID; the file is ready
  the next day and picked up from the same page. Ours is set up as a recurring schedule.
- A `.zip`, AES-128 encrypted. **The password is the requesting user's Denticon password**
  (case-sensitive). Consequence: the feed breaks when that person changes their password
  or leaves. Ask for the requester to be a dedicated service user.
- Contents: "raw programming data" — one flat file per SQL table (treatments,
  appointments, patient history, …), not a rendering of what users see in Denticon. A
  data dictionary describing the fields is available from PlanetDDS support.

What we **don't** know until the first file: file names, delimiter (bcp's default is TAB;
exports are often configured with `|`), whether there's a header row or a `.fmt`/`.xml`
format file, encoding (bcp `-c` is the Windows code page; `-w` is UTF-16), and column
names. Everything in the loader is therefore detected and reported rather than assumed.

## Loader design

```
download.zip ─7z─▶ flat files ─detect─▶ staging_bcp_rows ─adapters─▶ staging_denticon_* ─▶ core tables
                                  (table_name, sha1, raw JSON)     (same path as the REST sync)
```

1. **Extract** (`etl/bcp/archive.ts`): `7z x -p<password>`; needs p7zip on the host
   (`SEVEN_ZIP_BIN` to point elsewhere). A folder of already-extracted files works too.
2. **Detect** (`etl/bcp/delimited.ts`): encoding (BOM / BOM-less UTF-16 / invalid UTF-8 →
   latin1), delimiter (most consistent field count across the first lines), header row
   (identifier-looking first line vs. data-looking rest), column names in this order:
   `bcp-feed.json` → sibling `.fmt`/`.xml` format file → header row → `col_1..col_n`.
   Rows are streamed, never loaded whole.
3. **Land** (`etl/bcp/loadService.ts`): every line becomes a `staging_bcp_rows` row keyed
   on `(table_name, sha1(line))`. Re-loading the same dump inserts nothing; the next
   day's dump inserts only new/changed lines and bumps `last_seen_load_id` on the rest.
   Rows whose `last_seen_load_id` is not the latest load are the source's deletes. Every
   load is recorded in `bcp_loads` with a per-table summary (delimiter, columns, adapter,
   counts, why a table was not promoted).
4. **Promote** (`etl/bcp/promote.ts`): tables an adapter recognises are converted into
   the REST API's shapes (`DenticonPatient`, `DenticonTreatmentPlanItem`) and upserted
   into `staging_denticon_patients` / `staging_denticon_treatment_plans` with
   `source = 'bcp'`, then the existing `processDenticonStaging` runs — so status
   mapping, plan roll-up, patient matching for lender rows and case grouping are shared.
   Offices → `locations`, providers → `providers`, referral types → source descriptions.
   Plan header and item tables are joined on plan id; a header-only export still yields
   one plan per header row.
5. **Unrecognised tables** (ledger, claims, appointments, …) are landed and kept raw.
   They show up in the load summary, `GET /api/bcp/status`, and the data-quality check
   "BCP tables landed but not promoted". Adding an adapter (`etl/bcp/tables.ts`) later
   promotes their history too, since the rows are already there.

Parity is tested: the same mock dataset through the REST mock and through BCP files
yields identical core rows (`etl/bcp/__tests__/parity.db.test.ts`).

## Adapters and `bcp-feed.json`

`etl/bcp/tables.ts` lists the tables we promote (`offices`, `providers`,
`referral_types`, `patients`, `treatment_plans`, `treatment_plan_items`) with, per
column, a list of plausible names (API field names, SQL-style, abbreviations). Matching is
case- and punctuation-insensitive (`Pat_ID` = `patid` = `PatientId`). A table is promoted
only when every *required* column resolves; otherwise the report says exactly what's
missing.

Anything the aliases don't cover goes in `backend/bcp-feed.json` (or the file named by
`DENTICON_BCP_CONFIG`) — no code change:

```json
{
  "delimiter": "|",
  "tables": {
    "patient_master": {
      "entity": "patients",
      "columns": ["PATID", "OFCID", "CHARTNO", "LNAME", "FNAME", "DOB", "SEX", "ACTIVE",
                  "FIRSTVISIT", "LASTVISIT", "REFTYPE", "PROVID", "MODDATE"],
      "map": { "preferredProviderId": "PROVID" }
    },
    "audit_log": { "ignore": true }
  }
}
```

- `columns`: names for a headerless file with no format file (from the data dictionary).
- `map`: adapter key → column name, when an alias doesn't fit.
- `entity`: force an adapter when the file name doesn't match (`weird_export_01`).
- `ignore`: skip a file entirely (blobs, audit logs).
- Table keys are the normalised name (`dbo_PatientMaster.txt` → `patient_master`) or the
  exact file name.

`bcp-feed.json` is gitignored: it describes *this* practice group's export and a wrong
`columns` list applied to a real file would mis-map silently. A sample that matches the
synthetic download is at `docs/samples/denticon-bcp-feed.example.json`.

## When the first real download arrives

1. Put the zip somewhere on the server and set `DENTICON_BCP_PASSWORD` in `backend/.env`.
2. `npm run bcp:inspect -- /path/to/download.zip --rows 5` — no database. Read the
   per-file report: delimiter/encoding/header, columns found, adapter, missing required
   columns, sample rows. Compare against the data dictionary.
3. Fill `backend/bcp-feed.json` until every table you care about says "✓ will be
   promoted". Re-run inspect.
4. `npm run bcp:load -- /path/to/download.zip` — loads, promotes, prints the summary.
   Check the dashboard and `GET /api/data-quality`.
5. For the schedule: set `DENTICON_BCP_INBOX` to the folder the feed drops into, run the
   worker (`npm run worker`); it sweeps the folder every `DENTICON_BCP_CRON` (default every
   30 min) and loads any zip it hasn't loaded successfully yet (by name+size+mtime).
   Files modified in the last minute are left alone in case they're still being written.

## Operations

| What | Where |
| --- | --- |
| Feed health (last load, last error, inbox backlog, staging volume) | `GET /api/bcp/status`, Import page panel |
| Load history / one load's per-table detail | `GET /api/bcp/loads`, `GET /api/bcp/loads/:id` |
| Trigger a load via the worker | `POST /api/bcp/load {"source": "/path/x.zip"}` (omit source = sweep inbox) |
| Load in-process (no worker) | `npm run bcp:load -- <zip or folder> [--skip-promote] [--only patient_master,office]` |
| Inspect without touching the DB | `npm run bcp:inspect -- <zip or folder> [--rows N] [--json]` |
| Synthetic download for testing | `npm run bcp:sample -- --zip` → `docs/samples/denticon-bcp{,.zip}` (zip password `sample`) |
| Data-quality checks | `bcp_feed_stale` (no good load in `DENTICON_BCP_STALE_DAYS`), `bcp_failed_loads`, `bcp_unmapped_tables` |

Failure behaviour: a wrong password or unreadable archive records an `error` load and
promotes nothing. A table that can't be parsed into columns is still landed (as
`col_n`) and reported, not skipped. A promoted row with no usable id is counted as
skipped and marked processed so it doesn't block the next run. The load's own error text
never includes the password.

## Environment

| Variable | Meaning |
| --- | --- |
| `DENTICON_BCP_PASSWORD` | Zip password (= requesting user's Denticon password). Keep in `.env` only. |
| `DENTICON_BCP_INBOX` | Folder the worker polls for new zips. Empty = manual loads only. |
| `DENTICON_BCP_CONFIG` | Path to `bcp-feed.json` (default `backend/bcp-feed.json` if present). |
| `DENTICON_BCP_CRON` | Inbox sweep schedule (default `*/30 * * * *`). |
| `DENTICON_BCP_STALE_DAYS` | Data-quality warning threshold (default 2). |
| `SEVEN_ZIP_BIN` | Path to `7z` if not on PATH. |

## Open questions for PlanetDDS / the current recipient

- Exact table list and the data dictionary for this PGID's download.
- Delimiter, header/format-file convention, encoding.
- Cadence (nightly? weekly?) and whether each drop is a full dump (assumed) or a delta.
- Where the scheduled file lands today and who the requesting user is; move it to a
  service account.
- Whether datetimes are UTC (the REST API's are; the loader assumes zone-less values are).
