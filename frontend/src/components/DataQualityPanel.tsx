import { useState } from "react";
import { Card, Text } from "@tremor/react";
import type { DataQualityCheck, DataQualityReport } from "../lib/api";

// Warehouse-wide list of duplicates and missing information, from GET /api/data-quality.
// Each check is a count with a few examples; clean checks collapse to a single line so the
// panel is short when everything is fine.

const TONE: Record<DataQualityCheck["severity"], { badge: string; label: string }> = {
  error: { badge: "bg-red-100 text-red-800", label: "needs fixing" },
  warning: { badge: "bg-amber-100 text-amber-800", label: "review" },
  info: { badge: "bg-gray-100 text-gray-700", label: "fyi" },
};

export function DataQualityPanel({ report, onRefresh }: { report: DataQualityReport; onRefresh: () => void }) {
  const flagged = report.checks.filter((c) => c.count > 0);
  const clean = report.checks.filter((c) => c.count === 0);
  return (
    <Card className="mb-6">
      <div className="mb-1 flex items-center justify-between">
        <Text className="font-medium">
          Data quality — {flagged.length === 0 ? "nothing flagged" : `${flagged.length} check${flagged.length === 1 ? "" : "s"} flagged`}
        </Text>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>
      <Text className="mb-3 text-xs text-gray-500">
        Duplicates and missing information across everything imported or synced, as of {new Date(report.generatedAt).toLocaleTimeString()}.
      </Text>

      <div className="divide-y divide-gray-100">
        {flagged.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </div>
      {clean.length > 0 && (
        <Text className="mt-3 text-xs text-gray-400">
          Clean: {clean.map((c) => c.title.toLowerCase()).join(" · ")}
        </Text>
      )}
    </Card>
  );
}

function CheckRow({ check }: { check: DataQualityCheck }) {
  const [open, setOpen] = useState(false);
  const tone = TONE[check.severity];
  return (
    <div className="py-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 text-left">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${tone.badge}`}>{tone.label}</span>
        <span className="text-sm font-medium text-gray-800">{check.title}</span>
        <span className="ml-auto text-sm tabular-nums text-gray-600">{check.count.toLocaleString()}</span>
        <span className="text-gray-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-2 pl-1">
          <Text className="mb-2 text-xs text-gray-500">{check.hint}</Text>
          <table className="w-full text-left text-xs">
            <tbody>
              {check.examples.map((e, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="py-1 pr-4 font-mono text-gray-700">{e.label}</td>
                  <td className="py-1 text-gray-600">{e.detail}</td>
                </tr>
              ))}
              {check.count > check.examples.length && (
                <tr className="border-t border-gray-100">
                  <td colSpan={2} className="py-1 text-gray-400">
                    …and {check.count - check.examples.length} more
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
