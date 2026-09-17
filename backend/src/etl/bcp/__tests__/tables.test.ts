import { describe, expect, it } from "vitest";
import { findAdapter, pick, resolveColumns, toBool, toInt, toIso, toNum } from "../tables.js";

describe("bcp table adapters", () => {
  it("claims tables by normalised name", () => {
    expect(findAdapter("patient_master")?.entity).toBe("patients");
    expect(findAdapter("patients")?.entity).toBe("patients");
    expect(findAdapter("treat_plan")?.entity).toBe("treatment_plans");
    expect(findAdapter("treat_plan_detail")?.entity).toBe("treatment_plan_items");
    expect(findAdapter("office")?.entity).toBe("offices");
    expect(findAdapter("ref_type")?.entity).toBe("referral_types");
    expect(findAdapter("ledger")).toBeNull();
  });

  it("config entity overrides the name match", () => {
    expect(findAdapter("weird_export_01", { entity: "patients" })?.entity).toBe("patients");
  });

  it("resolves columns through aliases, case- and punctuation-insensitively", () => {
    const r = resolveColumns("patients", ["PAT_ID", "Ofc Id", "LName", "fname", "DOB", "SEX"]);
    expect(r.adapter?.entity).toBe("patients");
    expect(r.map).toMatchObject({ patientId: "PAT_ID", officeId: "Ofc Id", lastName: "LName", firstName: "fname", birthDate: "DOB" });
    expect(r.missingRequired).toEqual([]);
    expect(r.missingOptional).toContain("chartNo");
  });

  it("reports missing required columns instead of guessing", () => {
    const r = resolveColumns("patients", ["col_1", "col_2", "col_3"]);
    expect(r.missingRequired).toEqual(["patientId", "officeId"]);
  });

  it("explicit map entries win over aliases", () => {
    const r = resolveColumns("patients", ["ID", "HOME", "X"], { map: { patientId: "ID", officeId: "HOME" } });
    expect(r.map).toMatchObject({ patientId: "ID", officeId: "HOME" });
    expect(r.missingRequired).toEqual([]);
  });

  it("never maps one file column to two keys", () => {
    // "status" is an alias for both `active` (patients) and nothing else here; but
    // provider `lastName` has alias "name" and `firstName` doesn't — a lone NAME column
    // must land on exactly one key.
    const r = resolveColumns("providers", ["PROVID", "OFCID", "NAME"]);
    const targets = Object.values(r.map);
    expect(new Set(targets).size).toBe(targets.length);
    expect(r.map.lastName).toBe("NAME");
  });

  it("pick pulls adapter keys out of a raw row", () => {
    expect(pick({ PATID: "1", OFCID: null, X: "y" }, { patientId: "PATID", officeId: "OFCID" })).toEqual({ patientId: "1", officeId: null });
  });

  describe("coercions", () => {
    it("bools", () => {
      expect(toBool("1")).toBe(true);
      expect(toBool("0")).toBe(false);
      expect(toBool("Y")).toBe(true);
      expect(toBool("Inactive")).toBe(false);
      expect(toBool(null)).toBe(true);
      expect(toBool(null, false)).toBe(false);
      expect(toBool("maybe", false)).toBe(false);
    });
    it("ints and numbers", () => {
      expect(toInt(" 42 ")).toBe(42);
      expect(toInt("4.2")).toBeNull();
      expect(toInt("")).toBeNull();
      expect(toNum("$1,250.50")).toBe(1250.5);
      expect(toNum("abc")).toBeNull();
    });
    it("SQL datetimes, US dates, sentinels", () => {
      expect(toIso("2026-09-01 14:03:00.000")).toBe("2026-09-01T14:03:00.000Z");
      expect(toIso("2026-09-01")).toBe("2026-09-01T00:00:00.000Z");
      expect(toIso("9/1/2026")).toBe("2026-09-01T00:00:00.000Z");
      expect(toIso("9/1/2026 2:30 PM")).toBe("2026-09-01T14:30:00.000Z");
      expect(toIso("1900-01-01 00:00:00.000")).toBeNull();
      expect(toIso("1753-01-01")).toBeNull();
      expect(toIso("not a date")).toBeNull();
      expect(toIso(null)).toBeNull();
    });
  });
});
