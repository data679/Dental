import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pool } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { openFeed, type ExtractedFeed } from "./archive.js";
import { detectShape, readRows, tableNameFromFile, type FileShape } from "./delimited.js";
import { resolveColumns, type FeedConfig, type Resolution, type TableConfig } from "./tables.js";
import { promoteLoad, type PromoteResult } from "./promote.js";

// Lands a Denticon BCP download into staging_bcp_rows and promotes what it recognises.
//
// Idempotent by construction: each raw line is keyed on (table, sha1). Re-loading the
// same dump inserts nothing; tomorrow's dump inserts only new/changed rows and bumps
// last_seen_load_id on everything else, so "rows not seen in the latest load" is the
// source's delete list. Promotion then only touches rows with processed_at IS NULL.

export interface TableReport {
  table: string;
  file: string;
  bytes: number;
  delimiter: string;
  encoding: string;
  hasHeader: boolean;
  columnSource: FileShape["columnSource"];
  columns: string[];
  fieldCount: number;
  entity: string | null;
  /** adapter key → file column, for the tables we can promote. */
  mapped: Record<string, string>;
  missingRequired: string[];
  missingOptional: string[];
  /** Why this table won't be promoted, in plain words (null = will be). */
  blocked: string | null;
  ignored: boolean;
  rows: number;
  ragged: number;
  inserted: number;
  unchanged: number;
  /** First few rows, for the inspect report (never persisted). */
  sample?: Array<Record<string, string | null>>;
}

export interface FeedReport {
  source: string;
  fileName: string;
  files: string[];
  otherFiles: string[];
  tables: TableReport[];
  problems: string[];
}

export interface LoadResult extends FeedReport {
  loadId: number;
  status: "ok" | "error";
  error: string | null;
  promoted: PromoteResult | null;
  startedAt: string;
  finishedAt: string;
}

export interface LoadOptions {
  password?: string;
  config?: FeedConfig;
  /** Land rows but don't promote to core (debugging the file side). */
  skipPromote?: boolean;
  /** Only these tables (normalised names). */
  only?: string[];
  log?: (msg: string) => void;
}

const BATCH = 500;

export async function loadFeedConfig(explicitPath?: string): Promise<FeedConfig> {
  const candidate = explicitPath ?? env.DENTICON_BCP_CONFIG ?? path.resolve(process.cwd(), "bcp-feed.json");
  try {
    const text = await readFile(candidate, "utf8");
    return JSON.parse(text) as FeedConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !explicitPath && !env.DENTICON_BCP_CONFIG) return {};
    throw new Error(`bcp config ${candidate}: ${(err as Error).message}`);
  }
}

/** Shape + mapping of every file, no database. What `npm run bcp:inspect` prints. */
export async function inspectFeed(source: string, opts: LoadOptions & { sampleRows?: number } = {}): Promise<FeedReport> {
  const cfg = opts.config ?? (await loadFeedConfig());
  const feed = await openFeed(source, opts.password ?? env.DENTICON_BCP_PASSWORD);
  try {
    const report = baseReport(source, feed);
    for (const rel of feed.files) {
      const t = await describeTable(feed.dir, rel, cfg);
      const sample: Array<Record<string, string | null>> = [];
      let rows = 0;
      let ragged = 0;
      if (!t.ignored) {
        const shape = shapeFor(t);
        for await (const r of readRows(path.join(feed.dir, rel), shape)) {
          rows += 1;
          if (r.ragged) ragged += 1;
          if (sample.length < (opts.sampleRows ?? 3)) sample.push(r.values);
        }
      }
      report.tables.push(toReport(t, { rows, ragged, inserted: 0, unchanged: 0 }, sample));
    }
    finishProblems(report);
    return report;
  } finally {
    await feed.cleanup();
  }
}

