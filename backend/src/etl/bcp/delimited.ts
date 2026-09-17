import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

// Reader for the flat files inside a Denticon BCP download. SQL Server's bcp writes one
// file per table; in character mode (-c) that's one row per line, fields split by a
// terminator (tab by default, but exports are often set up with | or ,), no header row,
// and NULL as an empty field. Some exports add a header, some ship a .fmt / .xml format
// file describing the columns. We don't know which flavour this practice group's feed is
// until the first file arrives, so everything here is detected, and the detection result
// is reported back so it can be checked against the data dictionary.

export type Encoding = "utf8" | "utf16le" | "latin1";

export interface FileShape {
  encoding: Encoding;
  delimiter: string;
  /** True when the first line looks like column names rather than data. */
  hasHeader: boolean;
  /** Column names: header row, format file, supplied list, or col_1..col_n. */
  columns: string[];
  columnSource: "header" | "format-file" | "config" | "generated";
  /** Number of fields seen on the first data line (may differ from columns.length). */
  fieldCount: number;
}

export interface DelimitedRow {
  lineNo: number;
  /** sha1 of the raw line — the staging dedupe key. */
  hash: string;
  values: Record<string, string | null>;
  /** Field count didn't match the column list. */
  ragged: boolean;
}

const SNIFF_BYTES = 64 * 1024;

export async function sniffEncoding(path: string): Promise<Encoding> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return detectEncoding(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export function detectEncoding(head: Buffer): Encoding {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return "utf16le";
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return "utf8";
  // bcp -w writes UTF-16LE without a BOM: every other byte of ASCII text is 0x00.
  if (head.length >= 8) {
    const span = Math.min(head.length, 512);
    let zeroOdd = 0;
    for (let i = 1; i < span; i += 2) if (head[i] === 0) zeroOdd += 1;
    if (zeroOdd > span / 4) return "utf16le";
  }
  // Invalid UTF-8 (e.g. Windows-1252 accents from bcp -c) → latin1 so nothing throws.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return "utf8";
  } catch {
    return "latin1";
  }
}

/**
 * Picks the delimiter that splits the sampled lines into the same (largest) number of
 * fields most consistently. Tab wins ties because it's bcp's default.
 */
export function detectDelimiter(lines: string[]): string {
  const candidates = ["\t", "|", ",", ";", "~", ""];
  let best = "\t";
  let bestScore = -1;
  for (const d of candidates) {
    const counts = lines.filter((l) => l.length > 0).map((l) => l.split(d).length - 1);
    if (counts.length === 0 || counts[0] === 0) continue;
    const mode = counts[0]!;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    // Consistency first, then how many fields it yields.
    const score = consistent * 1000 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Heuristic header detection: every cell is a plausible identifier (letters, digits,
 * underscores, spaces; starts with a letter), no duplicates, and at least one later line
 * disagrees with the "all identifiers" shape (a data row usually has a number or a date).
 */
export function looksLikeHeader(first: string[], sample: string[][]): boolean {
  if (first.length === 0) return false;
  const ident = /^[A-Za-z][A-Za-z0-9_ .#/-]*$/;
  const strictIdent = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!first.every((c) => ident.test(c.trim()))) return false;
  if (new Set(first.map((c) => c.trim().toLowerCase())).size !== first.length) return false;
  if (sample.length === 0) return true; // header-only file
  const numericish = /^-?\d+(\.\d+)?$|^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}/;
  if (first.some((c) => numericish.test(c.trim()))) return false;
  // A data row usually carries a number or a date somewhere…
  if (sample.some((row) => row.some((c) => numericish.test(c.trim())))) return true;
  // …but an all-text lookup table (code + description) won't. Then: column names are
  // bare identifiers (no spaces/punctuation) while at least one data cell isn't.
  return (
    first.every((c) => strictIdent.test(c.trim())) &&
    sample.some((row) => row.some((c) => c.trim() !== "" && !strictIdent.test(c.trim())))
  );
}

export function generatedColumns(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `col_${i + 1}`);
}

/**
 * Column names from a bcp format file next to the data file. Supports the classic
 * non-XML format (version, count, then one line per field where the 7th token is the
 * column name) and the XML format (`<COLUMN ... NAME="..."/>`).
 */
export async function readFormatFile(path: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return parseFormatFile(text);
}

