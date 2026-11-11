import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function globalSetup() {
  const db = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/retail_e2e";
  if (!/e2e|test/i.test(db)) throw new Error("Refusing to reset a non-test database");
  execFileSync("node", ["-r", "@swc-node/register", "src/seed/demo-seed.ts", "--reset"], { cwd: join(__dirname, "../../apps/api"), env: { ...process.env, DATABASE_URL: db, NODE_ENV: "test" }, stdio: "inherit" });
}
