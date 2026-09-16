import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";

export type SyncEntity = "reference" | "patients" | "treatment_plans";

export interface SyncStateRow {
  entity: SyncEntity;
  office_id: number;
  watermark: Date | null;
  last_run_at: Date | null;
  last_run_status: "ok" | "error" | null;
  last_run_error: string | null;
  last_run_rows: number | null;
}

type Queryable = Pick<PoolClient, "query">;

export async function getWatermark(
  entity: SyncEntity,
  officeId: number,
  db: Queryable = pool,
): Promise<Date | null> {
  const { rows } = await db.query<{ watermark: Date | null }>(
    "SELECT watermark FROM denticon_sync_state WHERE entity = $1 AND office_id = $2",
    [entity, officeId],
  );
  return rows[0]?.watermark ?? null;
}

export async function setWatermark(
  entity: SyncEntity,
  officeId: number,
  watermark: Date,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO denticon_sync_state (entity, office_id, watermark)
     VALUES ($1, $2, $3)
     ON CONFLICT (entity, office_id) DO UPDATE
       SET watermark = GREATEST(denticon_sync_state.watermark, EXCLUDED.watermark)`,
    [entity, officeId, watermark],
  );
}

export async function recordRun(
  entity: SyncEntity,
  officeId: number,
  outcome: { status: "ok"; rows: number } | { status: "error"; error: unknown },
  db: Queryable = pool,
): Promise<void> {
  const error =
    outcome.status === "error"
      ? String((outcome.error as Error)?.message ?? outcome.error).slice(0, 2000)
      : null;
  await db.query(
    `INSERT INTO denticon_sync_state (entity, office_id, last_run_at, last_run_status, last_run_error, last_run_rows)
     VALUES ($1, $2, now(), $3, $4, $5)
     ON CONFLICT (entity, office_id) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       last_run_status = EXCLUDED.last_run_status,
       last_run_error = EXCLUDED.last_run_error,
       last_run_rows = EXCLUDED.last_run_rows`,
    [entity, officeId, outcome.status, error, outcome.status === "ok" ? outcome.rows : null],
  );
}

export async function listSyncState(db: Queryable = pool): Promise<SyncStateRow[]> {
  const { rows } = await db.query<SyncStateRow>(
    "SELECT * FROM denticon_sync_state ORDER BY entity, office_id",
  );
  return rows;
}
