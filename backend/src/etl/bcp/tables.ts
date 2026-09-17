// Which BCP files we know how to promote into the core tables, and which columns each
// needs. Column names in the real export are unknown until the first file / data
// dictionary arrives, so every column is looked up through a list of plausible aliases
// (Denticon API field names, SQL-style names, common abbreviations). Anything that
// doesn't resolve is reported per table by `npm run bcp:inspect` rather than guessed;
// the fix is then a line in bcp-feed.json (see docs/denticon-bcp.md), not a code change.

export type Entity = "offices" | "providers" | "referral_types" | "patients" | "treatment_plans" | "treatment_plan_items";

export interface ColumnSpec {
  /** Key the promoter reads (mirrors the Denticon API field names where one exists). */
  key: string;
  aliases: string[];
  required?: boolean;
}

export interface TableAdapter {
  entity: Entity;
  /** Normalised table names (see tableNameFromFile) this adapter claims. */
  match: RegExp;
  columns: ColumnSpec[];
}

export const ADAPTERS: TableAdapter[] = [
  {
    entity: "offices",
    match: /^(office|offices|office_master|practice_office|pg_office)s?$/,
    columns: [
      { key: "officeId", aliases: ["officeId", "office_id", "ofcid", "ofc_id", "oid", "officeno", "office_no"], required: true },
      { key: "officeName", aliases: ["officeName", "office_name", "ofcname", "name", "office", "description"] },
      { key: "officeActive", aliases: ["officeActive", "active", "is_active", "isactive", "status"] },
    ],
  },
  {
    entity: "providers",
    match: /^(provider|providers|provider_master|doctor|doctors|prov)s?$/,
    columns: [
      { key: "providerId", aliases: ["providerId", "provider_id", "provid", "prov_id", "pid", "doctorid", "doctor_id"], required: true },
      { key: "officeId", aliases: ["officeId", "office_id", "ofcid", "ofc_id", "oid"], required: true },
      { key: "firstName", aliases: ["firstName", "first_name", "fname", "firstname", "provfirst"] },
      { key: "lastName", aliases: ["lastName", "last_name", "lname", "lastname", "provlast", "name"] },
      { key: "title", aliases: ["title", "suffix", "degree"] },
      { key: "active", aliases: ["active", "is_active", "isactive", "status"] },
    ],
  },
  {
    entity: "referral_types",
    match: /^(referral_type|referral_types|ref_type|ref_types|referral_source|referral_sources|reftype)s?$/,
    columns: [
      { key: "refTypeCode", aliases: ["refTypeCode", "ref_type_code", "reftypecode", "code", "ref_code", "refcode"], required: true },
      { key: "refTypeDescription", aliases: ["refTypeDescription", "ref_type_description", "description", "desc", "name", "ref_desc"] },
    ],
  },
  {
    entity: "patients",
    match: /^(patient|patients|patient_master|pat_master|patmaster|pat)s?$/,
    columns: [
      { key: "patientId", aliases: ["patientId", "patient_id", "patid", "pat_id", "pid", "patno", "patient_no"], required: true },
      { key: "officeId", aliases: ["officeId", "office_id", "ofcid", "ofc_id", "oid", "home_office", "homeoffice"], required: true },
      { key: "chartNo", aliases: ["chartNo", "chart_no", "chartno", "chart", "chart_number", "chartnumber"] },
      { key: "firstName", aliases: ["firstName", "first_name", "fname", "firstname", "patfirst"] },
      { key: "lastName", aliases: ["lastName", "last_name", "lname", "lastname", "patlast"] },
      { key: "birthDate", aliases: ["birthDate", "birth_date", "dob", "birthdate", "date_of_birth"] },
      { key: "active", aliases: ["active", "is_active", "isactive", "patstatus", "status"] },
      { key: "firstVisitDate", aliases: ["firstVisitDate", "first_visit_date", "firstvisit", "first_visit", "fvdate", "firstvisitdate"] },
      { key: "lastVisitDate", aliases: ["lastVisitDate", "last_visit_date", "lastvisit", "last_visit", "lvdate"] },
      { key: "refTypeCode", aliases: ["refTypeCode", "ref_type_code", "reftype", "ref_type", "referral_type", "refcode", "source"] },
      { key: "preferredProviderId", aliases: ["preferredProviderId", "preferred_provider_id", "provid", "prov_id", "provider_id", "primary_provider", "prefprov"] },
      { key: "lastChangedOn", aliases: ["lastChangedOn", "last_changed_on", "modifiedOn", "modified_on", "moddate", "mod_date", "updated", "lastmodified", "last_modified"] },
    ],
  },
  {
    // Plan header (one row per plan). Optional: when the export only has item rows with
    // the plan fields repeated, this table just won't exist.
    entity: "treatment_plans",
    match: /^(treat_plan|treat_plans|treatment_plan|treatment_plans|tx_plan|tx_plans|txplan|treatplan|treatplan_master)s?$/,
    columns: [
      { key: "treatPlanId", aliases: ["treatPlanId", "treat_plan_id", "tpid", "tp_id", "plan_id", "planid", "treatplanid"], required: true },
      { key: "patientId", aliases: ["patientId", "patient_id", "patid", "pat_id", "pid"], required: true },
      { key: "treatPlanStatus", aliases: ["treatPlanStatus", "treat_plan_status", "status", "tpstatus", "plan_status"] },
      { key: "treatPlanProposedDate", aliases: ["treatPlanProposedDate", "proposed_date", "proposeddate", "presented_date", "created", "createdOn", "created_on", "date"] },
      { key: "acceptedDateTime", aliases: ["acceptedDateTime", "accepted_date", "accepteddate", "accept_date", "treatPlanAuthDate", "auth_date"] },
      { key: "treatPlanFinishDate", aliases: ["treatPlanFinishDate", "finish_date", "finishdate", "completed_date", "completeddate"] },
      { key: "providerId", aliases: ["providerId", "provider_id", "provid", "prov_id"] },
      { key: "lastChangedOn", aliases: ["lastChangedOn", "last_changed_on", "modifiedOn", "modified_on", "moddate", "mod_date", "updated"] },
    ],
  },
  {
    entity: "treatment_plan_items",
    match: /^(treat_plan_detail|treat_plan_details|treat_plan_item|treat_plan_items|treatment_plan_detail|treatment_plan_details|treatment_plan_item|treatment_plan_items|tx_plan_detail|tx_plan_details|txplan_detail|treatplan_detail|treatplandetail|planned_procedure|planned_procedures|tp_detail)s?$/,
    columns: [
      { key: "treatPlanId", aliases: ["treatPlanId", "treat_plan_id", "tpid", "tp_id", "plan_id", "planid", "treatplanid"], required: true },
      { key: "patientId", aliases: ["patientId", "patient_id", "patid", "pat_id", "pid"] },
      { key: "procedureCode", aliases: ["procedureCode", "procedure_code", "proccode", "proc_code", "adaCode", "ada_code", "code", "cdt"] },
      { key: "fee", aliases: ["fee", "amount", "proc_fee", "procfee", "charge", "ucr_fee", "ucrFee"] },
      { key: "isCompleted", aliases: ["isCompleted", "is_completed", "completed", "complete", "done", "status"] },
      { key: "treatPlanFinishDate", aliases: ["treatPlanFinishDate", "completed_date", "completeddate", "finish_date", "date_completed", "posted_date", "posteddate"] },
      { key: "treatPlanStatus", aliases: ["treatPlanStatus", "treat_plan_status", "tpstatus", "plan_status"] },
      { key: "treatPlanProposedDate", aliases: ["treatPlanProposedDate", "proposed_date", "proposeddate", "presented_date", "created", "createdOn", "created_on"] },
      { key: "acceptedDateTime", aliases: ["acceptedDateTime", "accepted_date", "accepteddate", "accept_date"] },
      { key: "providerId", aliases: ["providerId", "provider_id", "provid", "prov_id"] },
      { key: "lastChangedOn", aliases: ["lastChangedOn", "last_changed_on", "modifiedOn", "modified_on", "moddate", "mod_date", "updated"] },
    ],
  },
];

