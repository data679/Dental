import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { denticonSyncQueue } from "../etl/queue.js";
import { listSyncState } from "../etl/denticon/syncState.js";
import {
  DenticonApiError,
  getDenticonClient,
  isDenticonConfigured,
} from "../integrations/denticon/index.js";

// Operational endpoints for the Denticon integration. Like the rest of the API these are
// unauthenticated until Auth0 is wired in (see README) — gate them then, since /sync
// triggers outbound API traffic.
export const denticonRouter = Router();

// GET /api/denticon/status — is it configured, per-office watermarks, staging backlog.
denticonRouter.get("/status", async (_req, res, next) => {
  try {
    const [state, staging] = await Promise.all([
      listSyncState(),
      pool.query<{ table: string; total: string; unprocessed: string }>(`
        SELECT 'patients' AS table, count(*)::text AS total,
               count(*) FILTER (WHERE processed_at IS NULL)::text AS unprocessed
          FROM staging_denticon_patients
        UNION ALL
        SELECT 'treatment_plans', count(*)::text,
               count(*) FILTER (WHERE processed_at IS NULL)::text
          FROM staging_denticon_treatment_plans
      `),
    ]);
    res.json({
      configured: isDenticonConfigured(),
      syncState: state,
      staging: Object.fromEntries(
        staging.rows.map((r) => [r.table, { total: Number(r.total), unprocessed: Number(r.unprocessed) }]),
      ),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/denticon/ping — live round-trip to Denticon to verify the subscription key.
denticonRouter.get("/ping", async (_req, res, next) => {
  if (!isDenticonConfigured()) {
    res.status(503).json({ ok: false, error: "Denticon is not configured" });
    return;
  }
  try {
    const client = getDenticonClient();
    const practice = await client.getPractice();
    let officeCount = 0;
    for await (const _ of client.listOffices()) officeCount += 1;
    res.json({
      ok: true,
      practiceGroup: { pgId: practice.pgId, name: practice.practiceGroupName },
      officeCount,
    });
  } catch (err) {
    if (err instanceof DenticonApiError) {
      res.status(502).json({ ok: false, status: err.status, error: err.message });
      return;
    }
    next(err);
  }
});

const syncBody = z.object({
  mode: z.enum(["incremental", "full"]).default("incremental"),
  officeIds: z.array(z.number().int().positive()).optional(),
  skipProcessing: z.boolean().optional(),
});

// POST /api/denticon/sync — enqueue a sync run; the worker process executes it.
denticonRouter.post("/sync", async (req, res, next) => {
  try {
    const payload = syncBody.parse(req.body ?? {});
    const job = await denticonSyncQueue.add("manual", payload, {
      removeOnComplete: 20,
      removeOnFail: 50,
    });
    res.status(202).json({ queued: true, jobId: job.id, payload });
  } catch (err) {
    next(err);
  }
});

// GET /api/denticon/sync/:jobId — poll a queued run.
denticonRouter.get("/sync/:jobId", async (req, res, next) => {
  try {
    const job = await denticonSyncQueue.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.json({
      id: job.id,
      state: await job.getState(),
      result: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
    });
  } catch (err) {
    next(err);
  }
});
