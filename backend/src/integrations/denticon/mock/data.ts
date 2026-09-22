import type {
  DenticonAppointment,
  DenticonOffice,
  DenticonPatient,
  DenticonPatientTypeCode,
  DenticonPractice,
  DenticonProcedureCode,
  DenticonProvider,
  DenticonReferralType,
  DenticonTreatmentPlanItem,
} from "../types.js";

// Deterministic, synthetic practice group in the exact shapes the Denticon v0 API returns
// (field names/types from the published OpenAPI definitions — see docs/denticon-api.md).
// Used by the mock server (`npm run denticon:mock`), the client tests, and to generate
// the example payloads in docs/samples/denticon/.
//
// Everything here is invented: names come from short word lists, phones are 555-xxxx,
// emails are @example.com, addresses are fictional. Nothing is derived from real
// patient, provider or referral-partner data. Distributions (status mix, fees, how many
// patients get a plan) are chosen to make the dashboard look plausible, not to reflect
// any real practice's numbers.
//
// Unconfirmed against a live tenant and marked as such: the value sets of
// providerType, sex, relationToResponsibleParty, appointment procedureType, and the
// createdBy/modifiedBy user strings. Everything else follows the documented enums.

export interface MockDataset {
  practice: DenticonPractice;
  offices: DenticonOffice[];
  providers: DenticonProvider[];
  referralTypes: DenticonReferralType[];
  patientTypeCodes: DenticonPatientTypeCode[];
  procedureCodes: DenticonProcedureCode[];
  patients: DenticonPatient[];
  treatmentPlanItems: DenticonTreatmentPlanItem[];
  appointments: DenticonAppointment[];
}

export interface MockDataOptions {
  /** Same seed → identical dataset. */
  seed?: number;
  /** "Now" for the dataset; history is generated relative to this. Defaults to real now. */
  referenceDate?: Date;
  /** Days of history to generate. Default 400 (a bit past the default 365-day backfill). */
  historyDays?: number;
  patientCount?: number;
}

// ---------------------------------------------------------------------------------------
// Seeded PRNG (mulberry32) so the dataset is reproducible run-to-run.
// ---------------------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Weighted pick: [[value, weight], ...] */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of entries) {
      r -= w;
      if (r <= 0) return v;
    }
    return entries[entries.length - 1]![0];
  }
}

// ---------------------------------------------------------------------------------------
// Static word lists (synthetic)
// ---------------------------------------------------------------------------------------

const FIRST_NAMES = [
  "Avery", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Quinn", "Reese", "Rowan", "Sage",
  "Emerson", "Finley", "Harper", "Kendall", "Parker", "Peyton", "Skyler", "Dakota", "Blake", "Hayden",
  "Elliot", "Marlow", "Remy", "Shiloh", "Tatum", "Wren", "Arden", "Bellamy", "Cameron", "Devon",
];
const LAST_NAMES = [
  "Alvarez", "Brooks", "Chen", "Dawson", "Escobar", "Fitzgerald", "Garza", "Huang", "Ibarra", "Jensen",
  "Kimura", "Lindqvist", "Moreno", "Nakamura", "Okafor", "Patel", "Quintero", "Rasmussen", "Singh", "Torres",
  "Ueda", "Vasquez", "Whitfield", "Xu", "Yilmaz", "Zamora", "Holloway", "Mercer", "Navarro", "Sato",
];
const STREETS = ["Maple Ave", "Oak St", "Cedar Ln", "Willow Dr", "Birch Ct", "Elm Blvd", "Pine Way", "Aspen Rd"];
const CITIES: ReadonlyArray<readonly [string, string]> = [
  ["West Covina", "91790"], ["Carson", "90745"], ["Downey", "90241"], ["Whittier", "90601"], ["Torrance", "90503"],
];

