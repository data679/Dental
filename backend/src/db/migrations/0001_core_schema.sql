-- Core schema for the patient-to-financing funnel.
-- Field list follows docs/data-model.md; several open questions there (new-patient
-- definition, status granularity) may still change this — treat as a first pass.

CREATE TABLE locations (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE providers (
  id            BIGSERIAL PRIMARY KEY,
  location_id   BIGINT NOT NULL REFERENCES locations(id),
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE patients (
  id                BIGSERIAL PRIMARY KEY,
  denticon_patient_id TEXT UNIQUE, -- source-of-truth id from the PMS, once wired up
  location_id       BIGINT REFERENCES locations(id),
  provider_id       BIGINT REFERENCES providers(id),
  source            TEXT,        -- marketing channel
  new_patient_flag  BOOLEAN NOT NULL DEFAULT true,
  first_visit_date  DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_patients_location ON patients(location_id);
CREATE INDEX idx_patients_provider ON patients(provider_id);

CREATE TYPE treatment_plan_status AS ENUM ('presented', 'accepted', 'declined');

CREATE TABLE treatment_plans (
  id              BIGSERIAL PRIMARY KEY,
  patient_id      BIGINT NOT NULL REFERENCES patients(id),
  procedure_code  TEXT,
  proposed_fee    NUMERIC(12, 2),
  status          treatment_plan_status NOT NULL DEFAULT 'presented',
  presented_date  DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_treatment_plans_patient ON treatment_plans(patient_id);

CREATE TYPE lender AS ENUM (
  'hfd', 'alphaeon', 'cherry', 'care_credit', 'proceed', 'covered_care', 'eve', 'sunbit'
);

CREATE TYPE application_type AS ENUM ('primary', 'subprime');

-- Open question in docs/data-model.md: does this need "in_review" / "expired" too?
CREATE TYPE application_status AS ENUM ('submitted', 'pending', 'approved', 'declined');

CREATE TABLE financing_applications (
  id                BIGSERIAL PRIMARY KEY,
  patient_id        BIGINT NOT NULL REFERENCES patients(id),
  treatment_plan_id BIGINT REFERENCES treatment_plans(id),
  lender            lender NOT NULL,
  application_type  application_type NOT NULL,
  status            application_status NOT NULL DEFAULT 'submitted',
  submitted_date    DATE,
  decision_date     DATE,
  approved_amount   NUMERIC(12, 2),
  decline_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_financing_applications_patient ON financing_applications(patient_id);
CREATE INDEX idx_financing_applications_status ON financing_applications(status);
CREATE INDEX idx_financing_applications_lender ON financing_applications(lender);

CREATE TABLE fundings (
  id                        BIGSERIAL PRIMARY KEY,
  application_id            BIGINT NOT NULL REFERENCES financing_applications(id),
  funded_date               DATE,
  funded_amount             NUMERIC(12, 2),
  utilization_pct           NUMERIC(5, 2), -- funded_amount / approved_amount * 100
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fundings_application ON fundings(application_id);

CREATE TABLE treatment_completions (
  id                BIGSERIAL PRIMARY KEY,
  treatment_plan_id BIGINT NOT NULL REFERENCES treatment_plans(id),
  completed_date    DATE,
  case_value        NUMERIC(12, 2),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_treatment_completions_plan ON treatment_completions(treatment_plan_id);
