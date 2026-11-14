import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

// Load the repository-root .env for local runs (real environment variables take precedence).
for (const p of [resolve(__dirname, "../../../.env"), resolve(process.cwd(), ".env")]) if (existsSync(p)) { loadEnv({ path: p, quiet: true }); break; }

/**
 * Entry point.
 *
 * 1. Opens the HTTP port immediately (IPv4 + IPv6) so platform start-up checks
 *    can connect; until the app is ready every request gets 503 "starting".
 * 2. Applies pending database migrations (set MIGRATE_ON_START=false to skip).
 * 3. Resolves runtime secrets BEFORE the app's config module is loaded, so a
 *    database-stored signing secret can be used when JWT_SECRET is not set.
 * 4. Boots the API and hands the already-open socket over to it.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3000);
let handler: Handler = (_req, res) => {
  res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5", "Cache-Control": "no-store" });
  res.end('{"status":"starting"}');
};
const server = createServer((req, res) => handler(req, res));

function listen(host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => { server.off("listening", onListening); reject(e); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function main() {
  const host = process.env.HOST;
  if (host) await listen(host);
  else {
    // "::" accepts both IPv6 and IPv4 connections; fall back to IPv4 only where IPv6 is unavailable.
    try { await listen("::"); } catch (e) {
      if (!["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      await listen("0.0.0.0");
    }
  }
  console.log(`Port ${port} open; starting application...`);

  const db = await import("@retail/db");
  if (process.env.MIGRATE_ON_START !== "false") {
    const url = db.resolveDatabaseUrl();
    if (!url) throw new Error("No database configured: set DATABASE_URL (or DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD)");
    await db.migrate(url);
  }
  await db.ensureRuntimeSecrets();
  const { startServer } = await import("./server");
  handler = await startServer(server);
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
