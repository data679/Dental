import { useEffect, useState } from "react";
import { Card, Text, Metric, Grid, Flex } from "@tremor/react";
import { getFunnelSummary, type FunnelSummaryResponse } from "../lib/api";
import { FunnelChart } from "../components/FunnelChart";

const STAGE_TITLES: Record<string, string> = {
  new_patients: "New patients",
  treatment_presented: "Treatment presented",
  applications_submitted: "Applications submitted",
  applications_approved: "Applications approved",
  funded: "Funded",
  treatment_completed: "Treatment completed",
};

export function Dashboard() {
  const [data, setData] = useState<FunnelSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getFunnelSummary()
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <Flex justifyContent="between" alignItems="center" className="mb-6">
        <div>
          <Text>Dental</Text>
          <Metric>Patient-to-financing funnel</Metric>
        </div>
        {/* TODO: location / provider / date range / lender filters (storyboard step 3) */}
      </Flex>

      {error && (
        <Card className="mb-6 border-l-4 border-red-500">
          <Text color="red">Could not load funnel data: {error}</Text>
          <Text className="mt-1">
            Is the backend running (npm run dev in backend/) and migrated (npm run migrate)?
          </Text>
        </Card>
      )}

      {data && (
        <>
          <Grid numItemsSm={2} numItemsLg={3} className="mb-6 gap-4">
            {data.stages.map((stage) => (
              <Card key={stage.stage}>
                <Text>{STAGE_TITLES[stage.stage] ?? stage.stage}</Text>
                <Metric>{stage.count.toLocaleString()}</Metric>
              </Card>
            ))}
          </Grid>

          <Card>
            <Text className="mb-2">Funnel by stage</Text>
            <FunnelChart stages={data.stages} />
          </Card>
        </>
      )}
    </main>
  );
}