/** Per-table overrides from bcp-feed.json. */
export interface TableConfig {
  entity?: Entity;
  /** Column names for a headerless file. */
  columns?: string[];
  /** adapter key → actual column name in the file. */
  map?: Record<string, string>;
  delimiter?: string;
  /** Skip the file entirely (audit logs, blobs…). */
  ignore?: boolean;
}

export interface FeedConfig {
  delimiter?: string;
  tables?: Record<string, TableConfig>;
}

export interface Resolution {
  adapter: TableAdapter | null;
  /** adapter key → column name present in the file. */
  map: Record<string, string>;
  missingRequired: string[];
  missingOptional: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function findAdapter(tableName: string, cfg?: TableConfig): TableAdapter | null {
  if (cfg?.entity) return ADAPTERS.find((a) => a.entity === cfg.entity) ?? null;
  return ADAPTERS.find((a) => a.match.test(tableName)) ?? null;
}

export function resolveColumns(tableName: string, columns: string[], cfg?: TableConfig): Resolution {
  const adapter = findAdapter(tableName, cfg);
  if (!adapter) return { adapter: null, map: {}, missingRequired: [], missingOptional: [] };

  const byNorm = new Map<string, string>();
  for (const c of columns) if (!byNorm.has(norm(c))) byNorm.set(norm(c), c);

  const map: Record<string, string> = {};
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const taken = new Set<string>();
  for (const spec of adapter.columns) {
    const explicit = cfg?.map?.[spec.key];
    let found: string | undefined;
    if (explicit) {
      found = columns.find((c) => c === explicit) ?? byNorm.get(norm(explicit));
    } else {
      for (const alias of spec.aliases) {
        const c = byNorm.get(norm(alias));
        if (c && !taken.has(c)) {
          found = c;
          break;
        }
      }
    }
    if (found) {
      map[spec.key] = found;
      taken.add(found);
    } else if (spec.required) {
      missingRequired.push(spec.key);
    } else {
      missingOptional.push(spec.key);
    }
  }
  return { adapter, map, missingRequired, missingOptional };
}

/** Pull adapter keys out of a raw staging row using a resolution map. */
export function pick(raw: Record<string, string | null>, map: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, col] of Object.entries(map)) out[key] = raw[col] ?? null;
  return out;
}

