import { useState } from "react";
import { Card, Text } from "@tremor/react";
import type { PracticeRow } from "../lib/api";

// The practice-comparison table: the column set of the OS Dental Finance Report this
// replaces, so the numbers can be read side by side during changeover. Two columns that
// report can't produce are added at the end, behind a toggle: the case-level approval rate
// (share of PATIENTS approved, which the per-application rate hides when a practice
// applies to several lenders per patient) and the case counts behind it.

const money = (v: number | null) => (v === null ? "–" : `$${Math.round(v).toLocaleString()}`);
const pct = (v: number | null) => (v === null ? "–" : `${v.toFixed(1)}%`);
const num = (v: number | null) => (v === null ? "–" : v.toLocaleString());

export function PracticeTable({ rows, total }: { rows: PracticeRow[]; total: PracticeRow }) {
  const [showCases, setShowCases] = useState(false);
  if (rows.length === 0) {
    return (
      <Card className="mb-6">
        <Text className="font-medium">Practice comparison</Text>
        <Text className="mt-2 text-sm text-gray-500">No practices have data in this range.</Text>
      </Card>
    );
  }

  const cols: Array<{ key: string; label: string; get: (r: PracticeRow) => string; align?: "left"; title?: string }> = [
    { key: "name", label: "Practice Name", get: (r) => r.name, align: "left" },
    { key: "np", label: "New Patients", get: (r) => num(r.newPatients), title: "Patients whose first completed visit falls in the date range" },
    { key: "pctApply", label: "% of NP Applying", get: (r) => pct(r.pctNewPatientsApplying), title: "New patients with at least one financing application in the range" },
    { key: "apps", label: "Applications", get: (r) => num(r.applications), title: "Individual applications submitted — a patient shopped to 3 lenders counts 3" },
    { key: "approved", label: "Approved", get: (r) => num(r.approved) },
    { key: "rate", label: "Approval Rate", get: (r) => pct(r.approvalRate), title: "Approved ÷ all applications, matching the OS Dental report. Pending and withdrawn applications are in the denominator." },
    { key: "apprAmt", label: "Approval Amount", get: (r) => money(r.approvalAmount) },
    { key: "avgAppr", label: "Average Approval Amount", get: (r) => money(r.averageApprovalAmount) },
    { key: "coll", label: "Amount Collected From Apps", get: (r) => money(r.collectedFromApps), title: "Funded/used amount on those applications" },
    { key: "pctColl", label: "% Collected From Apps", get: (r) => pct(r.pctCollectedFromApps), title: "Collected ÷ approval amount — how much of the approved credit was actually used" },
    { key: "totColl", label: "Total Collected Amounts", get: (r) => money(r.totalCollected), title: "Practice-wide collections — needs PMS ledger data, not ingested yet" },
  ];
  const caseCols: typeof cols = [
    { key: "cases", label: "Financing cases", get: (r) => num(r.cases), title: "One patient's round of applications for one treatment" },
    { key: "caseRate", label: "Patients approved", get: (r) => pct(r.caseApprovalRate), title: "Share of cases approved by at least one lender — the per-patient view the application-level rate hides" },
    { key: "casesFunded", label: "Cases funded", get: (r) => num(r.casesFunded) },
  ];
  const shown = showCases ? [...cols, ...caseCols] : cols;

  return (
    <Card className="mb-6">
      <div className="mb-1 flex items-center justify-between">
        <Text className="font-medium">Practice comparison</Text>
        <button
          type="button"
          onClick={() => setShowCases((v) => !v)}
          className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          {showCases ? "Hide per-patient columns" : "Show per-patient columns"}
        </button>
      </div>
      <Text className="mb-3 text-xs text-gray-500">
        Same columns as the Finance Report, cohorted on application date. Approval Rate is approved ÷ all
        applications; when a practice applies to several lenders per patient it reads far lower than the share of
        patients who actually got financed — the per-patient columns show that.
      </Text>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-gray-500">
            <tr>
              {shown.map((c) => (
                <th key={c.key} className={`whitespace-nowrap px-2 py-1 ${c.align === "left" ? "" : "text-right"}`} title={c.title}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.locationId ?? r.name} className="border-t border-gray-100">
                {shown.map((c) => (
                  <td key={c.key} className={`whitespace-nowrap px-2 py-1 ${c.align === "left" ? "font-medium text-gray-800" : "text-right tabular-nums"}`}>
                    {c.get(r)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t-2 border-gray-300 font-semibold">
              {shown.map((c) => (
                <td key={c.key} className={`whitespace-nowrap px-2 py-1 ${c.align === "left" ? "" : "text-right tabular-nums"}`}>
                  {c.get(total)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}
