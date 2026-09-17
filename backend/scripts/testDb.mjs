// `npm run test:db` — runs the DB-backed tests against a throwaway schema (`dental_test`)
// inside the dev database, so they never touch dev data and need no superuser to create
// a database. Steps: drop+create the schema, apply migrations into it, run vitest with
// DATABASE_URL pointed at that schema and TEST_DB=1 so the db tests un-skip themselves.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import pg from "pg";

const base = process.env.DATABASE_URL;
if (!base) {
  console.error("DATABASE_URL is not set (see backend/.env.example)");
  process.exit(2);
}
const schema = process.env.TEST_SCHEMA ?? "dental_test";
const url = `${base}${base.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;

const client = new pg.Client({ connectionString: base });
await client.connect();
await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
await client.query(`CREATE SCHEMA ${schema}`);
await client.end();

const env = { ...process.env, DATABASE_URL: url, TEST_DB: "1" };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("npx", ["tsx", "src/db/migrate.ts"]);
// DB tests share one schema, so files must not run concurrently.
run("npx", ["vitest", "run", "--no-file-parallelism", ...process.argv.slice(2)]);
