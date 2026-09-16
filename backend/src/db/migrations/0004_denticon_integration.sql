-- Wires the core tables to Denticon identifiers so the ETL can upsert idempotently, and
-- adds a watermark table so incremental syncs only ask Denticon for what changed.
-- See docs/denticon-api.md.

ALTER TABLE locations ADD COLUMN denticon_office_id INTEGER UNIQUE;
ALTER TABLE providers ADD COLUMN denticon_provider_id INTEGER UNIQUE;
ALTER TABLE providers ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;

-- Denticon's treatment-plan endpoint is item-level (one row per procedure); the ETL rolls
-- items up to one row per plan, keyed on treatPlanId.
ALTER TABLE treatment_plans ADD COLUMN denticon_treat_plan_id INTEGER UNIQUE;
ALTER TABLE treatment_plans ADD COLUMN accepted_date DATE;
ALTER TABLE treatment_plans ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE patients ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE patients ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;

-- Staging: dedupe key so re-running a window (Denticon's ranges are inclusive on both
-- ends) doesn't pile up duplicate raw rows, and the plan id for the treatment-plan feed.
ALTER TABLE staging_denticon_patients
  ADD COLUMN last_changed_on TIMESTAMPTZ,
  ADD COLUMN office_id INTEGER;
CREATE UNIQUE INDEX uq_staging_denticon_patients_pid
  ON staging_denticon_patients (denticon_patient_id);

ALTER TABLE staging_denticon_treatment_plans
  ADD COLUMN denticon_treat_plan_id INTEGER,
  ADD COLUMN last_changed_on TIMESTAMPTZ,
  ADD COLUMN office_id INTEGER;
-- One staging row per plan holding all of its item rows as a JSON array.
CREATE UNIQUE INDEX uq_staging_denticon_treatment_plans_tpid
  ON staging_denticon_treatment_plans (denticon_treat_plan_id);

-- One row per (entity, office): the LastChangedOn high-water mark reached so far, plus
-- the last run's outcome for the /api/denticon/status endpoint.
CREATE TABLE denticon_sync_state (
  entity            TEXT NOT NULL,      -- 'patients' | 'treatment_plans' | 'reference'
  office_id         INTEGER NOT NULL DEFAULT 0, -- 0 = practice-group wide
  watermark         TIMESTAMPTZ,
  last_run_at       TIMESTAMPTZ,
  last_run_status   TEXT,               -- 'ok' | 'error'
  last_run_error    TEXT,
  last_run_rows     INTEGER,
  PRIMARY KEY (entity, office_id)
);
