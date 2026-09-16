-- Financing CSV intake. Lender exports identify patients by name + DOB (sometimes a chart
-- number), never by our ids, and name the practice location as text — so applications
-- carry their own location and an explicit match status, and patients get the columns
-- needed to match on. See docs/financing-intake.md.

-- One row per uploaded file; the intake response and the import-history page read this.
CREATE TABLE financing_import_batches (
  id            BIGSERIAL PRIMARY KEY,
  source_file   TEXT NOT NULL,
  imported_by   TEXT,
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count     INTEGER NOT NULL DEFAULT 0,
  inserted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  unmatched     INTEGER NOT NULL DEFAULT 0,
  rejected      INTEGER NOT NULL DEFAULT 0,
  errors        JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{row, message}]
  column_map    JSONB                              -- header → canonical column, for audit
);

ALTER TABLE staging_financing_csv
  ADD COLUMN batch_id   BIGINT REFERENCES financing_import_batches(id),
  ADD COLUMN row_number INTEGER,
  ADD COLUMN normalized JSONB,      -- the row after header mapping + value normalisation
  ADD COLUMN outcome    TEXT,       -- 'inserted' | 'updated' | 'unmatched' | 'rejected'
  ADD COLUMN outcome_detail TEXT;

-- Patient matching inputs (populated from Denticon by the sync's processing step).
ALTER TABLE patients
  ADD COLUMN first_name TEXT,
  ADD COLUMN last_name  TEXT,
  ADD COLUMN birth_date DATE,
  ADD COLUMN chart_no   TEXT;
CREATE INDEX idx_patients_match ON patients (lower(last_name), birth_date);
CREATE INDEX idx_patients_chart_no ON patients (chart_no);

ALTER TABLE financing_applications
  ALTER COLUMN patient_id DROP NOT NULL,
  ADD COLUMN location_id   BIGINT REFERENCES locations(id),
  ADD COLUMN external_id   TEXT,                      -- lender's application/reference id
  -- Upsert key: "<lender>:<external_id>" when the lender supplies an id, otherwise a
  -- composite of lender + patient identifiers + submitted date (see columns.ts).
  ADD COLUMN dedupe_key    TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  ADD COLUMN match_status  TEXT NOT NULL DEFAULT 'unmatched', -- 'matched' | 'unmatched' | 'ambiguous'
  ADD COLUMN match_detail  TEXT,
  ADD COLUMN requested_amount NUMERIC(12, 2),
  ADD COLUMN staging_row_id BIGINT REFERENCES staging_financing_csv(id),
  ADD COLUMN updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX idx_financing_applications_external ON financing_applications (lender, external_id);
CREATE INDEX idx_financing_applications_location ON financing_applications (location_id);
CREATE INDEX idx_financing_applications_submitted ON financing_applications (submitted_date);

-- One funding record per application, so intake can upsert.
CREATE UNIQUE INDEX uq_fundings_application ON fundings (application_id);
