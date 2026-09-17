import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, toCsvLine } from "../csv.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded newlines, CRLF and a BOM", () => {
    const text = '﻿name,note,amount\r\n"Doe, Jane","said ""hi""\nthen left",1200\r\nSmith,,\r\n';
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(["name", "note", "amount"]);
    expect(rows).toEqual([
      ["Doe, Jane", 'said "hi"\nthen left', "1200"],
      ["Smith", "", ""],
    ]);
  });

  it("drops blank lines and detects tab/semicolon delimiters", () => {
    expect(parseCsv("a,b\n\n1,2\n\n").rows).toEqual([["1", "2"]]);
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(parseCsv("a;b\n1;2", ";").rows).toEqual([["1", "2"]]);
  });

  it("round-trips through toCsvLine", () => {
    const line = toCsvLine(["Doe, Jane", 'say "hi"', 12, null]);
    expect(parseCsv(`h1,h2,h3,h4\n${line}`).rows[0]).toEqual(["Doe, Jane", 'say "hi"', "12", ""]);
  });
});

describe("degenerate files", () => {
  it("header-only, blank-only, whitespace-only and quoted headers", () => {
    expect(parseCsv("Lender,Status\n")).toEqual({ headers: ["Lender", "Status"], rows: [] });
    expect(parseCsv("\n\n   \n")).toEqual({ headers: [], rows: [] });
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
    expect(parseCsv('"Lender","Status, Final"\r\nCherry,"Approved"').headers).toEqual(["Lender", "Status, Final"]);
  });

  it("ragged rows: short rows read as blanks, long rows keep extra cells", () => {
    const { rows } = parseCsv("a,b,c\n1\n1,2,3,4");
    expect(rows).toEqual([["1"], ["1", "2", "3", "4"]]);
  });

  it("an unterminated quote doesn't hang or throw", () => {
    const { headers, rows } = parseCsv('a,b\n"open,1\nnext,2');
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toHaveLength(1); // everything after the stray quote becomes one cell
  });
});
