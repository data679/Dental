import { Worker } from "bullmq";
import { connection, QUEUE_NAMES } from "./queue.js";
import { syncDenticonPatients } from "./jobs/syncDenticonPatients.js";
import { ingestFinancingCsv } from "./jobs/ingestFinancingCsv.js";

const denticonWorker = new Worker(QUEUE_NAMES.denticonSync, syncDenticonPatients, {
  connection,
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

console.log("[worker] listening on:", Object.values(QUEUE_NAMES).join(", "));