// Fifteen offices, sized and named like a real Southern-California DSO so the demo has the
// same shape as the report it replaces (see docs/os-dental-report.md). Weight = relative
// patient volume. Synthetic practice group; only the city names are real places.
const OFFICES: ReadonlyArray<{ id: number; name: string; city: string; zip: string; tz: string; weight: number }> = [
  { id: 101, name: "West Covina", city: "West Covina", zip: "91790", tz: "Pacific Standard Time", weight: 7 },
  { id: 102, name: "Carson", city: "Carson", zip: "90745", tz: "Pacific Standard Time", weight: 8 },
  { id: 103, name: "Downey", city: "Downey", zip: "90241", tz: "Pacific Standard Time", weight: 9 },
  { id: 104, name: "Gardena", city: "Gardena", zip: "90247", tz: "Pacific Standard Time", weight: 7 },
  { id: 105, name: "Whittier", city: "Whittier", zip: "90601", tz: "Pacific Standard Time", weight: 5 },
  { id: 106, name: "Montclair", city: "Montclair", zip: "91763", tz: "Pacific Standard Time", weight: 7 },
  { id: 107, name: "Bixby Knolls", city: "Long Beach", zip: "90807", tz: "Pacific Standard Time", weight: 8 },
  { id: 108, name: "Oxnard", city: "Oxnard", zip: "93030", tz: "Pacific Standard Time", weight: 6 },
  { id: 109, name: "Long Beach", city: "Long Beach", zip: "90802", tz: "Pacific Standard Time", weight: 6 },
  { id: 110, name: "Cerritos", city: "Cerritos", zip: "90703", tz: "Pacific Standard Time", weight: 6 },
  { id: 111, name: "El Segundo", city: "El Segundo", zip: "90245", tz: "Pacific Standard Time", weight: 6 },
  { id: 112, name: "Torrance", city: "Torrance", zip: "90503", tz: "Pacific Standard Time", weight: 6 },
  { id: 113, name: "Santa Barbara", city: "Santa Barbara", zip: "93101", tz: "Pacific Standard Time", weight: 5 },
  { id: 114, name: "Anaheim", city: "Anaheim", zip: "92805", tz: "Pacific Standard Time", weight: 5 },
  { id: 115, name: "Gardena South", city: "Gardena", zip: "90249", tz: "Pacific Standard Time", weight: 7 },
];

const REFERRAL_TYPES: DenticonReferralType[] = [
  { refTypeCode: "WEB", refTypeDescription: "Website / Online Booking" },
  { refTypeCode: "GOOG", refTypeDescription: "Google Ads" },
  { refTypeCode: "SOC", refTypeDescription: "Social Media" },
  { refTypeCode: "PTREF", refTypeDescription: "Patient Referral" },
  { refTypeCode: "INS", refTypeDescription: "Insurance Directory" },
  { refTypeCode: "WALK", refTypeDescription: "Walk-in" },
  { refTypeCode: "ORTHO", refTypeDescription: "Ortho Referral" },
  { refTypeCode: "MAIL", refTypeDescription: "Direct Mail" },
];
const REFERRAL_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ["WEB", 25], ["GOOG", 20], ["PTREF", 18], ["INS", 15], ["SOC", 9], ["WALK", 7], ["ORTHO", 4], ["MAIL", 2],
];

const PATIENT_TYPE_CODES: DenticonPatientTypeCode[] = [
  { code: "00", description: "Standard" },
  { code: "01", description: "New Patient" },
  { code: "CH", description: "Child" },
  { code: "OR", description: "Orthodontic" },
  { code: "EM", description: "Emergency" },
];

/** ADA code, description, fee, production type (1=hygiene, 2=restorative, 3=major, 4=diagnostic) */
const PROCEDURES: ReadonlyArray<readonly [string, string, number, number]> = [
  ["D0120", "Periodic oral evaluation", 65, 4],
  ["D0150", "Comprehensive oral evaluation - new patient", 110, 4],
  ["D0210", "Intraoral complete series of radiographic images", 160, 4],
  ["D0274", "Bitewings - four radiographic images", 75, 4],
  ["D1110", "Prophylaxis - adult", 125, 1],
  ["D1120", "Prophylaxis - child", 90, 1],
  ["D1206", "Topical application of fluoride varnish", 45, 1],
  ["D2140", "Amalgam - one surface, primary or permanent", 180, 2],
  ["D2391", "Resin-based composite - one surface, posterior", 235, 2],
  ["D2392", "Resin-based composite - two surfaces, posterior", 295, 2],
  ["D2740", "Crown - porcelain/ceramic", 1450, 3],
  ["D2750", "Crown - porcelain fused to high noble metal", 1380, 3],
  ["D2950", "Core buildup, including any pins when required", 320, 3],
  ["D3330", "Endodontic therapy, molar tooth", 1250, 3],
  ["D4341", "Periodontal scaling and root planing - four or more teeth per quadrant", 310, 1],
  ["D4910", "Periodontal maintenance", 175, 1],
  ["D6010", "Surgical placement of implant body: endosteal implant", 2400, 3],
  ["D6058", "Abutment supported porcelain/ceramic crown", 1650, 3],
  ["D7140", "Extraction, erupted tooth or exposed root", 260, 3],
  ["D7210", "Extraction, erupted tooth requiring removal of bone", 420, 3],
  ["D8090", "Comprehensive orthodontic treatment of the adult dentition", 5800, 3],
  ["D9110", "Palliative treatment of dental pain", 120, 4],
];

