import type { DenticonClient } from "../../integrations/denticon/index.js";
import { pool } from "../../db/pool.js";

// Offices → locations, providers → providers, referral types → in-memory lookup. These
// are small, practice-group-wide lists with no change filters, so every run reloads them
// in full — cheap, and it keeps names in sync with Denticon.

export interface ReferenceData {
  /** Denticon officeId → our locations.id */
  locationIdByOffice: Map<number, number>;
  /** Denticon providerId → our providers.id */
  providerIdByDenticon: Map<number, number>;
  /** refTypeCode → human-readable description */
  referralDescriptions: Map<string, string>;
  offices: Array<{ officeId: number; name: string; active: boolean }>;
}

export async function syncReferenceData(client: DenticonClient): Promise<ReferenceData> {
  const offices: ReferenceData["offices"] = [];
  for await (const o of client.listOffices()) {
    const officeId = Number(o.officeId);
    if (!Number.isInteger(officeId)) continue;
    offices.push({ officeId, name: o.officeName?.trim() || `Office ${officeId}`, active: o.officeActive !== false });
  }

  const locationIdByOffice = new Map<number, number>();
  for (const o of offices) {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO locations (name, denticon_office_id) VALUES ($1, $2)
       ON CONFLICT (denticon_office_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [o.name, o.officeId],
    );
    locationIdByOffice.set(o.officeId, Number(rows[0]!.id));
  }

  const providerIdByDenticon = new Map<number, number>();
  let skippedProviders = 0;
  for await (const p of client.listProviders()) {
    const locationId = locationIdByOffice.get(Number(p.officeId));
    if (!locationId) {
      // Provider belongs to an office this key can't see (or an inactive one that isn't
      // returned) — providers.location_id is NOT NULL, so there's nowhere to put it.
      skippedProviders += 1;
      continue;
    }
    const name = formatProviderName(p);
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO providers (name, location_id, denticon_provider_id, active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (denticon_provider_id) DO UPDATE
         SET name = EXCLUDED.name, location_id = EXCLUDED.location_id, active = EXCLUDED.active
       RETURNING id`,
      [name, locationId, p.providerId, p.active !== false],
    );
    providerIdByDenticon.set(p.providerId, Number(rows[0]!.id));
  }
  if (skippedProviders) {
    console.warn(`[denticon] skipped ${skippedProviders} providers with an unknown office`);
  }

  const referralDescriptions = new Map<string, string>();
  for await (const r of client.listReferralTypes()) {
    if (r.refTypeCode) referralDescriptions.set(r.refTypeCode.trim(), r.refTypeDescription?.trim() || r.refTypeCode);
  }

  return { locationIdByOffice, providerIdByDenticon, referralDescriptions, offices };
}

function formatProviderName(p: { firstName?: string | null; lastName?: string | null; title?: string | null; providerId: number }): string {
  const base = [p.firstName, p.lastName].filter((s) => s && s.trim()).join(" ").trim();
  const withTitle = p.title && p.title.trim() ? `${base}, ${p.title.trim()}` : base;
  return withTitle || `Provider ${p.providerId}`;
}
