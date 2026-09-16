import { describe, expect, it, vi } from "vitest";
import { DenticonApiError, DenticonClient, buildQuery } from "../client.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};
const quiet = { warn: () => {}, debug: () => {} };

describe("buildQuery", () => {
  it("flattens Denticon's nested date-range params and drops empties", () => {
    const qs = buildQuery({
      OfficeId: 101,
      LastChangedOn: { DateFrom: "2026-09-01T00:00:00.000Z", DateTo: "2026-09-15T00:00:00.000Z" },
      PatientId: undefined,
      PageSize: 1000,
    });
    expect(qs).toBe(
      "?OfficeId=101&LastChangedOn.DateFrom=2026-09-01T00%3A00%3A00.000Z&LastChangedOn.DateTo=2026-09-15T00%3A00%3A00.000Z&PageSize=1000",
    );
  });
});

describe("DenticonClient", () => {
  it("sends the subscription key header and hits the versioned path", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { data: { pgId: 7, practiceGroupName: "Care" } } }]);
    const client = new DenticonClient({ subscriptionKey: "sk-test", fetch: fetchImpl, sleep: noSleep, logger: quiet });
    const practice = await client.getPractice();
    expect(practice.practiceGroupName).toBe("Care");
    expect(calls[0]!.url).toBe("https://api.planetdds.com/denticon/practices/v0");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["PDDS-Subscription-Key"]).toBe("sk-test");
    expect(headers["PGID"]).toBeUndefined();
  });

  it("supports the legacy header trio from the public sample code", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = new DenticonClient({
      baseUrl: "http://dev-api.denticon.com/v1/api/",
      legacy: { authKey: "a", vendorKey: "v", pgId: 1 },
      fetch: fetchImpl,
    });
    await client.request("GET", "/Appointment/List/");
    expect(calls[0]!.url).toBe("http://dev-api.denticon.com/v1/api/Appointment/List/");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({ "API-AUTH-KEY": "a", "API-VENDOR-KEY": "v", PGID: "1" });
  });

  it("retries a 429 using the seconds in the body message, then succeeds", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 429, body: { message: "Rate limit is exceeded. Try again in 3 seconds.", statusCode: 429 } },
      { status: 200, body: { data: { patientId: 1 } } },
    ]);
    const sleep = vi.fn(async () => {});
    const client = new DenticonClient({ subscriptionKey: "k", fetch: fetchImpl, sleep, logger: quiet });
    const p = await client.getPatient(1);
    expect(p.patientId).toBe(1);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("throws DenticonApiError with problem details on a 4xx", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 403, body: { title: "Forbidden", status: 403, detail: "Office not in scope" } },
    ]);
    const client = new DenticonClient({ subscriptionKey: "k", fetch: fetchImpl, sleep: noSleep, logger: quiet });
    await expect(client.getPatient(99)).rejects.toMatchObject({
      name: "DenticonApiError",
      status: 403,
      problem: { detail: "Office not in scope" },
    } satisfies Partial<DenticonApiError>);
  });

  it("walks every page of a paginated endpoint", async () => {
    const page = (n: number, ids: number[]) => ({
      status: 200,
      body: { data: ids.map((patientId) => ({ patientId })), pageNumber: n, pageSize: 2, pageCount: ids.length, totalCount: 5, totalPages: 3 },
    });
    const { fetchImpl, calls } = fakeFetch([page(1, [1, 2]), page(2, [3, 4]), page(3, [5])]);
    const client = new DenticonClient({ subscriptionKey: "k", fetch: fetchImpl, sleep: noSleep, logger: quiet });
    const ids: number[] = [];
    for await (const p of client.listPatients({ OfficeId: 1, PageSize: 2 })) ids.push(p.patientId);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("PageNumber"))).toEqual(["1", "2", "3"]);
  });

  it("rejects filter combinations Denticon would 400 on, before making a request", () => {
    const { fetchImpl } = fakeFetch([]);
    const client = new DenticonClient({ subscriptionKey: "k", fetch: fetchImpl });
    expect(() =>
      client.listPatients({
        LastChangedOn: { DateFrom: "2026-01-01T00:00:00Z", DateTo: "2026-03-01T00:00:00Z" },
      }),
    ).toThrow(/30-day/);
    expect(() =>
      client.listPatients({
        LastChangedOn: { DateFrom: "2026-01-01T00:00:00Z", DateTo: "2026-01-02T00:00:00Z" },
        CreatedOn: { DateFrom: "2026-01-01T00:00:00Z", DateTo: "2026-01-02T00:00:00Z" },
      }),
    ).toThrow(/cannot be combined/);
    expect(() => client.listTreatmentPlans({ OfficeId: 1 })).toThrow(/requires/);
  });
});
