import { Worker } from "bullmq";
import { connection, QUEUE_NAMES, denticonSyncQueue } from "./queue.js";
import { env } from "../config/env.js";
import { syncDenticon } from "./jobs/syncDenticon.js";
import { ingestFinancingCsv } from "./jobs/ingestFinancingCsv.js";

// One Denticon sync at a time — the job is already parallel-safe via upserts, but two
// overlapping runs would just double the API traffic against the rate limit.
const denticonWorker = new Worker(QUEUE_NAMES.denticonSync, syncDenticon, {
  connection,
  concurrency: 1,
});
const financingCsvWorker = new Worker(
  QUEUE_NAMES.financingCsvIntake,
  ingestFinancingCsv,
  { connection },
);

for (const worker of [denticonWorker, financingCsvWorker]) {
  worker.on("completed", (job) => console.log(`[worker] ${job.queueName} ${job.id} done`));
  worker.on("failed", (job, err) =>
    console.error(`[worker] ${job?.queueName} ${job?.id} failed`, err),
  );
}

// Recurring incremental sync. Registered from the worker so a single `npm run worker`
// is enough to keep the dashboard current; the job no-ops until credentials exist.
if (env.DENTICON_SYNC_CRON) {
  await denticonSyncQueue.add(
    "scheduled",
    { mode: "incremental" },
    { repeat: { pattern: env.DENTICON_SYNC_CRON }, jobId: "denticon-sync-scheduled", removeOnComplete: 20, removeOnFail: 50 },
  );
  console.log(`[worker] denticon sync scheduled: "${env.DENTICON_SYNC_CRON}"`);
}

console.log("[worker] listening on:", Object.values(QUEUE_NAMES).join(", "));