/** Plan "templates": a description and the procedures that typically make it up. */
const PLAN_TEMPLATES: ReadonlyArray<{ description: string; codes: string[]; weight: number }> = [
  { description: "Hygiene recall", codes: ["D0120", "D0274", "D1110"], weight: 25 },
  { description: "New patient exam", codes: ["D0150", "D0210", "D1110", "D1206"], weight: 15 },
  { description: "Restorative", codes: ["D2391", "D2392"], weight: 18 },
  { description: "Crown", codes: ["D2950", "D2740"], weight: 14 },
  { description: "Root canal + crown", codes: ["D3330", "D2950", "D2750"], weight: 8 },
  { description: "Perio therapy", codes: ["D4341", "D4341", "D4910"], weight: 8 },
  { description: "Implant", codes: ["D7210", "D6010", "D6058"], weight: 5 },
  { description: "Extraction", codes: ["D9110", "D7140"], weight: 5 },
  { description: "Ortho", codes: ["D8090"], weight: 2 },
];

const STATUS_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ["A", 46], ["D", 28], ["U", 12], ["H", 8], ["L", 4], ["R", 2],
];

const APPT_STATUSES = [
  "Scheduled", "Confirmed", "Left Message", "In Operatory", "In Reception", "Posted",
  "Missed", "Unconfirmed", "Cancelled", "Checked out",
] as const;

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const atHour = (d: Date, h: number, m = 0) => {
  const x = new Date(d);
  x.setUTCHours(h, m, 0, 0);
  return x;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------------------

export function generateMockDataset(opts: MockDataOptions = {}): MockDataset {
  const rng = new Rng(opts.seed ?? 20260916);
  const now = opts.referenceDate ?? new Date();
  const historyDays = opts.historyDays ?? 400;
  const patientCount = opts.patientCount ?? 1200;
  const epoch = addDays(now, -historyDays);
  const PG_ID = 1;
  const SYSTEM_USER = "API";

  const practice: DenticonPractice = {
    pgId: PG_ID,
    practiceGroupName: "Sample Dental Group",
    addressLine1: "100 Main St",
    addressLine2: "Suite 200",
    city: "West Covina",
    state: "CA",
    zipCode: "91790",
    phone: "555-0100",
    email: "office@example.com",
    cultureId: "en-US",
    createdOn: iso(addDays(epoch, -900)),
    createdBy: "SETUP",
    modifiedOn: iso(addDays(epoch, -30)),
    modifiedBy: "SETUP",
    contactFirstName: "Sam",
    contactLastName: "Admin",
    active: true,
  };

  // Offices ------------------------------------------------------------------------------
  const offices: DenticonOffice[] = OFFICES.map((o, i) => {
    const hours: Record<string, string | null> = {};
    for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday"]) {
      hours[`${day}StartTime`] = "15:00:00"; // 8am PT in UTC, as Denticon returns office hours
      hours[`${day}EndTime`] = "00:00:00";
      hours[`${day}LunchStart`] = "20:00:00";
      hours[`${day}LunchEnd`] = "21:00:00";
    }
    for (const day of ["saturday", "sunday"]) {
      hours[`${day}StartTime`] = null;
      hours[`${day}EndTime`] = null;
      hours[`${day}LunchStart`] = null;
      hours[`${day}LunchEnd`] = null;
    }
    return {
      officeId: String(o.id), // NB: string on this endpoint, integer everywhere else
      officeName: o.name,
      addressLine1: `${200 + i * 100} ${rng.pick(STREETS)}`,
      addressLine2: null,
      city: o.city,
      state: "CA",
      zipcode: o.zip,
      phone1: `555-01${String(10 + i).padStart(2, "0")}`,
      phone2: null,
      fax: `555-02${String(10 + i).padStart(2, "0")}`,
      email: `${o.name.toLowerCase().replace(/\s+/g, "")}@example.com`,
      timeZone: o.tz,
      createdOn: iso(addDays(epoch, -800 + i * 60)),
      createdBy: "SETUP",
      modifiedOn: iso(addDays(epoch, -10)),
      modifiedBy: "SETUP",
      officeActive: true,
      ...hours,
      billingProviderId: 500 + i * 4 + 1,
      billingProviderFirstName: FIRST_NAMES[i]!,
      billingProviderLastName: LAST_NAMES[i]!,
      billingProviderNationalProviderId: `1${String(234567890 + i)}`,
    };
  });

  // Providers ----------------------------------------------------------------------------
  const providers: DenticonProvider[] = [];
  let providerSeq = 501;
  for (const o of OFFICES) {
    const roster: Array<["Dentist" | "Hygienist", string]> = [
      ["Dentist", "DDS"], ["Dentist", "DMD"], ["Hygienist", "RDH"], ["Hygienist", "RDH"],
    ];
    for (const [type, title] of roster) {
      const id = providerSeq++;
      const first = rng.pick(FIRST_NAMES);
      const last = rng.pick(LAST_NAMES);
      providers.push({
        providerId: id,
        providerShortId: `${first[0]}${last.slice(0, 3)}`.toUpperCase(),
        firstName: first,
        lastName: last,
        title,
        phone: `555-03${String(id % 100).padStart(2, "0")}`,
        providerType: type, // value set unconfirmed against a live tenant
        active: true,
        isBookableOnline: type === "Dentist" ? rng.chance(0.7) : true,
        nationalProviderId: `1${String(300000000 + id)}`,
        createdOn: iso(addDays(epoch, -700 + rng.int(0, 300))),
        createdBy: "SETUP",
        modifiedOn: iso(addDays(epoch, -rng.int(0, 60))),
        modifiedBy: SYSTEM_USER,
        licenseNumber: `${title === "RDH" ? "RDH" : "DDS"}${rng.int(10000, 99999)}`,
        officeId: o.id,
      });
    }
  }
  // One inactive provider who left — real tenants have these, and the sync must cope.
  providers.push({
    ...providers[1]!,
    providerId: providerSeq++,
    firstName: "Former",
    lastName: "Associate",
    providerShortId: "FASS",
    active: false,
    isBookableOnline: false,
  });

  const dentistsByOffice = new Map<number, DenticonProvider[]>();
  const hygienistsByOffice = new Map<number, DenticonProvider[]>();
  for (const p of providers) {
    if (!p.active) continue;
    const map = p.providerType === "Hygienist" ? hygienistsByOffice : dentistsByOffice;
    map.set(p.officeId, [...(map.get(p.officeId) ?? []), p]);
  }

  const procedureCodes: DenticonProcedureCode[] = PROCEDURES.map(([code, description, , productionTypeId]) => ({
    code,
    description,
    productionTypeId,
    isActive: true,
  }));
  const feeByCode = new Map(PROCEDURES.map(([code, , fee]) => [code, fee] as const));
  const descByCode = new Map(PROCEDURES.map(([code, desc]) => [code, desc] as const));

  // Patients -----------------------------------------------------------------------------
  // Creation dates skew toward recent months (a growing practice), with ~15% of patients
  // older than the history window so lastChangedOn-based syncs have "existing" patients.
  const patients: DenticonPatient[] = [];
  const treatmentPlanItems: DenticonTreatmentPlanItem[] = [];
  const appointments: DenticonAppointment[] = [];
  let patientSeq = 4000001;
  let rpSeq = 3000001;
  let planSeq = 70001;
  let apptSeq = 880001;
  let apptDetailSeq = 990001;

  for (let i = 0; i < patientCount; i++) {
    const office = rng.weighted<(typeof OFFICES)[number]>(OFFICES.map((o) => [o, o.weight] as const));
    const isLegacy = rng.chance(0.15);
    const createdOn = isLegacy
      ? addDays(epoch, -rng.int(30, 1500))
      : addDays(epoch, Math.floor(historyDays * Math.sqrt(rng.float()))); // skew recent
    const createdAt = atHour(createdOn, rng.int(15, 23), rng.int(0, 59));

    const patientId = patientSeq++;
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const birthYear = now.getUTCFullYear() - rng.weighted([[rng.int(5, 17), 18], [rng.int(18, 39), 34], [rng.int(40, 64), 33], [rng.int(65, 88), 15]]);
    const isChild = now.getUTCFullYear() - birthYear < 18;
    const [city, zip] = rng.pick(CITIES);
    const refTypeCode = rng.weighted(REFERRAL_WEIGHTS);
    const dentist = rng.pick(dentistsByOffice.get(office.id)!);
    const hygienist = rng.pick(hygienistsByOffice.get(office.id)!);

    // ~8% never came in (booked, no first visit yet, or no-showed)
    const firstVisit = rng.chance(0.08) ? null : addDays(createdAt, rng.int(0, 21));
    const firstVisitInPast = firstVisit && firstVisit.getTime() <= now.getTime() ? firstVisit : null;
    let lastVisit = firstVisitInPast;
    const isOrtho = rng.chance(0.04);
    const patientType = isChild ? PATIENT_TYPE_CODES[2]! : isOrtho ? PATIENT_TYPE_CODES[3]! : firstVisitInPast && now.getTime() - firstVisitInPast.getTime() < 90 * DAY ? PATIENT_TYPE_CODES[1]! : PATIENT_TYPE_CODES[0]!;

    // Treatment plans ------------------------------------------------------------------
    // 58% of patients who visited get one plan, a third of those get a second.
    const planCount = firstVisitInPast ? (rng.chance(0.58) ? (rng.chance(0.33) ? 2 : 1) : 0) : 0;
    let latestChange = createdAt;

    for (let n = 1; n <= planCount; n++) {
      const template = rng.weighted(PLAN_TEMPLATES.map((t) => [t, t.weight] as const));
      const proposed = addDays(firstVisitInPast!, n === 1 ? rng.int(0, 3) : rng.int(30, 200));
      if (proposed.getTime() > now.getTime()) continue;
      const status = rng.weighted(STATUS_WEIGHTS);
      const accepted = status === "A" ? addDays(proposed, rng.int(0, 21)) : null;
      const acceptedInPast = accepted && accepted.getTime() <= now.getTime() ? accepted : null;
      const treatPlanId = planSeq++;
      const planCreated = atHour(proposed, rng.int(16, 23));
      const salesPerson = rng.chance(0.6) ? `${dentist.firstName} ${dentist.lastName}` : "Treatment Coordinator";
      const discountPct = rng.chance(0.2) ? rng.pick(["5", "10", "15"]) : "0";

      let itemsCompleted = 0;
      const codes = template.codes;
      codes.forEach((code, idx) => {
        const fee = feeByCode.get(code)!;
        const ucr = round2(fee * 1.15);
        const insurance = rng.chance(0.65) ? round2(fee * rng.pick([0.5, 0.8, 1.0]) * (idx === 0 ? 1 : 0.8)) : 0;
        const estInsurance = Math.min(insurance, fee);
        // Accepted plans get worked through over time; earlier items complete first.
        let finish: Date | null = null;
        let scheduled: Date | null = null;
        if (acceptedInPast) {
          const daysAfterAccept = 7 + idx * rng.int(7, 30);
          const target = addDays(acceptedInPast, daysAfterAccept);
          if (target.getTime() <= now.getTime() && rng.chance(0.85)) {
            finish = target;
            itemsCompleted++;
          } else if (target.getTime() > now.getTime() && rng.chance(0.7)) {
            scheduled = target;
          }
        }
        const modified = finish ?? scheduled ?? acceptedInPast ?? planCreated;
        const modifiedCapped = modified.getTime() > now.getTime() ? acceptedInPast ?? planCreated : modified;
        if (modifiedCapped.getTime() > latestChange.getTime()) latestChange = modifiedCapped;
        if (finish && (!lastVisit || finish.getTime() > lastVisit.getTime())) lastVisit = finish;

        const isMolar = ["D2740", "D2750", "D3330", "D7210", "D6010", "D6058", "D2950"].includes(code);
        const tooth = isMolar || code.startsWith("D23") || code === "D2140" || code === "D7140" ? String(rng.pick([3, 14, 19, 30, 18, 31, 2, 15])) : null;
        const surface = code.startsWith("D23") || code === "D2140" ? rng.pick(["O", "MO", "DO", "MOD"]) : null;

        treatmentPlanItems.push({
          patientId,
          treatPlanStatus: status,
          treatPlanId,
          treatPlanDescription: template.description,
          treatPlanNumber: n,
          treatPlanPhaseId: 1,
          treatPlanPhaseDescription: "Phase 1",
          treatPlanOrderId: idx + 1,
          treatPlanProposedDate: dateOnly(proposed),
          treatPlanAuthDate: estInsurance > 0 && rng.chance(0.5) ? dateOnly(addDays(proposed, 5)) : null,
          treatPlanStartDate: acceptedInPast ? dateOnly(acceptedInPast) : null,
          treatPlanFinishDate: finish ? dateOnly(finish) : null,
          preAuthStatus: estInsurance > 0 ? rng.pick(["PS", "PD", "PU", null]) : null,
          providerId: code.startsWith("D1") || code === "D4910" || code === "D4341" ? hygienist.providerId : dentist.providerId,
          procedureCode: code,
          adaCode: code,
          description: descByCode.get(code)!,
          duration: rng.pick([30, 45, 60, 90]),
          isScheduled: Boolean(scheduled),
          isCompleted: Boolean(finish),
          fee,
          treatPlanSalesPerson: salesPerson,
          estimatedInsurance: estInsurance,
          discount: discountPct,
          estimatedPatient: round2(Math.max(0, fee * (1 - Number(discountPct) / 100) - estInsurance)),
          tooth,
          surface,
          createdOn: iso(planCreated),
          createdBy: dentist.providerShortId!,
          modifiedOn: iso(modifiedCapped),
          modifiedBy: finish ? "FRONTDESK" : dentist.providerShortId!,
          treatPlanScheduledDateTime: scheduled ? iso(atHour(scheduled, 17)) : null,
          treatPlanScheduledDate: scheduled ? dateOnly(scheduled) : null,
          lastChangedOn: iso(modifiedCapped),
          acceptedDateTime: acceptedInPast ? iso(atHour(acceptedInPast, 18, 30)) : null,
          ucrFee: ucr,
        });

        // A completed or scheduled item is an appointment.
        if (finish || scheduled) {
          const when = (finish ?? scheduled)!;
          const apptStart = atHour(when, rng.int(16, 23), rng.pick([0, 30]));
          appointments.push({
            pgId: PG_ID,
            officeId: office.id,
            appointmentId: apptSeq++,
            patientId,
            firstName: first,
            lastName: last,
            cellPhone: `555-${String(1000 + (patientId % 9000)).padStart(4, "0")}`,
            workPhone: null,
            homePhone: null,
            email: `${first}.${last}${patientId % 100}@example.com`.toLowerCase(),
            procedureType: PROCEDURES.find(([c]) => c === code)![3],
            appointmentDate: iso(apptStart),
            appointmentStatus: finish ? rng.pick(["Checked out", "Posted"]) : rng.pick(["Scheduled", "Confirmed", "Unconfirmed"]),
            providerId: code.startsWith("D1") ? hygienist.providerId : dentist.providerId,
            operatoryId: office.id * 10 + rng.int(1, 4),
            appointmentLength: rng.pick([30, 45, 60, 90]),
            isNewPatient: false,
            isAsap: rng.chance(0.05),
            createdOn: iso(planCreated),
            createdBy: "FRONTDESK",
            modifiedOn: iso(finish ? atHour(finish, 23) : planCreated),
            modifiedBy: "FRONTDESK",
            fee,
            procedureCodes: [
              { appointmentDetailId: apptDetailSeq++, procedureCode: code, description: descByCode.get(code)!, treatmentPlanId: treatPlanId, tooth, surface },
            ],
            isCancelled: false,
            isMissed: false,
            isBlock: false,
            isTransaction: Boolean(finish),
            patientTypeCode: patientType.code,
            lastChangedOn: iso(finish ? atHour(finish, 23) : planCreated),
            statusHistory: [],
          });
        }
      });
      void itemsCompleted;
    }

    // First-visit appointment (the "new patient" visit) — or a cancelled/missed one for
    // the patients who never showed.
    {
      const when = firstVisit ?? addDays(createdAt, rng.int(1, 14));
      const showed = Boolean(firstVisitInPast);
      const inFuture = when.getTime() > now.getTime();
      appointments.push({
        pgId: PG_ID,
        officeId: office.id,
        appointmentId: apptSeq++,
        patientId,
        firstName: first,
        lastName: last,
        cellPhone: `555-${String(1000 + (patientId % 9000)).padStart(4, "0")}`,
        workPhone: null,
        homePhone: null,
        email: `${first}.${last}${patientId % 100}@example.com`.toLowerCase(),
        procedureType: 4,
        appointmentDate: iso(atHour(when, rng.int(16, 23), rng.pick([0, 30]))),
        appointmentStatus: inFuture ? "Scheduled" : showed ? "Checked out" : rng.pick(["Missed", "Cancelled"]),
        providerId: dentist.providerId,
        operatoryId: office.id * 10 + rng.int(1, 4),
        appointmentLength: 60,
        isNewPatient: true,
        isAsap: false,
        createdOn: iso(createdAt),
        createdBy: rng.pick(["FRONTDESK", "ONLINE"]),
        modifiedOn: iso(inFuture ? createdAt : atHour(when, 23)),
        modifiedBy: "FRONTDESK",
        fee: 110 + 160,
        procedureCodes: [
          { appointmentDetailId: apptDetailSeq++, procedureCode: "D0150", description: descByCode.get("D0150")!, treatmentPlanId: null, tooth: null, surface: null },
          { appointmentDetailId: apptDetailSeq++, procedureCode: "D0210", description: descByCode.get("D0210")!, treatmentPlanId: null, tooth: null, surface: null },
        ],
        isCancelled: !inFuture && !showed && rng.chance(0.5),
        isMissed: !inFuture && !showed,
        isBlock: false,
        isTransaction: showed,
        patientTypeCode: patientType.code,
        lastChangedOn: iso(inFuture ? createdAt : atHour(when, 23)),
        statusHistory: [],
      });
      if (!inFuture && atHour(when, 23).getTime() > latestChange.getTime()) latestChange = atHour(when, 23);
    }

    const modifiedOn = latestChange;
    const active = !(isLegacy && rng.chance(0.2));
    patients.push({
      pgId: PG_ID,
      patientId,
      responsiblePartyId: isChild ? rpSeq - 1 : rpSeq++,
      relationToResponsibleParty: isChild ? "Child" : "Self",
      officeId: office.id,
      chartNo: String(patientId),
      firstName: first,
      lastName: last,
      middleInitial: rng.chance(0.4) ? rng.pick("ABCDEJKLMRST".split("")) : null,
      nickname: null,
      email: `${first}.${last}${patientId % 100}@example.com`.toLowerCase(),
      addressLine1: `${rng.int(100, 9999)} ${rng.pick(STREETS)}`,
      addressLine2: rng.chance(0.15) ? `Apt ${rng.int(1, 40)}` : null,
      city,
      state: "CA",
      zip,
      birthDate: `${birthYear}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}T00:00:00Z`,
      sex: rng.pick(["F", "M"]),
      pronouns: null,
      pronounId: null,
      preferredLanguage: rng.weighted([["English", 75], ["Spanish", 22], ["Tagalog", 3]]),
      homePhone: null,
      workPhone: null,
      cellPhone: `555-${String(1000 + (patientId % 9000)).padStart(4, "0")}`,
      active,
      firstVisitDate: firstVisitInPast ? iso(atHour(firstVisitInPast, 17)) : null,
      lastVisitDate: lastVisit ? iso(atHour(lastVisit, 17)) : null,
      createdOn: iso(createdAt),
      createdBy: refTypeCode === "WEB" ? "ONLINE" : "FRONTDESK",
      modifiedOn: iso(modifiedOn),
      modifiedBy: SYSTEM_USER,
      isCorrespondence: true,
      isOrtho,
      noAutoEmail: false,
      noAutoSMS: false,
      noVoice: false,
      isHIPAA: true,
      refTypeCode,
      referredById: refTypeCode === "PTREF" && i > 0 ? patients[rng.int(0, i - 1)]!.patientId : null,
      preferredProviderId: dentist.providerId,
      preferredHygienistId: hygienist.providerId,
      patientTypeCode: patientType.code,
      patientTypeDescription: patientType.description,
      smsOptIn: rng.chance(0.85),
      emailOptIn: rng.chance(0.7),
      voiceOptIn: rng.chance(0.5),
      lastChangedOn: iso(modifiedOn),
    });
  }

  // A patient whose office isn't in the group's list (403 territory on the real API) is
  // not generated — the real API simply won't return them.

  return {
    practice,
    offices,
    providers,
    referralTypes: REFERRAL_TYPES,
    patientTypeCodes: PATIENT_TYPE_CODES,
    procedureCodes,
    patients,
    treatmentPlanItems,
    appointments,
  };
}
