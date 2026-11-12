import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { pgConnectionConfig, resolveDatabaseUrl } from "./database-url";

const strong = (v?: string) => !!v && v.trim().length >= 32 && !v.startsWith("dev-only");

/**
 * Production only: if neither JWT_SECRET nor APP_KEY provides a strong secret,
 * use (or create once) a random signing secret stored in `system_secrets`, so
 * all instances and restarts share it. Setting JWT_SECRET always takes priority.
 * Must run before the API's config module is loaded.
 */
export async function ensureRuntimeSecrets(log: (m: string) => void = (m) => console.warn(m)): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  if (strong(process.env.JWT_SECRET) || strong(process.env.APP_KEY)) return;
  const url = resolveDatabaseUrl();
  if (!url) return; // config will report the missing database/secret
  const client = new Client(pgConnectionConfig(url));
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS system_secrets (key VARCHAR(64) PRIMARY KEY, value TEXT NOT NULL, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await client.query("INSERT INTO system_secrets (key, value) VALUES ('jwt_secret', $1) ON CONFLICT (key) DO NOTHING", [randomBytes(48).toString("base64url")]);
    const r = await client.query<{ value: string }>("SELECT value FROM system_secrets WHERE key = 'jwt_secret'");
    process.env.JWT_SECRET = r.rows[0].value;
    log("JWT_SECRET is not set in the environment; using the application-generated signing secret stored in the database.");
  } finally {
    await client.end();
  }
}
