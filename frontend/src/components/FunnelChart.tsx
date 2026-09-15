import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FunnelStageSummary } from "../lib/api";

const STAGE_LABELS: Record<FunnelStageSummary["stage"], string> = {
  new_patients: "New patients",
  treatment_presented: "Treatment presented",
  applications_submitted: "Application submitted",
  applications_approved: "Application approved",
  funded: "Funded",
  treatment_completed: "Treatment completed",
};

// Ordinal single-hue ramp (blue), darkening down the funnel — see the dataviz skill's
// palette.md. Six stages -> six steps, lightest step kept at/above step 250 so it still
// clears 2:1 against the chart surface.
const STAGE_COLORS = ["#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf"];

const CHROME = {
  gridline: "#e1e0d9",
  axis: "#c3c2b7",
  mutedText: "#898781",
  primaryText: "#0b0b0b",
};

interface FunnelChartProps {
  stages: FunnelStageSummary[];
}

export function FunnelChart({ stages }: FunnelChartProps) {
  const data = stages.map((s) => ({
    stage: STAGE_LABELS[s.stage],
    count: s.count,
  }));

  return (
    <div className="h-80 w-full" role="img" aria-label="Patient-to-financing funnel by stage">
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ left: 24, right: 24 }}>
          <CartesianGrid
            horizontal={false}
            stroke={CHROME.gridline}
            strokeDasharray="0"
          />
          <XAxis
            type="number"
            tick={{ fill: CHROME.mutedText, fontSize: 12 }}
            axisLine={{ stroke: CHROME.axis }}
            tickLine={false}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="stage"
            width={160}
            tick={{ fill: CHROME.primaryText, fontSize: 13 }}
            axisLine={{ stroke: CHROME.axis }}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(11,11,11,0.04)" }}
            formatter={(value: number) => [value.toLocaleString(), "Count"]}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={28}>
            {data.map((_, index) => (
              <Cell key={index} fill={STAGE_COLORS[index % STAGE_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