// ---- value coercions for the SQL-flavoured values bcp writes --------------------------

export function toBool(v: string | null | undefined, dflt = true): boolean {
  if (v === null || v === undefined || v === "") return dflt;
  const s = v.trim().toLowerCase();
  if (["1", "true", "t", "y", "yes", "a", "active"].includes(s)) return true;
  if (["0", "false", "f", "n", "no", "i", "inactive", "d", "deleted"].includes(s)) return false;
  return dflt;
}

export function toInt(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v.trim());
  return Number.isInteger(n) ? n : null;
}

export function toNum(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v.trim().replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * `2026-09-01 14:03:00.000`, `2026-09-01`, `9/1/2026`, ISO → ISO string; garbage → null.
 * Zone-less values are taken as UTC (Denticon stores datetimes in UTC), never as the
 * machine's local time — otherwise a `00:00:00` birth date would shift a day depending
 * on where the loader runs.
 */
export function toIso(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = v.trim();
  if (!s || /^(1900-01-01|1753-01-01)/.test(s)) return null; // SQL Server "no date" sentinels
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i);
  if (us) {
    let h = Number(us[4] ?? 0);
    if (us[7]) h = (h % 12) + (us[7].toUpperCase() === "PM" ? 12 : 0);
    const ms = Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), h, Number(us[5] ?? 0), Number(us[6] ?? 0));
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  let iso = s.includes(" ") && !s.includes("T") ? s.replace(" ", "T") : s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(iso)) iso += "Z";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
