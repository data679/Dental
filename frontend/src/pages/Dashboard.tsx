import { useEffect, useState } from "react";
import { Card, Text, Title, Grid } from "@tremor/react";
import {
  getFinanceSummary,
  getFunnelSummary,
  getLenders,
  getLocations,
  type FinanceSummary,
  type FunnelSummaryResponse,
  type LenderOption,
  type LocationOption,
} from "../lib/api";
import { FilterBar, type Filters } from "../components/FilterBar";
import { StatCard } from "../components/StatCard";
import { LenderBarChart } from "../components/LenderBarChart";
import { FunnelChart } from "../components/FunnelChart";
import { MultiLenderCard } from "../components/MultiLenderCard";

function defaultFilters(): Filters {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
    newPatientsOnly: false,
  };
}

export function Dashboard() {
  const [filters, setFilters] = useState<Filters>(defaultFilters());
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [lenders, setLenders] = useState<LenderOption[]>([]);
  const [finance, setFinance] = useState<FinanceSummary | null>(null);
  const [funnel, setFunnel] = useState<FunnelSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unknownTierTotal = lenders.reduce((n, l) => n + (l.unknown_tier ?? 0), 0);

  useEffect(() => {
    getLocations().catch(() => undefined).then((locs) => locs && setLocations(locs));
    getLenders().catch(() => undefined).then((ls) => ls && setLenders(ls));
  }, []);

  useEffect(() => {
    setError(null);
    Promise.all([
      getFinanceSummary({
        locationId: filters.locationId,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        applicationType: filters.applicationType,
        status: filters.status,
        // Omit rather than send "false" — z.coerce.boolean() on the backend treats any
        // non-empty string (including the literal text "false") as true.
        newPatientsOnly: filters.newPatientsOnly ? true : undefined,
      }),
      getFunnelSummary({ locationId: filters.locationId, dateFrom: filters.dateFrom, dateTo: filters.dateTo, lender: filters.lender }),
    ])
      .then(([financeData, funnelData]) => {
        setFinance(financeData);
        setFunnel(funnelData);
      })
      .catch((err: Error) => setError(err.message));
  }, [filters]);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <Title className="mb-4 text-2xl">Finance Report</Title>

      <FilterBar filters={filters} locations={locations} lenders={lenders} onChange={setFilters} />

      {(filters.applicationType === "primary" || filters.applicationType === "subprime") && unknownTierTotal > 0 && (
        <Card className="mb-6 border-l-4 border-amber-400">
          <Text className="text-sm text-amber-900">
            {unknownTierTotal.toLocaleString()} application{unknownTierTotal === 1 ? "" : "s"} on file have an unknown tier and
            are not counted under this filter (
            {lenders
              .filter((l) => (l.unknown_tier ?? 0) > 0)
              .map((l) => `${l.label} ${l.unknown_tier}`)
              .join(", ")}
            ). Their lenders run both programs and the export didn't say which — choose "Unknown tier" to see them.
          </Text>
        </Card>
      )}

      {error && (
        <Card className="mb-6 border-l-4 border-red-500">
          <Text color="red">Could not load report: {error}</Text>
          <Text className="mt-1">
            Is the backend running (npm run dev in backend/) and migrated + seeded (npm run migrate && npm run seed)?
          </Text>
        </Card>
      )}

      {finance && (
        <>
          <Grid numItemsSm={2} numItemsLg={3} className="mb-6 gap-4">
            <StatCard
              title="New Patients"
              value={finance.newPatients.current.toLocaleString()}
              priorLabel={`Prior Period: ${finance.newPatients.prior.toLocaleString()}`}
              pctChange={finance.newPatients.pctChange}
            />
            <StatCard
              title="# of New Patients Applying"
              value={finance.newPatientsApplying.current.toLocaleString()}
              priorLabel={`Prior Period: ${finance.newPatientsApplying.prior.toLocaleString()}`}
              pctChange={finance.newPatientsApplying.pctChange}
            />
            <StatCard
              title="% of New Patients Applying"
              value={
                finance.pctNewPatientsApplying.current !== null
                  ? `${finance.pctNewPatientsApplying.current.toFixed(2)}%`
                  : "–"
              }
              priorLabel={
                finance.pctNewPatientsApplying.prior !== null
                  ? `Prior Period: ${finance.pctNewPatientsApplying.prior.toFixed(2)}%`
                  : "Prior Period: –"
              }
              pctChange={null}
            />
          </Grid>

          <Grid numItemsLg={2} className="mb-6 gap-4">
            <Card>
              <Text className="mb-2 font-medium">Total Applications by Financing Co.</Text>
              <LenderBarChart
                data={finance.applicationsByLender.map((d) => ({ lender: d.lender, value: d.count }))}
                emptyMessage="No financing applications recorded yet. This will populate once financing-application data (manual CSV intake or a lender/Denticon integration) is connected."
              />
            </Card>
            <Card>
              <Text className="mb-2 font-medium">Approval Rates — Current Period</Text>
              <LenderBarChart
                data={finance.approvalRateByLender.map((d) => ({ lender: d.lender, value: d.rate }))}
                valueFormatter={(v) => `${v}%`}
                emptyMessage="No decisioned applications yet, so approval rates can't be calculated. This will populate once financing-application data is connected."
              />
            </Card>
          </Grid>
        </>
      )}

      {finance && <MultiLenderCard summary={finance.multiLender} />}

      {funnel && (
        <Card>
          <Text className="mb-2 font-medium">Patient-to-Financing Funnel</Text>
          <Text className="mb-3 text-xs text-gray-500">
            Patient stages count patients by first visit / plan presented / treatment finished in the
            range. Financing stages count <strong>cases</strong> — one patient's round of applications
            for one treatment — opened in the range: how many were approved by at least one lender,
            and how many were funded. {funnel.financing.cases.toLocaleString()} case
            {funnel.financing.cases === 1 ? "" : "s"} from {funnel.financing.applications.toLocaleString()} application
            {funnel.financing.applications === 1 ? "" : "s"}
            {funnel.financing.multiLenderCases > 0 &&
              ` · ${funnel.financing.multiLenderCases.toLocaleString()} went to more than one lender`}
            . The lender filter keeps cases that applied to that lender.
          </Text>
          <FunnelChart stages={funnel.stages} />
        </Card>
      )}
    </main>
  );
}
