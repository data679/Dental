import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Text, Title } from "@tremor/react";
import {
  getImportBatches,
  getUnmatchedApplications,
  importFinancingCsv,
  rematchApplications,
  type ImportBatch,
  type ImportResult,
  type UnmatchedApplication,
} from "../lib/api";

// Manual intake for lender application exports. Upload → immediate per-row outcome →
// history of past uploads → list of applications that couldn't be linked to a patient.
// Lender exports use their own headers; the backend maps them (docs/financing-intake.md),
// and the result shows exactly which header became which column so a bad mapping is
// visible on the spot.

const LENDER_LABELS: Record<string, string> = {
  hfd: "HFD",
  alphaeon: "Alphaeon",
  cherry: "Cherry",
  care_credit: "CareCredit",
  proceed: "Proceed",
  covered_care: "Covered Care",
  eve: "Eve",
  sunbit: "Sunbit",
  fortiva: "Fortiva",
  access: "Access",
};

function fmtDate(value: string | null): string {
  if (!value) return "–";
  return value.slice(0, 10);
}

export function ImportPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [unmatched, setUnmatched] = useState<UnmatchedApplication[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    getImportBatches().then(setBatches).catch(() => undefined);
    getUnmatchedApplications().then(setUnmatched).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await importFinancingCsv(file));
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRematch() {
    setBusy(true);
    try {
      const r = await rematchApplications();
      setError(null);
      setResult(null);
      refresh();
      alert(`Re-checked ${r.checked} applications, linked ${r.matched}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <Title className="mb-1 text-2xl">Import Financing Data</Title>
      <Text className="mb-6 text-gray-500">
        Upload a lender's application export (CSV). Rows are matched to patients by chart number or
        name + date of birth, and re-uploading the same file updates rather than duplicates.{" "}
        <a className="text-blue-600 underline" href="/api/finance/import/template">
          Download the column template
        </a>
        .
      </Text>

      <Card
        className={`mb-6 border-2 border-dashed text-center transition-colors ${dragOver ? "border-blue-500 bg-blue-50" : "border-gray-300"}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFile(e.dataTransfer.files[0]);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv,.txt"
          className="hidden"
          id="csv-file"
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        <label htmlFor="csv-file" className="cursor-pointer">
          <Text className="text-base font-medium text-gray-700">
            {busy ? "Importing…" : "Drop a CSV here or click to choose a file"}
          </Text>
          <Text className="mt-1 text-xs text-gray-500">
            Required columns: lender and status. Everything else (dates, amounts, patient name/DOB,
            practice) is optional but improves matching and the funnel.
          </Text>
        </label>
      </Card>

      {error && (
        <Card className="mb-6 border-l-4 border-red-500">
          <Text color="red">{error}</Text>
        </Card>
      )}

      {result && (
        <Card className="mb-6">
          <Text className="mb-3 font-medium">Import #{result.batchId} result</Text>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Rows" value={result.rowCount} />
            <Stat label="Inserted" value={result.inserted} />
            <Stat label="Updated" value={result.updated} />
            <Stat label="Unmatched patient" value={result.unmatched} tone={result.unmatched ? "warn" : undefined} />
            <Stat label="Rejected" value={result.rejected} tone={result.rejected ? "bad" : undefined} />
          </div>

          {result.errors.length > 0 && (
            <div className="mb-4">
              <Text className="mb-1 text-sm font-medium text-red-700">Rejected rows</Text>
              <ul className="list-inside list-disc text-sm text-gray-700">
                {result.errors.slice(0, 25).map((e) => (
                  <li key={e.row}>
                    Row {e.row}: {e.message}
                  </li>
                ))}
                {result.errors.length > 25 && <li>…and {result.errors.length - 25} more</li>}
              </ul>
            </div>
          )}

          <details>
            <summary className="cursor-pointer text-sm text-gray-600">
              How the file's headers were mapped
              {result.unmappedHeaders.length > 0 && ` (${result.unmappedHeaders.length} ignored)`}
            </summary>
            <table className="mt-2 w-full text-left text-sm">
              <tbody>
                {Object.entries(result.columnMap).map(([header, col]) => (
                  <tr key={header} className="border-t border-gray-100">
                    <td className="py-1 pr-4 text-gray-700">{header}</td>
                    <td className={`py-1 font-mono text-xs ${col ? "text-gray-600" : "text-gray-400"}`}>
                      {col ?? "ignored"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </Card>
      )}

      <Card className="mb-6">
        <Text className="mb-3 font-medium">Import history</Text>
        {batches.length === 0 ? (
          <Text className="text-sm text-gray-500">No imports yet.</Text>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-gray-500">
                <tr>
                  <th className="py-1 pr-4">When</th>
                  <th className="py-1 pr-4">File</th>
                  <th className="py-1 pr-4">By</th>
                  <th className="py-1 pr-4 text-right">Rows</th>
                  <th className="py-1 pr-4 text-right">Inserted</th>
                  <th className="py-1 pr-4 text-right">Updated</th>
                  <th className="py-1 pr-4 text-right">Unmatched</th>
                  <th className="py-1 text-right">Rejected</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-t border-gray-100">
                    <td className="py-1 pr-4 whitespace-nowrap">{new Date(b.imported_at).toLocaleString()}</td>
                    <td className="py-1 pr-4">{b.source_file}</td>
                    <td className="py-1 pr-4">{b.imported_by ?? "–"}</td>
                    <td className="py-1 pr-4 text-right">{b.row_count}</td>
                    <td className="py-1 pr-4 text-right">{b.inserted}</td>
                    <td className="py-1 pr-4 text-right">{b.updated}</td>
                    <td className="py-1 pr-4 text-right">{b.unmatched}</td>
                    <td className={`py-1 text-right ${b.rejected ? "text-red-700" : ""}`}>{b.rejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <Text className="font-medium">Applications not linked to a patient ({unmatched.length})</Text>
          <button
            type="button"
            disabled={busy || unmatched.length === 0}
            onClick={() => void handleRematch()}
            className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Retry matching
          </button>
        </div>
        <Text className="mb-3 text-xs text-gray-500">
          These still count in the funnel, but can't be filtered by provider or flagged as new
          patients. Matching is retried automatically after every Denticon sync.
        </Text>
        {unmatched.length === 0 ? (
          <Text className="text-sm text-gray-500">Everything is linked.</Text>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-gray-500">
                <tr>
                  <th className="py-1 pr-4">Submitted</th>
                  <th className="py-1 pr-4">Lender</th>
                  <th className="py-1 pr-4">Status</th>
                  <th className="py-1 pr-4">Applicant</th>
                  <th className="py-1 pr-4">DOB</th>
                  <th className="py-1 pr-4">Practice</th>
                  <th className="py-1">Why</th>
                </tr>
              </thead>
              <tbody>
                {unmatched.map((u) => (
                  <tr key={u.id} className="border-t border-gray-100">
                    <td className="py-1 pr-4 whitespace-nowrap">{fmtDate(u.submitted_date)}</td>
                    <td className="py-1 pr-4">{LENDER_LABELS[u.lender] ?? u.lender}</td>
                    <td className="py-1 pr-4 capitalize">{u.status}</td>
                    <td className="py-1 pr-4">{[u.first_name, u.last_name].filter(Boolean).join(" ") || "–"}</td>
                    <td className="py-1 pr-4">{fmtDate(u.dob)}</td>
                    <td className="py-1 pr-4">{u.location ?? "–"}</td>
                    <td className="py-1 text-gray-500">{u.match_detail ?? u.match_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "bad" }) {
  const color = tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-gray-900";
  return (
    <div className="rounded-md border border-gray-200 p-3">
      <div className="text-xs uppercase text-gray-500">{label}</div>
      <div className={`text-xl font-semibold ${color}`}>{value.toLocaleString()}</div>
    </div>
  );
}
