import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { NormalizedApplication } from "./columns.js";

// Links a lender's application row to one of our patients. Lender exports rarely carry
// the PMS id, so the ladder is: Denticon patient id → chart number → last name + DOB
// (+ first name to break ties). "ambiguous" is returned rather than guessing when two
// patients share a name and birth date.

export type MatchResult =
  | { status: "matched"; patientId: number; detail: string }
  | { status: "unmatched"; detail: string }
  | { status: "ambiguous"; detail: string };

type Queryable = Pick<PoolClient, "query">;

export async function matchPatient(rec: NormalizedApplication, db: Queryable = pool): Promise<MatchResult> {
  if (rec.patientId) {
    const { rows } = await db.query<{ id: number }>("SELECT id FROM patients WHERE denticon_patient_id = $1", [rec.patientId]);
    if (rows[0]) return { status: "matched", patientId: Number(rows[0].id), detail: "denticon_patient_id" };
  }
  if (rec.chartNo) {
    const { rows } = await db.query<{ id: number }>("SELECT id FROM patients WHERE chart_no = $1", [rec.chartNo]);
    if (rows.length === 1) return { status: "matched", patientId: Number(rows[0]!.id), detail: "chart_no" };
    if (rows.length > 1) return { status: "ambiguous", detail: `chart_no ${rec.chartNo} matches ${rows.length} patients` };
  }
  if (rec.patientLastName && rec.patientDob) {
    const { rows } = await db.query<{ id: number; first_name: string | null }>(
      "SELECT id, first_name FROM patients WHERE lower(last_name) = lower($1) AND birth_date = $2",
      [rec.patientLastName, rec.patientDob],
    );
    if (rows.length === 1) return { status: "matched", patientId: Number(rows[0]!.id), detail: "last_name+dob" };
    if (rows.length > 1) {
      const first = (rec.patientFirstName ?? "").trim().toLowerCase();
      const narrowed = first ? rows.filter((r) => (r.first_name ?? "").toLowerCase().startsWith(first[0]!)) : rows;
      if (narrowed.length === 1) return { status: "matched", patientId: Number(narrowed[0]!.id), detail: "last_name+dob+first_initial" };
      return { status: "ambiguous", detail: `${rows.length} patients share last name + DOB` };
    }
  }
  if (rec.patientLastName && rec.patientFirstName && !rec.patientDob) {
    // Name-only matching is too loose to trust across a DSO; only accept a unique hit.
    const { rows } = await db.query<{ id: number }>(
      "SELECT id FROM patients WHERE lower(last_name) = lower($1) AND lower(first_name) = lower($2)",
      [rec.patientLastName, rec.patientFirstName],
    );
    if (rows.length === 1) return { status: "matched", patientId: Number(rows[0]!.id), detail: "full_name (no DOB)" };
    if (rows.length > 1) return { status: "ambiguous", detail: `${rows.length} patients share that name; add DOB or chart no` };
  }
  const tried = [rec.patientId && "patient_id", rec.chartNo && "chart_no", rec.patientLastName && "name"].filter(Boolean).join(", ");
  return { status: "unmatched", detail: tried ? `no patient found by ${tried}` : "no patient identifiers in row" };
}

/** Case-insensitive location lookup by name, tolerant of "Sample Dental – West Covina" style prefixes. */
export async function resolveLocationId(name: string | null, db: Queryable = pool): Promise<number | null> {
  if (!name) return null;
  const { rows } = await db.query<{ id: number; name: string }>("SELECT id, name FROM locations");
  const n = name.trim().toLowerCase();
  const exact = rows.find((r) => r.name.trim().toLowerCase() === n);
  if (exact) return Number(exact.id);
  const contains = rows.filter((r) => n.includes(r.name.trim().toLowerCase()) || r.name.trim().toLowerCase().includes(n));
  return contains.length === 1 ? Number(contains[0]!.id) : null;
}
