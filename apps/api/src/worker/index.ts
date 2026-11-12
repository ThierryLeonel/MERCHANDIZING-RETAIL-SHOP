import { ensureRuntimeSecrets } from "@retail/db";

/** Standalone worker entry point (same secret resolution as the API). */
async function main() {
  await ensureRuntimeSecrets();
  const { runStandaloneWorker } = await import("./main");
  await runStandaloneWorker();
}
main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
