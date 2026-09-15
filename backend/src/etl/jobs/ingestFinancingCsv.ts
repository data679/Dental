import type { Job } from "bullmq";
import { pool } from "../../db/pool.js";

export interface IngestFinancingCsvPayload {
  rows: Record<string, string>[];
  sourceFile: string;
  importedBy: string;
}

// Stub: takes already-parsed CSV rows (financing applications: patient, lender, status,
// dates, amounts) and lands them in staging_financing_csv as raw JSON per row. This is the
// manual-intake path from the storyboard, used until a lender/Denticon financing API
// integration exists.
export async function ingestFinancingCsv(
  job: Job<IngestFinancingCsvPayload>,
): Promise<{ inserted: number }> {
  const { rows, sourceFile, importedBy } = job.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      await client.query(
        "INSERT INTO staging_financing_csv (raw, source_file, imported_by) VALUES ($1, $2, $3)",
        [JSON.stringify(row), sourceFile, importedBy],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { inserted: rows.length };
}