export async function loadFeed(source: string, opts: LoadOptions = {}): Promise<LoadResult> {
  const log = opts.log ?? ((m: string) => console.log(`[bcp] ${m}`));
  const cfg = opts.config ?? (await loadFeedConfig());
  const st = await stat(source);
  const fileName = path.basename(source);

  const { rows: created } = await pool.query<{ id: number; started_at: string }>(
    `INSERT INTO bcp_loads (source, file_name, file_size, file_mtime) VALUES ($1, $2, $3, $4) RETURNING id, started_at`,
    [source, fileName, st.isFile() ? st.size : null, st.mtime],
  );
  const loadId = Number(created[0]!.id);
  const startedAt = created[0]!.started_at;

  let feed: ExtractedFeed | null = null;
  let report: FeedReport = { source, fileName, files: [], otherFiles: [], tables: [], problems: [] };
  try {
    feed = await openFeed(source, opts.password ?? env.DENTICON_BCP_PASSWORD);
    report = baseReport(source, feed);
    log(`load #${loadId}: ${feed.files.length} data files in ${fileName}`);

    for (const rel of feed.files) {
      const t = await describeTable(feed.dir, rel, cfg);
      if (opts.only?.length && !opts.only.includes(t.table)) {
        report.tables.push(toReport({ ...t, ignored: true, blocked: "not in --only list" }, EMPTY_COUNTS));
        continue;
      }
      if (t.ignored) {
        report.tables.push(toReport(t, EMPTY_COUNTS));
        continue;
      }
      const landed = await landTable(loadId, t, path.join(feed.dir, rel));
      report.tables.push(toReport(t, landed));
      log(
        `${t.table}: ${landed.rows} rows (${landed.inserted} new, ${landed.unchanged} unchanged${landed.ragged ? `, ${landed.ragged} ragged` : ""})` +
          (t.blocked ? ` — not promoted: ${t.blocked}` : ` → ${t.entity}`),
      );
    }
    finishProblems(report);

    const promoted = opts.skipPromote ? null : await promoteLoad(loadId, report.tables, log);

    const { rows: done } = await pool.query<{ finished_at: string }>(
      `UPDATE bcp_loads SET status = 'ok', finished_at = now(), tables = $2 WHERE id = $1 RETURNING finished_at`,
      [loadId, JSON.stringify(stripSamples(report.tables))],
    );
    return { ...report, loadId, status: "ok", error: null, promoted, startedAt, finishedAt: done[0]?.finished_at ?? new Date().toISOString() };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const { rows: done } = await pool.query<{ finished_at: string }>(
      `UPDATE bcp_loads SET status = 'error', finished_at = now(), error = $2, tables = $3 WHERE id = $1 RETURNING finished_at`,
      [loadId, message.slice(0, 2000), JSON.stringify(stripSamples(report.tables))],
    );
    log(`load #${loadId} failed: ${message}`);
    return { ...report, loadId, status: "error", error: message, promoted: null, startedAt, finishedAt: done[0]?.finished_at ?? new Date().toISOString() };
  } finally {
    await feed?.cleanup();
  }
}

// --------------------------------------------------------------------------------------

function baseReport(source: string, feed: ExtractedFeed): FeedReport {
  return {
    source,
    fileName: path.basename(source),
    files: feed.files,
    otherFiles: feed.allFiles.filter((f) => !feed.files.includes(f)),
    tables: [],
    problems: [],
  };
}

type Described = Omit<TableReport, "rows" | "ragged" | "inserted" | "unchanged" | "sample"> & { resolution: Resolution };

async function describeTable(dir: string, rel: string, cfg: FeedConfig): Promise<Described> {
  const table = tableNameFromFile(rel);
  const tcfg: TableConfig | undefined = cfg.tables?.[table] ?? cfg.tables?.[path.basename(rel)];
  const full = path.join(dir, rel);
  const bytes = (await stat(full)).size;
  const base = {
    table,
    file: rel,
    bytes,
    entity: null as string | null,
    mapped: {},
    missingRequired: [] as string[],
    missingOptional: [] as string[],
    blocked: null as string | null,
    ignored: false,
    resolution: { adapter: null, map: {}, missingRequired: [], missingOptional: [] } as Resolution,
  };
  if (tcfg?.ignore) {
    return { ...base, delimiter: "", encoding: "", hasHeader: false, columnSource: "generated", columns: [], fieldCount: 0, ignored: true, blocked: "ignored in bcp-feed.json" };
  }
  const shape = await detectShape(full, {
    columns: tcfg?.columns,
    delimiter: tcfg?.delimiter ?? cfg.delimiter,
  });
  const resolution = resolveColumns(table, shape.columns, tcfg);
  let blocked: string | null = null;
  if (!resolution.adapter) {
    blocked = "no adapter for this table (landed in staging only)";
  } else if (shape.columnSource === "generated") {
    blocked = `column names unknown — add "columns" for "${table}" in bcp-feed.json from the data dictionary`;
  } else if (resolution.missingRequired.length) {
    blocked = `missing required column(s): ${resolution.missingRequired.join(", ")} — add a "map" for "${table}" in bcp-feed.json`;
  }
  return {
    ...base,
    delimiter: shape.delimiter,
    encoding: shape.encoding,
    hasHeader: shape.hasHeader,
    columnSource: shape.columnSource,
    columns: shape.columns,
    fieldCount: shape.fieldCount,
    entity: resolution.adapter?.entity ?? null,
    mapped: resolution.map,
    missingRequired: resolution.missingRequired,
    missingOptional: resolution.missingOptional,
    blocked,
    resolution,
  };
}

