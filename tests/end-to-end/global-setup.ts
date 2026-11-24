import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

export default async function globalSetup() {
  const db = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/retail_e2e";
  if (!/e2e|test/i.test(db)) throw new Error("Refusing to reset a non-test database");
  const apiDir = join(__dirname, "../../apps/api");
  execFileSync("node", ["-r", "@swc-node/register", "src/seed/demo-seed.ts", "--reset"], { cwd: apiDir, env: { ...process.env, DATABASE_URL: db, NODE_ENV: "test" }, stdio: "inherit" });

  // Staff must declare opening/closing balances every day (blocking sheet after sign-in). The demo users the
  // tests sign in as have done so for today; cashier.bonapriso has not, for the declaration test itself.
  const { Client } = createRequire(join(apiDir, "package.json"))("pg");
  const c = new Client({ connectionString: db });
  await c.connect();
  try {
    await c.query(`
      WITH u AS (
        SELECT u.id AS uid, u.business_id AS bid,
               COALESCE(u.default_branch_id, (SELECT b.id FROM branches b WHERE b.business_id = u.business_id AND b.kind = 'STORE' ORDER BY b.code LIMIT 1)) AS brid
          FROM users u WHERE u.email LIKE '%@mboa.demo' AND u.email <> 'cashier.bonapriso@mboa.demo'),
      k AS (SELECT unnest(ARRAY['OPENING', 'CLOSING']) AS kind),
      ins AS (
        INSERT INTO daily_declarations (id, business_id, branch_id, user_id, business_date, kind, total_declared, note)
        SELECT gen_random_uuid(), bid, brid, uid, (now() AT TIME ZONE 'Africa/Douala')::date, kind, 0, 'e2e setup' FROM u, k
        RETURNING id, business_id)
      INSERT INTO daily_declaration_lines (id, declaration_id, financial_account_id, declared_amount, system_balance)
      SELECT gen_random_uuid(), ins.id, (SELECT f.id FROM financial_accounts f WHERE f.business_id = ins.business_id AND f.kind = 'BANK' LIMIT 1), 0, 0 FROM ins`);
  } finally { await c.end(); }
}
