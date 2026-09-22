import { pool } from "../db/pool.js";
import type { ApplicationType, Lender } from "../types/domain.js";

// Export governance: who pulls each lender's file, how often, and whether it has actually
// arrived. Without this a feed that quietly stops is invisible — the dashboard just shows
// a lender doing less business. Freshness is derived from the import batches rather than
// stored, so it can't drift.
//
// Also carries the evidence for classifying a lender prime / subprime, so the decision can
// be made from observed behaviour instead of assumption (docs/financing-intake.md § Tiers).

export const CADENCE_DAYS: Record<string, number | null> = {
  weekly: 7,
  biweekly: 14,
  monthly: 31,
  quarterly: 92,
  on_request: null, // deliberately no schedule
  none: null, // this lender doesn't produce an export
  unset: null, // nobody has decided yet
};

export type FeedStatus = "ok" | "due" | "overdue" | "never" | "no_schedule";

export interface LenderGovernanceRow {
  code: Lender;
  label: string;
  active: boolean;
  offersPrime: boolean;
  offersSubprime: boolean;
  classificationSource: "unconfirmed" | "inferred_from_data" | "lender_confirmed";
  exportOwner: string | null;
  exportCadence: string;
  exportGraceDays: number;
  portalUrl: string | null;
  /** Most recent import that contained at least one row for this lender. */
  lastImportAt: string | null;
  lastImportFile: string | null;
  daysSinceLastImport: number | null;
  expectedEveryDays: number | null;
  feedStatus: FeedStatus;
  applications: number;
  /** Evidence for the prime/subprime call — see classificationHint. */
  observed: {
    decisioned: number;
    approvalRateOfDecisioned: number | null;
    avgApprovedAmount: number | null;
    medianApprovedAmount: number | null;
    unknownTier: number;
    statedPrime: number;
    statedSubprime: number;
  };
  classificationHint: string;
}

export async function getLenderGovernance(today = new Date()): Promise<LenderGovernanceRow[]> {
  const { rows } = await pool.query<Record<string, string | null>>(
    `WITH last_import AS (
       SELECT fa.lender,
              max(b.imported_at) AS last_at,
              (array_agg(b.source_file ORDER BY b.imported_at DESC))[1] AS last_file
         FROM financing_applications fa
         JOIN staging_financing_csv s ON s.id = fa.staging_row_id
         JOIN financing_import_batches b ON b.id = s.batch_id
        GROUP BY fa.lender
     ),
     obs AS (
       SELECT lender,
              count(*)::int AS applications,
              count(*) FILTER (WHERE status IN ('approved', 'declined'))::int AS decisioned,
              count(*) FILTER (WHERE status = 'approved')::int AS approved,
              avg(approved_amount) FILTER (WHERE status = 'approved')::float AS avg_approved,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY approved_amount)
                FILTER (WHERE status = 'approved')::float AS median_approved,
              count(*) FILTER (WHERE application_type IS NULL)::int AS unknown_tier,
              count(*) FILTER (WHERE application_type = 'primary' AND application_type_source = 'file')::int AS stated_prime,
              count(*) FILTER (WHERE application_type = 'subprime' AND application_type_source = 'file')::int AS stated_subprime
         FROM financing_applications GROUP BY lender
     )
     SELECT l.code::text, l.label, l.active::text, l.offers_prime::text, l.offers_subprime::text,
            l.classification_source, l.export_owner, l.export_cadence, l.export_grace_days::text, l.portal_url,
            li.last_at::text AS last_at, li.last_file,
            coalesce(obs.applications, 0)::text AS applications,
            coalesce(obs.decisioned, 0)::text AS decisioned,
            coalesce(obs.approved, 0)::text AS approved,
            obs.avg_approved::text, obs.median_approved::text,
            coalesce(obs.unknown_tier, 0)::text AS unknown_tier,
            coalesce(obs.stated_prime, 0)::text AS stated_prime,
            coalesce(obs.stated_subprime, 0)::text AS stated_subprime
       FROM lenders l
       LEFT JOIN last_import li ON li.lender = l.code
       LEFT JOIN obs ON obs.lender = l.code
      ORDER BY l.sort_order, l.code`,
  );

  return rows.map((r) => {
    const cadence = r.export_cadence ?? "unset";
    const expected = CADENCE_DAYS[cadence] ?? null;
    const grace = Number(r.export_grace_days ?? 7);
    const lastAt = r.last_at ? new Date(r.last_at) : null;
    const days = lastAt ? Math.floor((today.getTime() - lastAt.getTime()) / 86_400_000) : null;

    let feedStatus: FeedStatus;
    if (cadence === "none") feedStatus = "no_schedule";
    else if (expected === null) feedStatus = lastAt ? "no_schedule" : "never";
    else if (days === null) feedStatus = "never";
    else if (days > expected + grace) feedStatus = "overdue";
    else if (days > expected) feedStatus = "due";
    else feedStatus = "ok";

    const decisioned = Number(r.decisioned);
    const approved = Number(r.approved);
    const observed = {
      decisioned,
      approvalRateOfDecisioned: decisioned > 0 ? Number(((approved / decisioned) * 100).toFixed(1)) : null,
      avgApprovedAmount: r.avg_approved === null ? null : Number(Number(r.avg_approved).toFixed(2)),
      medianApprovedAmount: r.median_approved === null ? null : Number(Number(r.median_approved).toFixed(2)),
      unknownTier: Number(r.unknown_tier),
      statedPrime: Number(r.stated_prime),
      statedSubprime: Number(r.stated_subprime),
    };

    return {
      code: r.code as Lender,
      label: r.label ?? "",
      active: r.active === "true",
      offersPrime: r.offers_prime === "true",
      offersSubprime: r.offers_subprime === "true",
      classificationSource: (r.classification_source ?? "unconfirmed") as LenderGovernanceRow["classificationSource"],
      exportOwner: r.export_owner,
      exportCadence: cadence,
      exportGraceDays: grace,
      portalUrl: r.portal_url,
      lastImportAt: r.last_at,
      lastImportFile: r.last_file,
      daysSinceLastImport: days,
      expectedEveryDays: expected,
      feedStatus,
      applications: Number(r.applications),
      observed,
      classificationHint: classificationHint(observed, r.offers_prime === "true", r.offers_subprime === "true"),
    };
  });
}

