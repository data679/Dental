-- The practice's actual Finance Report (an existing report, screenshotted for reference)
-- uses a lender list that includes a couple not in the original storyboard: Fortiva and
-- Access. Adding them here rather than replacing the storyboard's list, since we don't
-- know yet whether hfd/cherry/covered_care/eve are still in use.
--
-- Note: a value added via ALTER TYPE ... ADD VALUE can't be used in the same transaction
-- it was added in (Postgres restriction) — fine here since this migration only adds
-- values, it doesn't reference them.
ALTER TYPE lender ADD VALUE IF NOT EXISTS 'fortiva';
ALTER TYPE lender ADD VALUE IF NOT EXISTS 'access';
