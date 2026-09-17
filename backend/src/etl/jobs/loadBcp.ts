import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Job } from "bullmq";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { loadFeed, type LoadResult } from "../bcp/loadService.js";

export interface LoadBcpPayload {
  /** Zip or folder to load. Omitted = scan DENTICON_BCP_INBOX for zips not yet loaded. */
  source?: string;
  skipPromote?: boolean;
  only?: string[];
}

export interface LoadBcpResult {
  loads: Array<Pick<LoadResult, "loadId" | "fileName" | "status" | "error" | "problems"> & { tables: number; rows: number }>;
  skipped?: string;
}

// Worker job for the BCP feed. Either loads one explicit file (manual / API trigger) or
// sweeps the inbox folder: every zip whose (name, size, mtime) hasn't been loaded
// successfully yet is loaded, oldest first, so a scheduled drop is picked up without
// anyone clicking anything. A zip still being written changes size between two polls,
// so files modified in the last minute are left for the next sweep.
export async function loadBcp(job: Job<LoadBcpPayload>): Promise<LoadBcpResult> {
  const data = job.data ?? {};
  const sources = data.source ? [data.source] : await pendingInboxFiles();
  if (!data.source && !env.DENTICON_BCP_INBOX) {
    return { loads: [], skipped: "DENTICON_BCP_INBOX not set" };
  }
  const loads: LoadBcpResult["loads"] = [];
  for (const source of sources) {
    const r = await loadFeed(source, { skipPromote: data.skipPromote, only: data.only });
    loads.push({
      loadId: r.loadId,
      fileName: r.fileName,
      status: r.status,
      error: r.error,
      problems: r.problems,
      tables: r.tables.length,
      rows: r.tables.reduce((s, t) => s + t.rows, 0),
    });
  }
  return { loads };
}

export async function pendingInboxFiles(): Promise<string[]> {
  const inbox = env.DENTICON_BCP_INBOX;
  if (!inbox) return [];
  const entries = await readdir(inbox).catch(() => [] as string[]);
  const { rows } = await pool.query<{ file_name: string; file_size: string; file_mtime: string }>(
    "SELECT file_name, file_size::text, file_mtime FROM bcp_loads WHERE status = 'ok'",
  );
  const done = new Set(rows.map((r) => `${r.file_name}|${r.file_size}|${new Date(r.file_mtime).getTime()}`));
  const pending: Array<{ file: string; mtime: number }> = [];
  const now = Date.now();
  for (const name of entries) {
    if (!/\.(zip|7z)$/i.test(name)) continue;
    const full = path.join(inbox, name);
    const st = await stat(full);
    if (!st.isFile()) continue;
    if (now - st.mtimeMs < 60_000) continue; // still being copied in
    if (done.has(`${name}|${st.size}|${st.mtime.getTime()}`)) continue;
    pending.push({ file: full, mtime: st.mtimeMs });
  }
  return pending.sort((a, b) => a.mtime - b.mtime).map((p) => p.file);
}
