import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectDelimiter,
  detectEncoding,
  detectShape,
  looksLikeHeader,
  parseFormatFile,
  parseLine,
  readRows,
  tableNameFromFile,
} from "../delimited.js";

describe("bcp delimited reader", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bcp-test-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  describe("tableNameFromFile", () => {
    it.each([
      ["dbo_PatientMaster.txt", "patient_master"],
      ["dbo.Patient.bcp", "patient"],
      ["tblAppointment.dat", "appointment"],
      ["PATIENTS.TXT", "patients"],
      ["TreatPlanDetail.txt", "treat_plan_detail"],
      ["sub/dir/Ref Type.csv", "ref_type"],
      ["Ledger-2026.out", "ledger_2026"],
    ])("%s → %s", (file, expected) => {
      expect(tableNameFromFile(file)).toBe(expected);
    });
  });

  describe("detectEncoding", () => {
    it("recognises BOMs and BOM-less UTF-16LE", () => {
      expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe("utf16le");
      expect(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe("utf8");
      expect(detectEncoding(Buffer.from("1\t2\tabc\r\n3\t4\tdef\r\n", "utf16le"))).toBe("utf16le");
    });
    it("falls back to latin1 on invalid UTF-8 (Windows-1252 accents)", () => {
      expect(detectEncoding(Buffer.from([0x4a, 0x6f, 0x73, 0xe9, 0x09, 0x31]))).toBe("latin1");
      expect(detectEncoding(Buffer.from("José\t1\n"))).toBe("utf8");
    });
  });

  describe("detectDelimiter", () => {
    it("prefers the delimiter that splits every line into the same number of fields", () => {
      expect(detectDelimiter(["a\tb\tc", "1\t2\t3"])).toBe("\t");
      expect(detectDelimiter(["a|b|c", "1|2|3"])).toBe("|");
      expect(detectDelimiter(["a,b,c", "1,2,3"])).toBe(",");
    });
    it("isn't fooled by commas inside pipe-delimited text", () => {
      expect(detectDelimiter(["1|Smith, John|CA", "2|Doe|CA", "3|Lee, A, B|CA"])).toBe("|");
    });
    it("defaults to tab for a single-column file", () => {
      expect(detectDelimiter(["abc", "def"])).toBe("\t");
    });
  });

  describe("looksLikeHeader", () => {
    it("sees a header when data rows carry numbers or dates", () => {
      expect(looksLikeHeader(["PATID", "LNAME"], [["4000001", "Doe"]])).toBe(true);
      expect(looksLikeHeader(["Chart No", "Last Name"], [["A-12", "Doe"], ["B-2", "Roe"]])).toBe(false);
      expect(looksLikeHeader(["Chart No", "DOB"], [["A-12", "1980-01-01"]])).toBe(true);
    });
    it("sees a header on an all-text lookup table", () => {
      expect(looksLikeHeader(["REFCODE", "REFDESC"], [["WEB", "Website / Online Booking"]])).toBe(true);
    });
    it("does not see a header on a bcp -c data row", () => {
      expect(looksLikeHeader(["4000001", "102", "Doe"], [["4000002", "103", "Roe"]])).toBe(false);
      expect(looksLikeHeader(["A", "Accepted"], [["U", "Unaccepted"]])).toBe(false);
    });
    it("rejects duplicate column names", () => {
      expect(looksLikeHeader(["ID", "ID"], [["1", "2"]])).toBe(false);
    });
  });

  describe("parseFormatFile", () => {
    it("reads the classic non-XML format", () => {
      const fmt = ["14.0", "3", '1 SQLCHAR 0 12 "\\t" 1 PATID ""', '2 SQLCHAR 0 50 "\\t" 2 LNAME SQL_Latin1_General_CP1_CI_AS', '3 SQLCHAR 0 24 "\\r\\n" 3 DOB ""', ""].join("\n");
      expect(parseFormatFile(fmt)).toEqual(["PATID", "LNAME", "DOB"]);
    });
    it("reads the XML format", () => {
      const xml = `<?xml version="1.0"?><BCPFORMAT xmlns="http://schemas.microsoft.com/sqlserver/2004/bulkload/format">
        <RECORD><FIELD ID="1" xsi:type="CharTerminated" TERMINATOR="\\t"/></RECORD>
        <ROW><COLUMN SOURCE="1" NAME="PatientId" xsi:type="SQLINT"/><COLUMN SOURCE="2" NAME="LastName" xsi:type="SQLVARYCHAR"/></ROW></BCPFORMAT>`;
      expect(parseFormatFile(xml)).toEqual(["PatientId", "LastName"]);
    });
    it("rejects garbage", () => {
      expect(parseFormatFile("hello")).toBeNull();
      expect(parseFormatFile("14.0\n2\n1 SQLCHAR\n")).toBeNull();
    });
  });

  describe("parseLine", () => {
    it("maps fields to columns, empties to null, hashes the raw line and flags ragged rows", () => {
      const shape = { delimiter: "\t", columns: ["a", "b", "c"] };
      const r = parseLine("1\t\tx", 2, shape);
      expect(r.values).toEqual({ a: "1", b: null, c: "x" });
      expect(r.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(r.ragged).toBe(false);
      expect(parseLine("1\t2", 3, shape).ragged).toBe(true);
      expect(parseLine("1\t2\t3\t4", 4, shape)).toMatchObject({ ragged: true, values: { col_4: "4" } });
      expect(parseLine("1\t2\t3", 1, shape).hash).toBe(parseLine("1\t2\t3", 99, shape).hash);
    });
  });

  describe("detectShape + readRows", () => {
    it("bcp -c file: no header, generated columns, CRLF, trailing newline", async () => {
      const f = path.join(dir, "dbo_Thing.txt");
      await writeFile(f, "1\tfoo\t2026-01-02 00:00:00.000\r\n2\t\t\r\n");
      const shape = await detectShape(f);
      expect(shape).toMatchObject({ encoding: "utf8", delimiter: "\t", hasHeader: false, columnSource: "generated", columns: ["col_1", "col_2", "col_3"] });
      const rows = [];
      for await (const r of readRows(f, shape)) rows.push(r);
      expect(rows.map((r) => r.values)).toEqual([
        { col_1: "1", col_2: "foo", col_3: "2026-01-02 00:00:00.000" },
        { col_1: "2", col_2: null, col_3: null },
      ]);
    });

    it("uses a sibling .fmt file for column names", async () => {
      const f = path.join(dir, "dbo_Office.txt");
      await writeFile(f, "101\tWest Covina\r\n");
      await writeFile(path.join(dir, "dbo_Office.fmt"), '14.0\n2\n1 SQLCHAR 0 12 "\\t" 1 OFCID ""\n2 SQLCHAR 0 100 "\\r\\n" 2 OFCNAME ""\n');
      const shape = await detectShape(f);
      expect(shape).toMatchObject({ hasHeader: false, columnSource: "format-file", columns: ["OFCID", "OFCNAME"] });
    });

    it("header + pipe delimiter + UTF-16LE with BOM", async () => {
      const f = path.join(dir, "Provider.txt");
      await writeFile(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("PROVID|LNAME\r\n501|Satō\r\n", "utf16le")]));
      const shape = await detectShape(f);
      expect(shape).toMatchObject({ encoding: "utf16le", delimiter: "|", hasHeader: true, columnSource: "header", columns: ["PROVID", "LNAME"] });
      const rows = [];
      for await (const r of readRows(f, shape)) rows.push(r.values);
      expect(rows).toEqual([{ PROVID: "501", LNAME: "Satō" }]);
    });

    it("config columns win, and a matching header row is still skipped", async () => {
      const f = path.join(dir, "Patient.txt");
      await writeFile(f, "PATID\tOFCID\n1\t101\n");
      const shape = await detectShape(f, { columns: ["patid", "ofcid"] });
      expect(shape).toMatchObject({ hasHeader: true, columnSource: "config", columns: ["patid", "ofcid"] });
      const rows = [];
      for await (const r of readRows(f, shape)) rows.push(r.values);
      expect(rows).toEqual([{ patid: "1", ofcid: "101" }]);
    });

    it("latin1 accents don't blow up", async () => {
      const f = path.join(dir, "Pat.txt");
      await writeFile(f, Buffer.from([0x31, 0x09, 0x4a, 0x6f, 0x73, 0xe9, 0x0a]));
      const shape = await detectShape(f);
      expect(shape.encoding).toBe("latin1");
      const rows = [];
      for await (const r of readRows(f, shape)) rows.push(r.values);
      expect(rows).toEqual([{ col_1: "1", col_2: "José" }]);
    });
  });
});
