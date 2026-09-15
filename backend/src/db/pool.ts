import { Pool } from "pg";
import { env } from "../config/env.js";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

pool.on("error", (err) => {
  // A background client error (e.g. dropped connection) — never crash the process for this.
  console.error("[db] unexpected pool error", err);
});
