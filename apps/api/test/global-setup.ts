import { config as loadEnv } from "dotenv";
import { join } from "node:path";
import { migrate } from "../../../packages/db/tools/migrate";

export default async function () {
  loadEnv({ path: join(__dirname, "..", "..", "..", ".env"), quiet: true });
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/retail_test";
  if (!/test/i.test(url)) throw new Error(`Refusing to reset non-test database: ${url}`);
  await migrate(url, { reset: true, quiet: true });
}
