import { Worker } from "bullmq";
import { connection, QUEUE_NAMES, denticonSyncQueue, bcpLoadQueue } from "./queue.js";
import { env } from "../config/env.js";
import { syncDenticon } from "./jobs/syncDenticon.js";
import { ingestFinancingCsv } from "./jobs/ingestFinancingCsv.js";
import { loadBcp } from "./jobs/loadBcp.js";

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
// One BCP load at a time: two loads of the same dump would race on the staging upserts
// and both think they inserted the rows.
const bcpWorker = new Worker(QUEUE_NAMES.bcpLoad, loadBcp, { connection, concurrency: 1 });

for (const worker of [denticonWorker, financingCsvWorker, bcpWorker]) {
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

// Inbox sweep for the BCP feed: picks up any download zip dropped in DENTICON_BCP_INBOX.
if (env.DENTICON_BCP_CRON && env.DENTICON_BCP_INBOX) {
  await bcpLoadQueue.add(
    "inbox",
    {},
    { repeat: { pattern: env.DENTICON_BCP_CRON }, jobId: "bcp-inbox-scheduled", removeOnComplete: 20, removeOnFail: 50 },
  );
  console.log(`[worker] bcp inbox sweep scheduled: "${env.DENTICON_BCP_CRON}" on ${env.DENTICON_BCP_INBOX}`);
}

console.log("[worker] listening on:", Object.values(QUEUE_NAMES).join(", "));
