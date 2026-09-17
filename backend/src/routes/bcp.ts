import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { bcpLoadQueue } from "../etl/queue.js";
import { pendingInboxFiles } from "../etl/jobs/loadBcp.js";

// Operational endpoints for the Denticon data-download (BCP) feed. Unauthenticated like
// the rest of the API until Auth0 is wired in; gate them then — /load reads server-side
// files and the zip password from the environment.
export const bcpRouter = Router();

// GET /api/bcp/status — feed health for the Import page: last good load, last failure,
// what's waiting in the inbox, staging volume.
bcpRouter.get("/status", async (_req, res, next) => {
  try {
    const [last, lastError, staging, pending] = await Promise.all([
      pool.query(
        `SELECT id, file_name, started_at, finished_at, tables FROM bcp_loads
          WHERE status = 'ok' ORDER BY finished_at DESC LIMIT 1`,
      ),
      pool.query(
        `SELECT id, file_name, started_at, finished_at, error FROM bcp_loads
          WHERE status = 'error' ORDER BY started_at DESC LIMIT 1`,
      ),
      pool.query<{ table_name: string; total: string; unprocessed: string }>(
        `SELECT table_name, count(*)::text AS total, count(*) FILTER (WHERE processed_at IS NULL)::text AS unprocessed
           FROM staging_bcp_rows GROUP BY table_name ORDER BY table_name`,
      ),
      env.DENTICON_BCP_INBOX ? pendingInboxFiles() : Promise.resolve([]),
    ]);
    const ok = last.rows[0] ?? null;
    const staleAfterMs = env.DENTICON_BCP_STALE_DAYS * 86_400_000;
    res.json({
      configured: Boolean(env.DENTICON_BCP_PASSWORD || env.DENTICON_BCP_INBOX),
      inbox: env.DENTICON_BCP_INBOX ?? null,
      pendingFiles: pending.map((p) => p.split(/[\\/]/).pop()),
      lastLoad: ok
        ? {
            id: Number(ok.id),
            fileName: ok.file_name,
            finishedAt: ok.finished_at,
            stale: Date.now() - new Date(ok.finished_at).getTime() > staleAfterMs,
            tables: (ok.tables as Array<Record<string, unknown>>).map((t) => ({
              table: t.table,
              entity: t.entity,
              rows: t.rows,
              inserted: t.inserted,
              blocked: t.blocked,
            })),
          }
        : null,
      lastError: lastError.rows[0]
        ? { id: Number(lastError.rows[0].id), fileName: lastError.rows[0].file_name, at: lastError.rows[0].started_at, error: lastError.rows[0].error }
        : null,
      staging: staging.rows.map((r) => ({ table: r.table_name, total: Number(r.total), unprocessed: Number(r.unprocessed) })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/bcp/loads — history, newest first.
bcpRouter.get("/loads", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 200);
    const { rows } = await pool.query(
      `SELECT id, source, file_name, file_size, started_at, finished_at, status, error, tables
         FROM bcp_loads ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    res.json(rows.map((r) => ({ ...r, id: Number(r.id), file_size: r.file_size === null ? null : Number(r.file_size) })));
  } catch (err) {
    next(err);
  }
});

bcpRouter.get("/loads/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM bcp_loads WHERE id = $1", [Number(req.params.id)]);
    if (!rows[0]) {
      res.status(404).json({ error: "load not found" });
      return;
    }
    res.json({ ...rows[0], id: Number(rows[0].id) });
  } catch (err) {
    next(err);
  }
});

const loadBody = z.object({
  /** Server-side path to a zip or folder; omit to sweep the inbox. */
  source: z.string().min(1).optional(),
  skipPromote: z.boolean().optional(),
  only: z.array(z.string()).optional(),
});

// POST /api/bcp/load — enqueue a load; the worker runs it.
bcpRouter.post("/load", async (req, res, next) => {
  try {
    const payload = loadBody.parse(req.body ?? {});
    if (!payload.source && !env.DENTICON_BCP_INBOX) {
      res.status(400).json({ error: "no source given and DENTICON_BCP_INBOX is not set" });
      return;
    }
    const job = await bcpLoadQueue.add("manual", payload, { removeOnComplete: 20, removeOnFail: 50 });
    res.status(202).json({ queued: true, jobId: job.id, payload });
  } catch (err) {
    next(err);
  }
});

bcpRouter.get("/load/:jobId", async (req, res, next) => {
  try {
    const job = await bcpLoadQueue.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.json({ id: job.id, state: await job.getState(), result: job.returnvalue ?? null, failedReason: job.failedReason ?? null });
  } catch (err) {
    next(err);
  }
});
