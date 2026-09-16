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
