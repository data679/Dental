import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  AUTH0_DOMAIN: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  DENTICON_API_BASE_URL: z.string().optional(),
  DENTICON_API_KEY: z.string().optional(),
});

// Fails fast with a clear message rather than letting a missing var surface later as a
// confusing runtime error. Never log `env` wholesale — it can contain secrets.
export const env = envSchema.parse(process.env);

export type Env = typeof env;
