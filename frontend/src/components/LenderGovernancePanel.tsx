import { useState } from "react";
import { Card, Text } from "@tremor/react";
import { updateLender, type LenderGovernanceResponse, type LenderGovernanceRow } from "../lib/api";

// Who pulls each lender's export, how often it should arrive, whether it has — and the
// evidence behind the lender's prime/subprime classification. Both are decisions a person
// has to make; this makes the unanswered ones visible and editable instead of implicit.

const CADENCES = ["unset", "weekly", "biweekly", "monthly", "quarterly", "on_request", "none"];
const SOURCES: Array<[LenderGovernanceRow["classificationSource"], string]> = [
  ["unconfirmed", "Unconfirmed"],
  ["inferred_from_data", "Inferred from data"],
  ["lender_confirmed", "Confirmed with lender"],
];
const FEED_TONE: Record<LenderGovernanceRow["feedStatus"], { cls: string; label: string }> = {
  ok: { cls: "bg-green-100 text-green-800", label: "up to date" },
  due: { cls: "bg-amber-100 text-amber-800", label: "due" },
  overdue: { cls: "bg-red-100 text-red-800", label: "overdue" },
  never: { cls: "bg-red-100 text-red-800", label: "never received" },
  no_schedule: { cls: "bg-gray-100 text-gray-600", label: "no schedule" },
};

export function LenderGovernancePanel({ data, onChange }: { data: LenderGovernanceResponse; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [owner, setOwner] = useState("");

  async function save(code: string, patch: Record<string, unknown>) {
    setBusy(code);
    setError(null);
    try {
      await updateLender(code, patch);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setEditing(null);
    }
  }

  const s = data.summary;
  const gaps = [
    s.overdue && `${s.overdue} overdue`,
    s.never && `${s.never} never received`,
    s.unassigned && `${s.unassigned} with no owner`,
    s.noCadence && `${s.noCadence} with no cadence`,
    s.unconfirmedTier && `${s.unconfirmedTier} with an unconfirmed tier`,
  ].filter(Boolean);

  return (
    <Card className="mb-6">
      <Text className="mb-1 font-medium">Lender feeds &amp; classification</Text>
      <Text className="mb-3 text-xs text-gray-500">
        {gaps.length ? `Needs attention: ${gaps.join(", ")}.` : "Every active lender has an owner, a cadence and a confirmed tier."}{" "}
        A feed with no owner or cadence can never be reported late.
      </Text>
      {error && <Text className="mb-2 text-sm text-red-700">{error}</Text>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-gray-500">
            <tr>
              <th className="px-2 py-1">Lender</th>
              <th className="px-2 py-1">Programs</th>
              <th className="px-2 py-1">Tier confirmed</th>
              <th className="px-2 py-1">Export owner</th>
              <th className="px-2 py-1">Cadence</th>
              <th className="px-2 py-1">Last export</th>
              <th className="px-2 py-1">Feed</th>
            </tr>
          </thead>
          <tbody>
            {data.lenders.map((l) => {
              const tone = FEED_TONE[l.feedStatus];
              return (
                <tr key={l.code} className="border-t border-gray-100 align-top">
                  <td className="px-2 py-1">
                    <div className="font-medium text-gray-800">{l.label}</div>
                    <div className="max-w-xs text-xs text-gray-500">{l.classificationHint}</div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">
                    {l.offersPrime && l.offersSubprime ? "prime + subprime" : l.offersPrime ? "prime" : "subprime"}
                  </td>
                  <td className="px-2 py-1">
                    <select
                      className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs"
                      disabled={busy === l.code}
                      value={l.classificationSource}
                      onChange={(e) => void save(l.code, { classificationSource: e.target.value })}
                    >
                      {SOURCES.map(([v, label]) => (
                        <option key={v} value={v}>{label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    {editing === l.code ? (
                      <input
                        autoFocus
                        className="w-36 rounded border border-gray-300 px-1 py-0.5 text-xs"
                        value={owner}
                        placeholder="name or role"
                        onChange={(e) => setOwner(e.target.value)}
                        onBlur={() => void save(l.code, { exportOwner: owner.trim() || null })}
                        onKeyDown={(e) => e.key === "Enter" && void save(l.code, { exportOwner: owner.trim() || null })}
                      />
                    ) : (
                      <button
                        type="button"
                        className={`text-xs underline ${l.exportOwner ? "text-gray-700" : "text-amber-700"}`}
                        onClick={() => {
                          setEditing(l.code);
                          setOwner(l.exportOwner ?? "");
                        }}
                      >
                        {l.exportOwner ?? "assign"}
                      </button>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <select
                      className={`rounded border px-1 py-0.5 text-xs ${l.exportCadence === "unset" ? "border-amber-400 text-amber-800" : "border-gray-300"}`}
                      disabled={busy === l.code}
                      value={l.exportCadence}
                      onChange={(e) => void save(l.code, { exportCadence: e.target.value })}
                    >
                      {CADENCES.map((c) => (
                        <option key={c} value={c}>{c.replace("_", " ")}</option>
                      ))}
                    </select>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-xs text-gray-600">
                    {l.lastImportAt
                      ? `${l.daysSinceLastImport}d ago${l.lastImportFile ? ` · ${l.lastImportFile}` : ""}`
                      : "never"}
                  </td>
                  <td className="px-2 py-1">
                    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${tone.cls}`}>
                      {tone.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
