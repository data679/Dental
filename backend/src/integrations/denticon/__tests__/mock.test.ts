import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { DenticonApiError, DenticonClient } from "../client.js";
import { generateMockDataset } from "../mock/data.js";
import { createDenticonMockApp } from "../mock/server.js";
import { groupTreatmentPlanItems, rollUpTreatmentPlan } from "../mapping.js";

// Runs the real client against the mock server over HTTP: proves the two agree on the
// contract (envelope, headers, filters, errors) and that the dataset is well-formed.

const REF = new Date("2026-09-15T12:00:00Z");
let server: Server;
let client: DenticonClient;
let bad: DenticonClient;
const quiet = { warn: () => {}, debug: () => {} };

beforeAll(async () => {
  const { app } = createDenticonMockApp({ subscriptionKey: "k", referenceDate: REF, rateLimitEvery: 7 });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/denticon`;
  client = new DenticonClient({ baseUrl, subscriptionKey: "k", sleep: async () => {}, logger: quiet });
  bad = new DenticonClient({ baseUrl, subscriptionKey: "wrong", logger: quiet });
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("mock dataset", () => {
  const data = generateMockDataset({ referenceDate: REF });

  it("is deterministic for a given seed", () => {
    const again = generateMockDataset({ referenceDate: REF });
    expect(again.patients[10]).toEqual(data.patients[10]);
    expect(again.treatmentPlanItems.length).toBe(data.treatmentPlanItems.length);
  });

  it("only contains synthetic contact details", () => {
    for (const p of data.patients) {
      expect(p.email).toMatch(/@example\.com$/);
      expect(p.cellPhone).toMatch(/^555-/);
    }
  });

  it("keeps referential integrity the sync relies on", () => {
    const offices = new Set(data.offices.map((o) => Number(o.officeId)));
    const providers = new Set(data.providers.map((p) => p.providerId));
    const patients = new Set(data.patients.map((p) => p.patientId));
    for (const p of data.patients) {
      expect(offices.has(p.officeId)).toBe(true);
      expect(providers.has(p.preferredProviderId!)).toBe(true);
    }
    for (const i of data.treatmentPlanItems) expect(patients.has(i.patientId)).toBe(true);
    for (const a of data.appointments) expect(patients.has(a.patientId)).toBe(true);
  });

  it("uses only documented status codes and never dates the future as done", () => {
    for (const i of data.treatmentPlanItems) {
      expect(["A", "D", "H", "L", "R", "U"]).toContain(i.treatPlanStatus);
      if (i.isCompleted) expect(Date.parse(i.treatPlanFinishDate!)).toBeLessThanOrEqual(REF.getTime());
      if (i.treatPlanStatus !== "A") expect(i.acceptedDateTime).toBeNull();
      expect(Date.parse(i.lastChangedOn!)).toBeLessThanOrEqual(REF.getTime());
    }
    for (const p of data.patients) expect(Date.parse(p.lastChangedOn!)).toBeLessThanOrEqual(REF.getTime());
  });

  it("rolls up into plans the funnel can use", () => {
    const plans = [...groupTreatmentPlanItems(data.treatmentPlanItems).values()].map(rollUpTreatmentPlan);
    const byStatus = plans.reduce<Record<string, number>>((m, p) => ((m[p.status] = (m[p.status] ?? 0) + 1), m), {});
    expect(byStatus.accepted).toBeGreaterThan(0);
    expect(byStatus.presented).toBeGreaterThan(0);
    expect(byStatus.declined).toBeGreaterThan(0);
    expect(plans.filter((p) => p.completedDate).length).toBeGreaterThan(0);
    for (const p of plans) expect(p.proposedFee).toBeGreaterThan(0);
  });
});

describe("client ↔ mock server", () => {
  it("rejects a wrong subscription key with 401", async () => {
    await expect(bad.getPractice()).rejects.toMatchObject({ status: 401 });
  });

  it("serves practice, offices and providers", async () => {
    const practice = await client.getPractice();
    expect(practice.pgId).toBe(1);
    const offices = [];
    for await (const o of client.listOffices()) offices.push(o);
    expect(offices.map((o) => o.officeName)).toEqual(["West Covina", "Carson", "Downey"]);
    expect(typeof offices[0]!.officeId).toBe("string");
    const providers = [];
    for await (const p of client.listProviders({ OfficeId: 101 })) providers.push(p);
    expect(providers.every((p) => p.officeId === 101)).toBe(true);
    expect(providers.length).toBeGreaterThanOrEqual(4);
  });

  it("filters patients by office + LastChangedOn window and paginates across 429s", async () => {
    const to = REF;
    const from = new Date(REF.getTime() - 30 * 86_400_000);
    const rows = [];
    for await (const p of client.listPatients({
      OfficeId: 101,
      LastChangedOn: { DateFrom: from.toISOString(), DateTo: to.toISOString() },
      PageSize: 25,
    })) rows.push(p);
    expect(rows.length).toBeGreaterThan(25); // more than one page
    for (const p of rows) {
      expect(p.officeId).toBe(101);
      const ms = Date.parse(p.lastChangedOn!);
      expect(ms).toBeGreaterThanOrEqual(from.getTime());
      expect(ms).toBeLessThanOrEqual(to.getTime());
    }
  });

  it("returns problem details for a >30-day range and for a missing plan filter", async () => {
    const bare = new DenticonClient({ baseUrl: (client as any).baseUrl, subscriptionKey: "k", sleep: async () => {}, logger: quiet });
    await expect(
      bare.get("/patients/v0", { LastChangedOn: { DateFrom: "2026-01-01T00:00:00Z", DateTo: "2026-03-01T00:00:00Z" } }),
    ).rejects.toMatchObject({ status: 400, problem: { title: "Bad Request" } } satisfies Partial<DenticonApiError>);
    await expect(bare.get("/clinical/v0/treatment-plans", { OfficeId: 101 })).rejects.toMatchObject({ status: 400 });
    await expect(bare.get("/patients/v0", { OfficeId: 999 })).rejects.toMatchObject({ status: 403 });
  });

  it("serves the same plan items office-wide (minus ucrFee) and per patient (with ucrFee)", async () => {
    const from = new Date(REF.getTime() - 30 * 86_400_000);
    let first;
    for await (const i of client.listTreatmentPlans({
      OfficeId: 102,
      LastChangedOn: { DateFrom: from.toISOString(), DateTo: REF.toISOString() },
      PageSize: 5,
    })) {
      first = i;
      break;
    }
    expect(first).toBeDefined();
    expect("ucrFee" in first!).toBe(false);
    const byPatient = await client.listTreatmentPlansByPatient(first!.patientId);
    const match = byPatient.find((i) => i.treatPlanId === first!.treatPlanId && i.procedureCode === first!.procedureCode);
    expect(match?.ucrFee).toBeGreaterThan(0);
  });

  it("serves appointments incl. the new-patient visit flag", async () => {
    const patient = (await client.getPatient(4000001)).patientId;
    const appts = [];
    for await (const a of client.listAppointments({ PatientId: patient })) appts.push(a);
    expect(appts.some((a) => a.isNewPatient)).toBe(true);
    expect(appts.every((a) => a.patientId === patient)).toBe(true);
  });
});
