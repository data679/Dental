import { Card, Text } from "@tremor/react";
import type { BcpStatus } from "../lib/api";

// Health of the Denticon "Data Download" (BCP) feed, from GET /api/bcp/status. Shows the
// last successful load and what it promoted, the last failure if any, and files waiting in
// the inbox. Nothing to click: the worker sweeps the inbox on a schedule and the CLI
// (`npm run bcp:load`) covers manual loads; see docs/denticon-bcp.md.

export function BcpFeedPanel({ status }: { status: BcpStatus }) {
  const last = status.lastLoad;
  const promoted = last?.tables.filter((t) => !t.blocked) ?? [];
  const blocked = last?.tables.filter((t) => t.blocked) ?? [];
  const tone = !last ? "text-gray-500" : status.lastError && (!last || status.lastError.at > last.finishedAt) ? "text-red-700" : last.stale ? "text-amber-700" : "text-emerald-700";
  const headline = !last
    ? status.configured
      ? "configured, no load yet"
      : "not configured"
    : last.stale
      ? `stale — last load ${new Date(last.finishedAt).toLocaleString()}`
      : `last load ${new Date(last.finishedAt).toLocaleString()}`;

  return (
    <Card className="mb-6">
      <div className="mb-1 flex items-center justify-between">
        <Text className="font-medium">Denticon data download feed</Text>
        <span className={`text-xs font-medium ${tone}`}>{headline}</span>
      </div>
      <Text className="mb-3 text-xs text-gray-500">
        The scheduled full-database export (Utilities → Denticon Download). Loaded from{" "}
        {status.inbox ? <code className="rounded bg-gray-100 px-1">{status.inbox}</code> : "manual runs only (no inbox folder set)"}.
      </Text>

      {status.lastError && (!last || status.lastError.at > last.finishedAt) && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          Load #{status.lastError.id} ({status.lastError.fileName ?? "?"}) failed {new Date(status.lastError.at).toLocaleString()}: {status.lastError.error}
        </div>
      )}

      {status.pendingFiles.length > 0 && (
        <Text className="mb-2 text-xs text-amber-700">Waiting in inbox: {status.pendingFiles.join(", ")}</Text>
      )}

      {last && (
        <div className="grid grid-cols-1 gap-3 text-xs md:grid-cols-2">
          <div>
            <div className="mb-1 font-medium text-gray-700">Promoted from {last.fileName ?? `load #${last.id}`}</div>
            {promoted.length === 0 ? (
              <div className="text-gray-500">nothing — see blocked tables</div>
            ) : (
              <ul className="space-y-0.5 text-gray-600">
                {promoted.map((t) => (
                  <li key={t.table}>
                    <span className="font-mono">{t.table}</span> → {t.entity}: {t.rows.toLocaleString()} rows
                    {t.inserted ? <span className="text-emerald-700"> ({t.inserted.toLocaleString()} new/changed)</span> : <span className="text-gray-400"> (unchanged)</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 font-medium text-gray-700">Landed but not promoted</div>
            {blocked.length === 0 ? (
              <div className="text-gray-500">none</div>
            ) : (
              <ul className="space-y-0.5 text-gray-600">
                {blocked.map((t) => (
                  <li key={t.table}>
                    <span className="font-mono">{t.table}</span>: {t.rows.toLocaleString()} rows — <span className="text-amber-700">{t.blocked}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
