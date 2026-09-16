// Small RFC 4180 CSV parser — quoted fields, escaped quotes, embedded newlines, CRLF,
// UTF-8 BOM. Lender exports are small (hundreds of rows) so this is string-in, rows-out.
// No dependency because the only thing we need from a CSV library is this.

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function parseCsv(text: string, delimiter = ","): ParsedCsv {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      records.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  if (field.length || record.length) {
    record.push(field);
    records.push(record);
  }

  // Drop fully blank lines (trailing newline, spacer rows).
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const [headers, ...rows] = nonEmpty;
  return { headers: headers!.map((h) => h.trim()), rows };
}

/** Auto-detects comma / tab / semicolon from the header line. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", "\t", ";"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

export function toCsvLine(values: Array<string | number | null | undefined>): string {
  return values
    .map((v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}
