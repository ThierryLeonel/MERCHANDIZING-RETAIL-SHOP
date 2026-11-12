/**
 * Applies committed SQL migrations in database/migrations/<name>/migration.sql in
 * lexical order, each in its own transaction, recording them in Prisma's
 * `_prisma_migrations` table format. Used by `pnpm db:migrate` and at API startup.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { pgConnectionConfig } from "./database-url";

/** Locates database/migrations by walking up from this file (works from src/ and dist/). */
function findMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "database", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Cannot find database/migrations (set MIGRATIONS_DIR)");
}

export async function migrate(databaseUrl: string, opts: { reset?: boolean; quiet?: boolean } = {}) {
  const dir = findMigrationsDir();
  if (/^mysql|^mariadb/i.test(databaseUrl)) throw new Error("DATABASE_URL points to MySQL/MariaDB. Retail Suite requires PostgreSQL 14+ (16 recommended).");
  const client = new Client(pgConnectionConfig(databaseUrl));
  try {
    await client.connect();
  } catch (e) {
    const msg = (e as Error).message;
    const host = (() => { try { const u = new URL(databaseUrl); return `${u.hostname}:${u.port || 5432}`; } catch { return "the configured host"; } })();
    if (/invalid response/i.test(msg)) throw new Error(`The server at ${host} is not PostgreSQL (it may be MySQL/MariaDB or another service). Retail Suite requires PostgreSQL 14+ (16 recommended). Original error: ${msg}`);
    throw new Error(`Cannot connect to PostgreSQL at ${host}: ${msg}`);
  }
  const log = (m: string) => !opts.quiet && console.log(m);
  try {
    // Serialise concurrent runners (several instances starting at once).
    await client.query("SELECT pg_advisory_lock(727274)");
    if (opts.reset) {
      if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset in production");
      await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
      log("Schema reset.");
    }
    await client.query(`CREATE TABLE IF NOT EXISTS _prisma_migrations (
      id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL, logs TEXT, rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_steps_count INTEGER NOT NULL DEFAULT 0)`);
    const applied = new Map<string, string>(
      (await client.query("SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL"))
        .rows.map((r) => [r.migration_name, r.checksum]),
    );
    const names = readdirSync(dir).filter((n) => existsSync(join(dir, n, "migration.sql"))).sort();
    let count = 0;
    for (const name of names) {
      const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) throw new Error(`Migration ${name} was modified after being applied (checksum mismatch)`);
        continue;
      }
      const id = randomUUID();
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES ($1,$2,now(),$3,1)",
          [id, checksum, name],
        );
        await client.query("COMMIT");
        count++;
        log(`Applied ${name}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${(e as Error).message}`);
      }
    }
    log(count ? `${count} migration(s) applied.` : "Database is up to date.");
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    await client.end();
  }
}

