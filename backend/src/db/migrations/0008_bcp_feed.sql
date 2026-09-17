-- Landing zone for the Denticon "Data Download" (BCP) feed: the scheduled full-database
-- export PlanetDDS produces under Utilities → Denticon Download. One flat file per SQL
-- table, so staging is generic (table name + raw row as JSON) rather than one table per
-- entity. Rows are deduplicated by content hash: a nightly full dump only lands rows that
-- are new or changed, and rows that stop appearing are the source's deletes.
-- See docs/denticon-bcp.md.

CREATE TABLE bcp_loads (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL,                 -- zip path / folder / inbox file name
  file_name       TEXT,
  file_size       BIGINT,
  file_mtime      TIMESTAMPTZ,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running', -- running | ok | error
  error           TEXT,
  -- Per-file summary: [{table, file, delimiter, header, columns, rows, inserted, unchanged,
  --                     adapter, promoted, problems: []}]
  tables          JSONB NOT NULL DEFAULT '[]'::jsonb
);
-- The inbox watcher uses this to recognise a zip it has already loaded.
CREATE INDEX ix_bcp_loads_file ON bcp_loads (file_name, file_size, file_mtime);

CREATE TABLE staging_bcp_rows (
  id                 BIGSERIAL PRIMARY KEY,
  table_name         TEXT NOT NULL,              -- normalised from the file name (lower snake)
  row_hash           TEXT NOT NULL,              -- sha1 of the raw line
  raw                JSONB NOT NULL,             -- {column: value} (col_1.. when headerless)
  first_seen_load_id BIGINT NOT NULL REFERENCES bcp_loads(id),
  last_seen_load_id  BIGINT NOT NULL REFERENCES bcp_loads(id),
  processed_at       TIMESTAMPTZ,
  UNIQUE (table_name, row_hash)
);
CREATE INDEX ix_staging_bcp_rows_unprocessed ON staging_bcp_rows (table_name) WHERE processed_at IS NULL;
CREATE INDEX ix_staging_bcp_rows_last_seen ON staging_bcp_rows (table_name, last_seen_load_id);

-- BCP rows are promoted through the same staging → core path as the REST sync, so the
-- staging_denticon_* rows need to say where they came from.
ALTER TABLE staging_denticon_patients ADD COLUMN source TEXT NOT NULL DEFAULT 'api';
ALTER TABLE staging_denticon_treatment_plans ADD COLUMN source TEXT NOT NULL DEFAULT 'api';
