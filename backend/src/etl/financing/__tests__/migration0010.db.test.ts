import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0010's backfill must classify pre-existing applications from the evidence in
// their import batch, not stamp everything as file-stated. Re-runs the backfill statements
// against rows shaped like the pre-migration world. Skipped unless `npm run test:db`.

const d = describe.skipIf(process.env.TEST_DB !== "1");

d("migration 0010 backfill", () => {
  let pool: typeof import("../../../db/pool.js").pool;
  beforeAll(async () => {
    ({ pool } = await import("../../../db/pool.js"));
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("classifies rows by whether their batch had a tier column and what the lender runs", async () => {
    await pool.query(`TRUNCATE fundings, financing_applications, financing_cases, staging_financing_csv, financing_import_batches RESTART IDENTITY CASCADE`);
    await pool.query(`UPDATE lenders SET offers_prime = true, offers_subprime = true WHERE code = 'cherry'`);
    // batch 1 mapped a Program column; batch 2 did not
    await pool.query(`INSERT INTO financing_import_batches (id, source_file, column_map) VALUES
      (1, 'with-tier.csv', '{"Lender":"lender","Program":"application_type"}'),
      (2, 'silent.csv',    '{"Lender":"lender"}')`);
    await pool.query(`INSERT INTO staging_financing_csv (id, raw, batch_id) VALUES (1, '{}', 1), (2, '{}', 2), (3, '{}', 2), (4, '{}', 2)`);
    await pool.query(`INSERT INTO financing_applications (lender, application_type, status, dedupe_key, staging_row_id, application_type_source) VALUES
      ('cherry',      'subprime', 'approved', 'k1', 1, NULL),   -- stated in a file
      ('cherry',      'primary',  'approved', 'k2', 2, NULL),   -- old importer's guess (both-program lender)
      ('care_credit', 'primary',  'approved', 'k3', 3, NULL),   -- derivable: prime-only lender
      ('hfd',         'primary',  'approved', 'k4', 4, NULL)`); // wrong old guess for a subprime-only lender

    // The backfill statements from migration 0010, verbatim.
    await pool.query(`
      UPDATE financing_applications fa
         SET application_type_source = CASE
               WHEN fa.staging_row_id IS NULL THEN 'file'
               WHEN EXISTS (SELECT 1 FROM staging_financing_csv s JOIN financing_import_batches b ON b.id = s.batch_id,
                                 jsonb_each_text(b.column_map) kv WHERE s.id = fa.staging_row_id AND kv.value = 'application_type') THEN 'file'
               WHEN (SELECT l.offers_prime <> l.offers_subprime FROM lenders l WHERE l.code = fa.lender) THEN 'lender_only_tier'
               ELSE 'unknown' END
       WHERE fa.application_type IS NOT NULL;
      UPDATE financing_applications SET application_type = NULL WHERE application_type_source = 'unknown';
      UPDATE financing_applications fa
         SET application_type = CASE WHEN l.offers_prime THEN 'primary'::application_type ELSE 'subprime'::application_type END
        FROM lenders l WHERE l.code = fa.lender AND fa.application_type_source = 'lender_only_tier';`);

    const { rows } = await pool.query("SELECT dedupe_key AS k, application_type AS t, application_type_source AS src FROM financing_applications ORDER BY dedupe_key");
    expect(rows).toEqual([
      { k: "k1", t: "subprime", src: "file" },
      { k: "k2", t: null, src: "unknown" },
      { k: "k3", t: "primary", src: "lender_only_tier" },
      { k: "k4", t: "subprime", src: "lender_only_tier" }, // corrected from the old wrong guess
    ]);
  });
});
