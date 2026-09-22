import { pool } from "../db/pool.js";
import type { ApplicationType, Lender } from "../types/domain.js";

/**
 * Re-derives the tier of a lender's applications whose tier did NOT come from a file
 * (lender_only_tier / unknown) from the lender's current configuration. Applications whose
 * tier the export stated are never touched.
 */
export async function retierLender(code: Lender | string): Promise<{ updated: number; tier: ApplicationType | "unknown" } | null> {
  const { rows } = await pool.query<{ offers_prime: boolean; offers_subprime: boolean }>(
    "SELECT offers_prime, offers_subprime FROM lenders WHERE code::text = $1", // ::text: unknown codes miss instead of failing the enum cast
    [code],
  );
  if (!rows[0]) return null;
  const only: ApplicationType | null =
    rows[0].offers_prime !== rows[0].offers_subprime ? (rows[0].offers_prime ? "primary" : "subprime") : null;
  const r = await pool.query(
    `UPDATE financing_applications
        SET application_type = $2, application_type_source = $3, updated_at = now()
      WHERE lender::text = $1 AND application_type_source IS DISTINCT FROM 'file'`,
    [code, only, only ? "lender_only_tier" : "unknown"],
  );
  return { updated: r.rowCount ?? 0, tier: only ?? "unknown" };
}
