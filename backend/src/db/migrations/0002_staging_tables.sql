-- Staging tables for raw ETL intake, kept separate from the core schema so a bad sync or
-- CSV batch never corrupts curated data. Job/ETL layer (BullMQ) reads from here and
-- upserts into the core tables; see backend/src/etl.
--
-- These are intentionally loose (mostly TEXT) since source data shapes aren't fully known
-- yet (see docs/data-model.md open questions).

CREATE TABLE staging_denticon_patients (
  id                BIGSERIAL PRIMARY KEY,
  raw               JSONB NOT NULL,
  denticon_patient_id TEXT,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);

CREATE TABLE staging_denticon_treatment_plans (
  id                BIGSERIAL PRIMARY KEY,
  raw               JSONB NOT NULL,
  denticon_patient_id TEXT,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);

-- Manual CSV intake for financing application data (submitted/approved/declined/funded by
-- lender) until a direct lender or Denticon financing integration exists.
CREATE TABLE staging_financing_csv (
  id                BIGSERIAL PRIMARY KEY,
  raw               JSONB NOT NULL,        -- one row of the uploaded CSV, as JSON
  source_file       TEXT,
  imported_by       TEXT,
  imported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);
