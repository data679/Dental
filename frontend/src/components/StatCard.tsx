import { Card, Text, Metric } from "@tremor/react";

interface StatCardProps {
  title: string;
  value: string;
  priorLabel: string;
  pctChange: number | null;
}

// Status color (good/critical) is never the only signal — paired with an arrow glyph +
// "vs prior period" text, per the dataviz skill's status-palette rule.
export function StatCard({ title, value, priorLabel, pctChange }: StatCardProps) {
  const isDown = pctChange !== null && pctChange < 0;
  const isUp = pctChange !== null && pctChange > 0;

  return (
    <Card>
      <Text>{title}</Text>
      <Metric>{value}</Metric>
      <Text className="mt-2 text-xs text-gray-500">{priorLabel}</Text>
      {pctChange !== null ? (
        <Text className={`text-xs font-medium ${isDown ? "text-red-600" : isUp ? "text-green-700" : "text-gray-500"}`}>
          {isDown ? "▼" : isUp ? "▲" : "–"} {Math.abs(pctChange).toFixed(1)}% vs prior period
        </Text>
      ) : (
        <Text className="text-xs text-gray-400">No prior-period data</Text>
      )}
    </Card>
  );
}
