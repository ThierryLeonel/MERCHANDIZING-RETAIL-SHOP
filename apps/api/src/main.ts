import { ensureRuntimeSecrets } from "@retail/db";

/**
 * Entry point. Runtime secrets are resolved BEFORE the application (and its
 * config module) is loaded, so a database-stored signing secret can be used
 * when JWT_SECRET is not provided by the environment.
 */
async function main() {
  await ensureRuntimeSecrets();
  const { startServer } = await import("./server");
  await startServer();
}
main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
