-- Financing cases: one patient's round of applications for one treatment. Practices
-- often "multi-app" — soft-check several lenders at once, collect the approvals, and let
-- the patient pick one — so counting rows makes the funnel look like it loses every
-- approval that wasn't chosen. The funnel counts cases; lender charts keep counting the
-- individual applications underneath. See docs/financing-intake.md § Multi-lender.

CREATE TABLE financing_cases (
  id            BIGSERIAL PRIMARY KEY,
  -- Grouping identity: the matched patient, or (for still-unmatched rows) the applicant's
  -- name key + DOB from the file, so the same person's rows still group together.
  patient_id    BIGINT REFERENCES patients(id),
  case_key      TEXT NOT NULL,
  -- Explicit id from the export ("Request ID", "Multi-App ID"), when the lender/portal has one.
  external_case_id TEXT,
  location_id   BIGINT REFERENCES locations(id),
  treatment_plan_id BIGINT REFERENCES treatment_plans(id),
  opened_date   DATE,          -- earliest submitted date across the case's applications
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_financing_cases_key_date ON financing_cases (case_key, opened_date);
CREATE UNIQUE INDEX uq_financing_cases_external ON financing_cases (case_key, external_case_id) WHERE external_case_id IS NOT NULL;

ALTER TABLE financing_applications
  ADD COLUMN case_id BIGINT REFERENCES financing_cases(id),
  -- 'soft' = prequalification / soft credit pull (no credit impact, typical for multi-app),
  -- 'hard' = full application. NULL when the export doesn't say.
  ADD COLUMN inquiry_type TEXT CHECK (inquiry_type IN ('soft', 'hard'));
CREATE INDEX idx_financing_applications_case ON financing_applications (case_id);

-- Derived, always-consistent view of each case's outcome. Funnel and reports read this.
CREATE VIEW financing_case_summary AS
SELECT c.id AS case_id,
       c.patient_id,
       c.case_key,
       COALESCE(c.location_id, p.location_id) AS location_id,
       p.provider_id,
       c.opened_date,
       count(fa.id)                                            AS applications,
       count(DISTINCT fa.lender)                               AS lenders,
       count(fa.id) FILTER (WHERE fa.status = 'approved')      AS approvals,
       count(fa.id) FILTER (WHERE fa.status = 'declined')      AS declines,
       count(fa.id) FILTER (WHERE fa.status = 'pending')       AS pending,
       count(f.id) > 0                                         AS funded,
       max(f.funded_date)                                      AS funded_date,
       sum(f.funded_amount)                                    AS funded_amount,
       max(fa.approved_amount)                                 AS best_approved_amount,
       max(fa.requested_amount)                                AS requested_amount,
       -- The lender the patient actually used (funded), else NULL.
       (array_agg(fa.lender ORDER BY f.funded_date NULLS LAST, fa.id) FILTER (WHERE f.id IS NOT NULL))[1] AS chosen_lender,
       CASE
         WHEN count(f.id) > 0 THEN 'funded'
         WHEN count(fa.id) FILTER (WHERE fa.status = 'approved') > 0 THEN 'approved'
         WHEN count(fa.id) FILTER (WHERE fa.status = 'pending') > 0 THEN 'pending'
         WHEN count(fa.id) FILTER (WHERE fa.status = 'declined') = count(fa.id) THEN 'declined'
         ELSE 'submitted'
       END AS outcome
  FROM financing_cases c
  LEFT JOIN patients p ON p.id = c.patient_id
  JOIN financing_applications fa ON fa.case_id = c.id
  LEFT JOIN fundings f ON f.application_id = fa.id
 GROUP BY c.id, c.patient_id, c.case_key, c.location_id, p.location_id, p.provider_id, c.opened_date;
