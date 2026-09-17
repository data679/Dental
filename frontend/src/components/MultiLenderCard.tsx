import { Card, Grid, Text } from "@tremor/react";
import { LenderBarChart } from "./LenderBarChart";
import type { MultiLenderSummary } from "../lib/api";
import { LENDER_LABELS } from "../lib/lenders";

// Multi-app view: the practice often soft-checks several lenders at once and lets the
// patient pick from the approvals. This card answers "how often do we shop it around, how
// often does the patient end up with a choice, and when they do, who wins?"

function pct(part: number, whole: number): string {
  return whole ? `${((part / whole) * 100).toFixed(0)}%` : "–";
}

export function MultiLenderCard({ summary: m }: { summary: MultiLenderSummary }) {
  const tiles = [
    { label: "Financing cases", value: m.cases.toLocaleString(), sub: `${m.avgLendersPerCase ?? "–"} lenders per case on average` },
    { label: "Multi-lender cases", value: pct(m.multiLenderCases, m.cases), sub: `${m.multiLenderCases.toLocaleString()} went to 2+ lenders` },
    { label: "Approved by someone", value: pct(m.casesApproved, m.cases), sub: `${m.casesApproved.toLocaleString()} cases with at least one approval` },
    { label: "Patient had a choice", value: pct(m.casesWithMultipleApprovals, m.cases), sub: `${m.casesWithMultipleApprovals.toLocaleString()} cases approved by 2+ lenders` },
    { label: "Funded", value: pct(m.casesFunded, m.cases), sub: `${m.casesFunded.toLocaleString()} cases · ${m.casesFundedFromMultipleApprovals.toLocaleString()} after choosing between offers` },
    {
      label: "Soft vs hard pulls",
      value: m.inquiries.soft + m.inquiries.hard ? `${pct(m.inquiries.soft, m.inquiries.soft + m.inquiries.hard)} soft` : "–",
      sub: m.inquiries.unknown ? `${m.inquiries.unknown.toLocaleString()} applications don't say` : `${m.inquiries.soft} soft · ${m.inquiries.hard} hard`,
    },
  ];

  const wins = m.chosenLenderWhenMultiApproved;

  return (
    <Card className="mb-6">
      <Text className="mb-1 font-medium">Multi-lender applications</Text>
      <Text className="mb-4 text-xs text-gray-500">
        A case is one patient's round of applications for one treatment (same patient, submitted within{" "}
        the grouping window, or sharing a request id). Counting cases instead of applications means a
        patient approved by three lenders and funded by one counts as one success, not two failures.
      </Text>
      <Grid numItemsSm={2} numItemsLg={3} className="mb-5 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-md border border-gray-200 p-3">
            <div className="text-xs uppercase text-gray-500">{t.label}</div>
            <div className="text-xl font-semibold text-gray-900">{t.value}</div>
            <div className="text-xs text-gray-500">{t.sub}</div>
          </div>
        ))}
      </Grid>

      <Text className="mb-1 text-sm font-medium">When the patient had a choice, which lender did they use?</Text>
      <Text className="mb-2 text-xs text-gray-500">
        Only cases approved by two or more lenders. Win rate = times this lender was funded ÷ times it was one
        of the approvals{wins.length ? ` (${wins.map((w) => `${LENDER_LABELS[w.lender] ?? w.lender}: ${w.chosen}/${w.offered}`).join(", ")})` : ""}.
      </Text>
      <LenderBarChart
        data={wins.map((w) => ({ lender: w.lender, value: w.winRate ?? 0 }))}
        valueFormatter={(v) => `${v}%`}
        emptyMessage="No case in this range was approved by more than one lender, so there's no choice to report on yet."
      />
    </Card>
  );
}