export function parseFormatFile(text: string): string[] | null {
  if (/<BCPFORMAT/i.test(text)) {
    const names = [...text.matchAll(/<COLUMN\b[^>]*\bNAME="([^"]+)"/gi)].map((m) => m[1]!);
    return names.length ? names : null;
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const count = Number(lines[1]);
  if (!Number.isInteger(count) || count <= 0) return null;
  const names: string[] = [];
  for (const line of lines.slice(2, 2 + count)) {
    // 1  SQLCHAR  0  12  "\t"  1  PatientId  ""
    const tokens = line.match(/"[^"]*"|\S+/g) ?? [];
    const name = tokens[6];
    if (!name) return null;
    names.push(name.replace(/^"|"$/g, ""));
  }
  return names.length === count ? names : null;
}

export interface ShapeOptions {
  /** Column names known up front (from config); overrides header/format-file detection. */
  columns?: string[];
  /** Force a delimiter instead of detecting one. */
  delimiter?: string;
  /** Format file to consult (defaults to `<file>.fmt` / `<file without ext>.fmt|.xml`). */
  formatFile?: string | null;
}

export async function detectShape(path: string, opts: ShapeOptions = {}): Promise<FileShape> {
  const encoding = await sniffEncoding(path);
  const fh = await open(path, "r");
  let head: string;
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = stripBom(buf.subarray(0, bytesRead).toString(encoding));
  } finally {
    await fh.close();
  }
  const sampleLines = head.split(/\r?\n/).filter((l) => l.length > 0).slice(0, 50);
  // The last sampled line may be cut mid-row by the sniff window.
  if (sampleLines.length > 1) sampleLines.pop();

  const delimiter = opts.delimiter ?? detectDelimiter(sampleLines);
  const split = sampleLines.map((l) => l.split(delimiter));
  const first = split[0] ?? [];
  const fieldCount = first.length;

  if (opts.columns?.length) {
    const hasHeader = looksLikeHeader(first, split.slice(1)) && sameNames(first, opts.columns);
    return { encoding, delimiter, hasHeader, columns: opts.columns, columnSource: "config", fieldCount };
  }
  const formatCandidates =
    opts.formatFile === null
      ? []
      : opts.formatFile
        ? [opts.formatFile]
        : [`${path}.fmt`, `${path}.xml`, path.replace(/\.[^.]+$/, ".fmt"), path.replace(/\.[^.]+$/, ".xml")];
  for (const f of formatCandidates) {
    const cols = await readFormatFile(f);
    if (cols) {
      const hasHeader = looksLikeHeader(first, split.slice(1)) && sameNames(first, cols);
      return { encoding, delimiter, hasHeader, columns: cols, columnSource: "format-file", fieldCount };
    }
  }
  if (looksLikeHeader(first, split.slice(1))) {
    return {
      encoding,
      delimiter,
      hasHeader: true,
      columns: first.map((c) => c.trim()),
      columnSource: "header",
      fieldCount: split[1]?.length ?? fieldCount,
    };
  }
  return { encoding, delimiter, hasHeader: false, columns: generatedColumns(fieldCount), columnSource: "generated", fieldCount };
}

function sameNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.trim().toLowerCase() === b[i]!.trim().toLowerCase());
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Streams a file row by row so a multi-million-row ledger dump never sits in memory. */
export async function* readRows(path: string, shape: FileShape): AsyncGenerator<DelimitedRow> {
  const stream = createReadStream(path, { encoding: shape.encoding });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const rawLine of rl) {
      lineNo += 1;
      const line = lineNo === 1 ? stripBom(rawLine) : rawLine;
      if (lineNo === 1 && shape.hasHeader) continue;
      if (line.trim() === "") continue;
      yield parseLine(line, lineNo, shape);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export function parseLine(line: string, lineNo: number, shape: Pick<FileShape, "delimiter" | "columns">): DelimitedRow {
  const fields = line.split(shape.delimiter);
  const values: Record<string, string | null> = {};
  const n = Math.max(fields.length, shape.columns.length);
  for (let i = 0; i < n; i++) {
    const name = shape.columns[i] ?? `col_${i + 1}`;
    const v = fields[i];
    values[name] = v === undefined || v === "" ? null : v;
  }
  return {
    lineNo,
    hash: createHash("sha1").update(line).digest("hex"),
    values,
    ragged: fields.length !== shape.columns.length,
  };
}

/** `dbo_PatientMaster.txt`, `PATIENTS.bcp`, `tblAppointment.dat` → `patient_master`, `patients`, `appointment`. */
export function tableNameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const stem = base.replace(DATA_FILE_RE, "");
  return stem
    .replace(/^(dbo[._]|tbl_?)/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export const DATA_FILE_RE = /\.(txt|csv|tsv|dat|bcp|out|tab|psv)$/i;
