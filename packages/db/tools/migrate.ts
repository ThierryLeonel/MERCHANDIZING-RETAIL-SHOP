/**
 * Applies committed SQL migrations in database/migrations/<name>/migration.sql
 * in lexical order, each in its own transaction, recording them in the same
 * `_prisma_migrations` table format Prisma uses — so `prisma migrate deploy`
 * recognises them on hosts where the Prisma schema engine is available.
 *
 *   pnpm db:migrate            apply pending migrations
 *   pnpm db:reset              DROP the public schema and re-apply (dev/test only)
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: require("node:path").join(__dirname, "..", "..", "..", ".env"), quiet: true });
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

export async function migrate(databaseUrl: string, opts: { reset?: boolean; quiet?: boolean } = {}) {
  const dir = join(__dirname, "..", "..", "..", "database", "migrations");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const log = (m: string) => !opts.quiet && console.log(m);
  try {
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
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
  migrate(url, { reset: process.argv.includes("--reset") }).catch((e) => { console.error(e.message); process.exit(1); });
}
