import { env } from "../../config/env.js";
import { DenticonClient } from "./client.js";

export * from "./client.js";
export * from "./types.js";
export * from "./mapping.js";
export * from "./dateWindows.js";

/** True when enough credentials are configured to talk to Denticon at all. */
export function isDenticonConfigured(): boolean {
  return Boolean(
    env.DENTICON_SUBSCRIPTION_KEY ||
      (env.DENTICON_LEGACY_AUTH_KEY && env.DENTICON_LEGACY_VENDOR_KEY && env.DENTICON_PGID),
  );
}

let cached: DenticonClient | undefined;

/**
 * Process-wide client built from env. Throws if nothing is configured — callers that
 * want to no-op instead (the ETL worker) should check `isDenticonConfigured()` first.
 */
export function getDenticonClient(): DenticonClient {
  if (cached) return cached;
  if (!isDenticonConfigured()) {
    throw new Error(
      "Denticon is not configured: set DENTICON_SUBSCRIPTION_KEY (see backend/.env.example)",
    );
  }
  cached = new DenticonClient({
    baseUrl: env.DENTICON_API_BASE_URL,
    subscriptionKey: env.DENTICON_SUBSCRIPTION_KEY,
    legacy:
      env.DENTICON_LEGACY_AUTH_KEY && env.DENTICON_LEGACY_VENDOR_KEY && env.DENTICON_PGID
        ? {
            authKey: env.DENTICON_LEGACY_AUTH_KEY,
            vendorKey: env.DENTICON_LEGACY_VENDOR_KEY,
            pgId: env.DENTICON_PGID,
          }
        : undefined,
  });
  return cached;
}
