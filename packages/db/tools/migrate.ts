/**
 *   pnpm db:migrate            apply pending migrations
 *   pnpm db:reset              DROP the public schema and re-apply (dev/test only)
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: require("node:path").join(__dirname, "..", "..", "..", ".env"), quiet: true });
import { resolveDatabaseUrl } from "../src/database-url";
import { migrate } from "../src/migrate";

export { migrate };

if (require.main === module) {
  const url = resolveDatabaseUrl();
  if (!url) { console.error("No database configured: set DATABASE_URL or DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD"); process.exit(1); }
  migrate(url, { reset: process.argv.includes("--reset") }).catch((e) => { console.error(e.message); process.exit(1); });
}
