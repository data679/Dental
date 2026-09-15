import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env.js";

export const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const QUEUE_NAMES = {
  denticonSync: "denticon-sync",
  financingCsvIntake: "financing-csv-intake",
} as const;

export const denticonSyncQueue = new Queue(QUEUE_NAMES.denticonSync, { connection });
export const financingCsvIntakeQueue = new Queue(QUEUE_NAMES.financingCsvIntake, {
  connection,
});
