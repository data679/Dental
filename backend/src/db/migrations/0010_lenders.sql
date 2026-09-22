-- Lenders as data, with the tiers each one actually offers. Some lenders are prime-only,
-- some subprime-only (second-look programs), and some run both programs — so a single
-- default tier per lender is wrong for the "both" ones: the tier of a given application
-- must come from the export (a Program/Tier column), or it is recorded as unknown and
-- flagged, never guessed.
--
-- The rows below are a starting configuration to be confirmed by whoever runs the
-- applications (docs/financing-intake.md § Tiers). Change them with PUT /api/lenders/:code
-- or plain SQL; the importer reads this table at the start of every import.

CREATE TABLE lenders (
  code             lender PRIMARY KEY,
  label            TEXT NOT NULL,
  offers_prime     BOOLEAN NOT NULL DEFAULT true,
  offers_subprime  BOOLEAN NOT NULL DEFAULT true,
  CHECK (offers_prime OR offers_subprime),  -- a lender runs at least one program
  active           BOOLEAN NOT NULL DEFAULT true,
  sort_order       INTEGER NOT NULL DEFAULT 100,
  notes            TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO lenders (code, label, offers_prime, offers_subprime, sort_order, notes) VALUES
  ('care_credit',  'CareCredit',   true,  false, 10, 'Synchrony card; prime program only — confirm'),
  ('alphaeon',     'Alphaeon',     true,  false, 20, 'Comenity card; prime only — confirm'),
  ('cherry',       'Cherry',       true,  true,  30, 'Multiple lending partners; approves across the spectrum — confirm'),
  ('proceed',      'Proceed',      true,  true,  40, 'Broad approvals incl. lower credit — confirm'),
  ('sunbit',       'Sunbit',       true,  true,  50, 'Near-prime focus but both — confirm'),
  ('hfd',          'HFD',          false, true,  60, 'In-house / no-credit-check style program — confirm'),
  ('covered_care', 'Covered Care', false, true,  70, 'Second-look — confirm'),
  ('fortiva',      'Fortiva',      false, true,  80, 'Second-look — confirm'),
  ('access',       'Access',       true,  true,  90, 'Unknown; set to both so the tier must come from the file — confirm'),
  ('eve',          'Eve',          true,  true, 100, 'Unknown; set to both so the tier must come from the file — confirm');

-- An application's tier can now be unknown (lender offers both, export didn't say).
ALTER TABLE financing_applications ALTER COLUMN application_type DROP NOT NULL;
ALTER TABLE financing_applications ADD COLUMN application_type_source TEXT
  CHECK (application_type_source IN ('file', 'lender_only_tier', 'unknown'));
COMMENT ON COLUMN financing_applications.application_type_source IS
  'file = the export said so; lender_only_tier = lender offers exactly one tier; unknown = lender offers both and the export did not say';

-- Backfill the source for rows imported before this column existed, from the evidence the
-- schema already keeps: the batch's header map says whether the file had a tier column.
--   file            → the batch mapped a header to application_type
--   lender_only_tier → no tier column; the lender (per the rows above) runs one program
--   unknown         → no tier column and the lender runs both: the old importer GUESSED a
--                     per-lender default here, so the guess is cleared rather than kept.
-- Rows with no staging trail (none expected) are treated as file-stated to be safe.
UPDATE financing_applications fa
   SET application_type_source = CASE
         WHEN fa.staging_row_id IS NULL THEN 'file'
         WHEN EXISTS (SELECT 1
                        FROM staging_financing_csv s
                        JOIN financing_import_batches b ON b.id = s.batch_id,
                             jsonb_each_text(b.column_map) kv
                       WHERE s.id = fa.staging_row_id AND kv.value = 'application_type') THEN 'file'
         WHEN (SELECT l.offers_prime <> l.offers_subprime FROM lenders l WHERE l.code = fa.lender) THEN 'lender_only_tier'
         ELSE 'unknown' END
 WHERE fa.application_type IS NOT NULL;
UPDATE financing_applications SET application_type = NULL WHERE application_type_source = 'unknown';
UPDATE financing_applications fa
   SET application_type = CASE WHEN l.offers_prime THEN 'primary'::application_type ELSE 'subprime'::application_type END
  FROM lenders l
 WHERE l.code = fa.lender AND fa.application_type_source = 'lender_only_tier';
