-- Import quality: per-batch warnings and duplicate counts, plus normalised name keys on
-- patients so lender-file matching survives accents, hyphens, apostrophes and case
-- ("Muñoz-O'Brien" and "MUNOZ OBRIEN" both key to "munozobrien").

ALTER TABLE financing_import_batches
  ADD COLUMN duplicates INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN warnings   JSONB   NOT NULL DEFAULT '[]'::jsonb; -- [{row, message}]

ALTER TABLE patients
  ADD COLUMN last_name_key  TEXT,
  ADD COLUMN first_name_key TEXT;
-- Best-effort backfill (no accent folding in plain SQL); the next Denticon sync rewrites
-- these from the JS normaliser.
UPDATE patients SET
  last_name_key  = regexp_replace(lower(coalesce(last_name, '')),  '[^a-z]', '', 'g'),
  first_name_key = regexp_replace(lower(coalesce(first_name, '')), '[^a-z]', '', 'g');
DROP INDEX IF EXISTS idx_patients_match;
CREATE INDEX idx_patients_match ON patients (last_name_key, birth_date);

-- Flag applications the importer thinks may be the same as an existing one.
ALTER TABLE financing_applications
  ADD COLUMN possible_duplicate_of BIGINT REFERENCES financing_applications(id);