/**
 * Turns observed behaviour into a plain-language read on the prime/subprime question.
 * Deliberately conservative: it reports what the data shows and what would settle it, and
 * never silently reclassifies anything — `PUT /api/lenders/:code` is still a human action.
 *
 * The signals, in order of strength:
 *  1. The export itself stating a tier on some rows — strongest, it's the lender's own word.
 *  2. Both tiers stated across rows — the lender demonstrably runs both programs.
 *  3. Approval rate and typical approved amount — prime programs decline more and approve
 *     larger limits; second-look programs approve more people for less.
 */
export function classificationHint(
  o: LenderGovernanceRow["observed"],
  offersPrime: boolean,
  offersSubprime: boolean,
): string {
  const configured = offersPrime && offersSubprime ? "both programs" : offersPrime ? "prime only" : "subprime only";
  const stated = o.statedPrime + o.statedSubprime;
  // A handful of contradicting rows in thousands is a data-entry slip, not evidence that
  // the lender runs a second program — require a real minority before saying "both".
  const minority = Math.min(o.statedPrime, o.statedSubprime);
  const isMeaningful = minority >= 5 && minority / stated >= 0.05;
  if (stated > 0 && isMeaningful) {
    return `Exports state both tiers (${o.statedPrime} prime, ${o.statedSubprime} subprime) — this lender runs both programs. Configured as ${configured}.`;
  }
  if (stated > 0) {
    const dominant = o.statedPrime >= o.statedSubprime ? "prime" : "subprime";
    const odd = minority > 0 ? ` (${minority} ${minority === 1 ? "row says" : "rows say"} the opposite — worth checking)` : "";
    const missing = dominant === "prime" && offersSubprime ? " No subprime row has been seen yet." : dominant === "subprime" && offersPrime ? " No prime row has been seen yet." : "";
    return `The exports state ${dominant} on ${Math.max(o.statedPrime, o.statedSubprime)} of ${stated} rows${odd}. Configured as ${configured}.${missing}`;
  }
  if (o.decisioned < 20) {
    return `Not enough decided applications yet (${o.decisioned}) to read a tier from behaviour. Configured as ${configured} — ask the lender, or import an export with a Program/Tier column.`;
  }
  const rate = o.approvalRateOfDecisioned ?? 0;
  const amount = o.medianApprovedAmount ?? o.avgApprovedAmount ?? 0;
  const looksSubprime = rate >= 55 && amount > 0 && amount < 3000;
  const looksPrime = rate <= 40 && amount >= 3000;
  const shape = `approves ${rate}% of decided applications, typically about $${Math.round(amount).toLocaleString()}`;
  if (looksSubprime) return `Behaviour looks like a second-look program (${shape}). Configured as ${configured}.`;
  if (looksPrime) return `Behaviour looks like a prime program (${shape}). Configured as ${configured}.`;
  return `Behaviour is not clear-cut (${shape}). Configured as ${configured} — the export's own Program column would settle it.`;
}

export async function updateGovernance(
  code: string,
  patch: {
    exportOwner?: string | null;
    exportCadence?: string;
    exportGraceDays?: number;
    portalUrl?: string | null;
    classificationSource?: string;
  },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE lenders SET
       export_owner = CASE WHEN $2::boolean THEN $3 ELSE export_owner END,
       export_cadence = COALESCE($4, export_cadence),
       export_grace_days = COALESCE($5, export_grace_days),
       portal_url = CASE WHEN $6::boolean THEN $7 ELSE portal_url END,
       classification_source = COALESCE($8, classification_source),
       updated_at = now()
     WHERE code::text = $1`,
    [
      code,
      patch.exportOwner !== undefined, patch.exportOwner ?? null,
      patch.exportCadence ?? null,
      patch.exportGraceDays ?? null,
      patch.portalUrl !== undefined, patch.portalUrl ?? null,
      patch.classificationSource ?? null,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Lenders whose export is late — what the data-quality report and any alerting should use. */
export async function overdueFeeds(today = new Date()): Promise<LenderGovernanceRow[]> {
  return (await getLenderGovernance(today)).filter((l) => l.active && (l.feedStatus === "overdue" || l.feedStatus === "never"));
}
