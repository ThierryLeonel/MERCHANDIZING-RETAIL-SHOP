import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load the repository-root .env (apps/api/{src|dist}/config → ../../../.env); real env vars take precedence.
for (const p of [resolve(__dirname, "../../../.env"), resolve(process.cwd(), ".env")]) if (existsSync(p)) { loadEnv({ path: p, quiet: true }); break; }

const env = process.env;
const isProduction = env.NODE_ENV === "production";

/**
 * Token signing secret: JWT_SECRET, else APP_KEY (generated automatically by
 * Laravel Cloud and similar platforms). Must be >= 32 characters in production.
 */
function jwtSecret(): string {
  const strong = (v?: string) => !!v && v.trim().length >= 32 && !v.startsWith("dev-only");
  const s = ([env.JWT_SECRET, env.APP_KEY].find(strong) ?? env.JWT_SECRET ?? "").trim();
  if (isProduction && !strong(s)) {
    const seen = Object.keys(env).filter((k) => /SECRET|KEY|JWT/i.test(k)).sort().join(", ") || "none";
    throw new Error(`Set JWT_SECRET (or APP_KEY) to a random string of at least 32 characters for production. Related variables visible to the app: ${seen}`);
  }
  return s || "dev-only-insecure-secret-change-me-000000";
}

export const config = {
  isProduction,
  port: Number(env.PORT ?? env.API_PORT ?? 3000), // PORT is set by most hosting platforms
  corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()),
  jwtSecret: jwtSecret(),
  accessTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
  refreshTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 14),
  storageDir: env.STORAGE_LOCAL_DIR ?? "./storage/uploads",
  uploadMaxBytes: Number(env.UPLOAD_MAX_BYTES ?? 5 * 1024 * 1024),
  mobileMoneyMode: env.MOBILE_MONEY_MODE ?? "simulator",
  paymentTimeoutSeconds: Number(env.PAYMENT_ATTEMPT_TIMEOUT_SECONDS ?? 180),
  webhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? "dev-webhook-secret",
  workerPollMs: Number(env.WORKER_POLL_MS ?? 2000),
};
