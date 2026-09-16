import { denticonSyncQueue, connection } from "../etl/queue.js";

// `npm run denticon:sync [-- --full] [-- --office 101,102]` — enqueue a sync for the
// worker (`npm run worker` must be running). Equivalent to POST /api/denticon/sync.

const args = process.argv.slice(2);
const full = args.includes("--full");
const officeArg = args[args.indexOf("--office") + 1];
const officeIds =
  args.includes("--office") && officeArg
    ? officeArg.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : undefined;

const job = await denticonSyncQueue.add("cli", { mode: full ? "full" : "incremental", officeIds }, {
  removeOnComplete: 20,
  removeOnFail: 50,
});
console.log(`queued denticon sync job ${job.id} (${full ? "full" : "incremental"}${officeIds ? `, offices ${officeIds.join(",")}` : ""})`);
await denticonSyncQueue.close();
await connection.quit();
