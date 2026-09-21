-- Decision (2026-09-21): a "new patient" is someone who has COMPLETED a first visit.
-- A booked appointment isn't enough — no-shows never become patients — so the flag is
-- derived from first_visit_date and nothing else. Making it a generated column means no
-- feed (REST sync, BCP loader, seed) can set it inconsistently; if the definition ever
-- changes, swap the expression here in a new migration.
--
-- "New in a period" (the New Patients tiles, the Patient Type = New Patients toggle) is
-- first_visit_date within the report's date range — see financeService.ts.

ALTER TABLE patients DROP COLUMN new_patient_flag;
ALTER TABLE patients
  ADD COLUMN new_patient_flag BOOLEAN GENERATED ALWAYS AS (first_visit_date IS NOT NULL) STORED;
COMMENT ON COLUMN patients.new_patient_flag IS
  'Derived: has completed a first visit (first_visit_date IS NOT NULL). Scheduled/no-show patients are false.';
CREATE INDEX idx_patients_first_visit ON patients (first_visit_date);
