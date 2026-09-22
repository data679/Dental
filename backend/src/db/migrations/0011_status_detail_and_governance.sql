-- Two decisions being made explicit before real rows land.
--
-- 1. STATUS GRANULARITY (open question 2 in docs/data-model.md). The coarse
--    application_status enum stays — the Finance Report is built on it — but folding
--    withdrawn / expired / cancelled into 'submitted' loses the difference between
--    "the lender hasn't answered yet" and "this application died". Both look like an
--    undecided application; only one is worth chasing. So each application now also
--    keeps the lender's own wording and a normalised sub-state, and an outcome class
--    derived from it:
--        open      — still live, awaiting a decision
--        decided   — approved or declined
--        abandoned — withdrawn, cancelled, expired, or never completed
--
-- 2. EXPORT GOVERNANCE. Who pulls each lender's export and how often, so a feed that
--    stops arriving is visible instead of silently ageing (see /api/finance/governance).

ALTER TABLE financing_applications
  ADD COLUMN status_raw    TEXT,   -- verbatim from the export, for audit and re-mapping
  ADD COLUMN status_detail TEXT,
  ADD CONSTRAINT financing_applications_status_detail_check CHECK (status_detail IN (
    'submitted', 'incomplete', 'withdrawn', 'cancelled', 'expired',
    'in_review', 'referred',
    'prequalified', 'approved', 'conditionally_approved',
    'pre_declined', 'declined'
  ));

-- Derived so it can never disagree with the sub-state.
ALTER TABLE financing_applications
  ADD COLUMN outcome_class TEXT GENERATED ALWAYS AS (
    CASE
      WHEN status_detail IN ('withdrawn', 'cancelled', 'expired', 'incomplete') THEN 'abandoned'
      WHEN status_detail IN ('approved', 'conditionally_approved', 'prequalified', 'declined', 'pre_declined') THEN 'decided'
      WHEN status_detail IS NULL THEN NULL
      ELSE 'open'
    END
  ) STORED;
CREATE INDEX idx_financing_applications_outcome ON financing_applications (outcome_class);

-- Rows imported before this migration: infer what can be inferred from the coarse status.
-- 'submitted' is deliberately left NULL rather than guessed — it may have been any of the
-- four sub-states, and re-importing those files fills it in properly.
UPDATE financing_applications
   SET status_detail = CASE status WHEN 'approved' THEN 'approved' WHEN 'declined' THEN 'declined'
                                   WHEN 'pending' THEN 'in_review' ELSE NULL END
 WHERE status_detail IS NULL;

-- Export governance + how each lender's tier classification was arrived at.
ALTER TABLE lenders
  ADD COLUMN export_owner   TEXT,
  ADD COLUMN export_cadence TEXT NOT NULL DEFAULT 'unset'
    CHECK (export_cadence IN ('unset', 'weekly', 'biweekly', 'monthly', 'quarterly', 'on_request', 'none')),
  -- Grace added to the cadence before a feed counts as overdue.
  ADD COLUMN export_grace_days INTEGER NOT NULL DEFAULT 7 CHECK (export_grace_days BETWEEN 0 AND 120),
  ADD COLUMN portal_url TEXT,
  ADD COLUMN classification_source TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (classification_source IN ('unconfirmed', 'inferred_from_data', 'lender_confirmed'));
COMMENT ON COLUMN lenders.classification_source IS
  'unconfirmed = our starting guess; inferred_from_data = read off observed approvals/amounts; lender_confirmed = the lender or the person who runs the applications said so';
