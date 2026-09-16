import "dotenv/config";
import { z } from "zod";

// `.env.example` ships optional keys as `KEY=` — treat an empty string the same as unset so
// a blank line never fails validation (e.g. the URL check on DENTICON_API_BASE_URL).
const blankToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  AUTH0_DOMAIN: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  // Denticon / PlanetDDS REST API (https://developer.planetdds.com). Current API auth is
  // an Azure APIM subscription key; the legacy trio is only for the older v1 API.
  DENTICON_API_BASE_URL: blankToUndefined(z.string().url()).default(
    "https://api.planetdds.com/denticon",
  ),
  DENTICON_SUBSCRIPTION_KEY: blankToUndefined(z.string()),
  DENTICON_LEGACY_AUTH_KEY: blankToUndefined(z.string()),
  DENTICON_LEGACY_VENDOR_KEY: blankToUndefined(z.string()),
  DENTICON_PGID: blankToUndefined(z.string()),
  // Comma-separated Denticon office ids to sync; empty = every office the key can see.
  DENTICON_OFFICE_IDS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  // How far back the first (empty-watermark) sync reaches. Denticon caps each request at
  // 30 days, so this is walked in 30-day windows.
  DENTICON_BACKFILL_DAYS: z.coerce.number().int().positive().default(365),
  // Cron for the recurring incremental sync registered by the worker. Empty = disabled.
  DENTICON_SYNC_CRON: z.string().default("15 * * * *"),
});

// Fails fast with a clear message rather than letting a missing var surface later as a
// confusing runtime error. Never log `env` wholesale — it can contain secrets.
export const env = envSchema.parse(process.env);

export type Env = typeof env;
