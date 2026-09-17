import { useEffect, useState } from "react";

// Shown only in the backend-free demo build so nobody mistakes the numbers for a real practice.
export function DemoBanner() {
  const [info, setInfo] = useState<{ generatedAt: string; note: string } | null>(null);
  useEffect(() => {
    import("../lib/staticApi").then((m) => m.snapshotInfo()).then(setInfo).catch(() => undefined);
  }, []);
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-center text-xs text-amber-900">
      <strong>Demo.</strong> {info?.note ?? "Synthetic data."} Numbers are computed in your browser from a snapshot
      {info ? ` taken ${new Date(info.generatedAt).toLocaleDateString()}` : ""}; importing is disabled here — run it
      locally to load real lender exports.
    </div>
  );
}
