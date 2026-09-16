import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Lender } from "../lib/api";
import { LENDER_COLORS, LENDER_LABELS } from "../lib/lenders";

const CHROME = {
  gridline: "#e1e0d9",
  axis: "#c3c2b7",
  mutedText: "#898781",
  primaryText: "#0b0b0b",
};

interface LenderBarChartProps {
  data: Array<{ lender: Lender; value: number }>;
  valueFormatter?: (v: number) => string;
  emptyMessage: string;
}

// Shared bar chart for both "Total Applications" and "Approval Rate" by lender. Color is
// assigned by lender identity (fixed categorical order), consistent across both charts —
// see lib/lenders.ts and the dataviz skill's color-formula.md.
export function LenderBarChart({ data, valueFormatter = (v) => String(v), emptyMessage }: LenderBarChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 w-full flex-col items-center justify-center rounded border border-dashed border-gray-300 text-center">
        <Text_ message={emptyMessage} />
      </div>
    );
  }

  const chartData = data.map((d) => ({ ...d, label: LENDER_LABELS[d.lender] ?? d.lender }));

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <BarChart data={chartData} margin={{ top: 24 }}>
          <CartesianGrid vertical={false} stroke={CHROME.gridline} />
          <XAxis
            dataKey="label"
            tick={{ fill: CHROME.primaryText, fontSize: 12 }}
            axisLine={{ stroke: CHROME.axis }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: CHROME.mutedText, fontSize: 12 }}
            axisLine={{ stroke: CHROME.axis }}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip formatter={(value: number) => [valueFormatter(value), "Value"]} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={56} label={{ position: "top", formatter: valueFormatter, fontSize: 12 }}>
            {chartData.map((d) => (
              <Cell key={d.lender} fill={LENDER_COLORS[d.lender] ?? CHROME.axis} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Tiny helper so the empty state doesn't need a separate Tremor import at the call site.
function Text_({ message }: { message: string }) {
  return <p className="max-w-xs px-4 text-sm text-gray-500">{message}</p>;
}