function shapeFor(t: Described): FileShape {
  return {
    encoding: t.encoding as FileShape["encoding"],
    delimiter: t.delimiter,
    hasHeader: t.hasHeader,
    columns: t.columns,
    columnSource: t.columnSource,
    fieldCount: t.fieldCount,
  };
}

async function landTable(loadId: number, t: Described, file: string): Promise<Pick<TableReport, "rows" | "ragged" | "inserted" | "unchanged">> {
  const shape = shapeFor(t);
  let rows = 0;
  let ragged = 0;
  let inserted = 0;
  let unchanged = 0;
  let batch: Array<{ hash: string; raw: string }> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const values: unknown[] = [];
    const tuples = batch.map((b, i) => {
      values.push(t.table, b.hash, b.raw, loadId);
      const o = i * 4;
      return `($${o + 1}, $${o + 2}, $${o + 3}::jsonb, $${o + 4}, $${o + 4})`;
    });
    const { rows: res } = await pool.query<{ inserted: boolean }>(
      `INSERT INTO staging_bcp_rows (table_name, row_hash, raw, first_seen_load_id, last_seen_load_id)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (table_name, row_hash) DO UPDATE SET last_seen_load_id = EXCLUDED.last_seen_load_id
       RETURNING (xmax = 0) AS inserted`,
      values,
    );
    for (const r of res) r.inserted ? (inserted += 1) : (unchanged += 1);
    batch = [];
  };

  const seen = new Set<string>();
  for await (const r of readRows(file, shape)) {
    rows += 1;
    if (r.ragged) ragged += 1;
    // Identical duplicate lines within one file would collide inside a single INSERT.
    if (seen.has(r.hash)) continue;
    seen.add(r.hash);
    batch.push({ hash: r.hash, raw: JSON.stringify(r.values) });
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return { rows, ragged, inserted, unchanged };
}

function finishProblems(report: FeedReport) {
  if (report.files.length === 0) report.problems.push("no data files (.txt/.csv/.dat/.bcp…) found in the download");
  for (const t of report.tables) {
    if (t.ignored) continue;
    if (t.ragged > 0) report.problems.push(`${t.table}: ${t.ragged} of ${t.rows} rows have a different field count than the column list (${t.columns.length}) — wrong delimiter, or embedded delimiters/newlines in text fields`);
    if (t.rows === 0) report.problems.push(`${t.table}: empty file`);
  }
  const entities = report.tables.filter((t) => !t.blocked && !t.ignored).map((t) => t.entity);
  if (!entities.includes("patients")) report.problems.push("no promotable patients table — the dashboard can't be fed until one is mapped");
}

function stripSamples(tables: TableReport[]) {
  return tables.map(({ sample: _s, ...t }) => t);
}

type Counts = Pick<TableReport, "rows" | "ragged" | "inserted" | "unchanged">;
const EMPTY_COUNTS: Counts = { rows: 0, ragged: 0, inserted: 0, unchanged: 0 };

function toReport(t: Described, counts: Counts, sample?: TableReport["sample"]): TableReport {
  const { resolution: _r, ...rest } = t;
  return { ...rest, ...counts, ...(sample ? { sample } : {}) };
}
