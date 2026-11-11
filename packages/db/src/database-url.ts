/**
 * Resolves the PostgreSQL connection string from DATABASE_URL, DB_URL, or the
 * separate DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME / DB_PASSWORD variables
 * injected by platforms such as Laravel Cloud. Adds sslmode=verify-full for remote
 * hosts unless DB_SSLMODE (or an explicit sslmode in the URL) says otherwise.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.DATABASE_URL || env.DB_URL;
  if (direct) return withSsl(direct, env);
  if (!env.DB_HOST) return undefined;
  if (env.DB_CONNECTION && !/^(pgsql|postgres|postgresql)$/i.test(env.DB_CONNECTION)) {
    throw new Error(`DB_CONNECTION is "${env.DB_CONNECTION}". Retail Suite requires PostgreSQL 14+ (attach a Postgres database).`);
  }
  const user = encodeURIComponent(env.DB_USERNAME ?? env.DB_USER ?? "postgres");
  const pass = env.DB_PASSWORD ? `:${encodeURIComponent(env.DB_PASSWORD)}` : "";
  const port = env.DB_PORT || "5432";
  const db = encodeURIComponent(env.DB_DATABASE ?? env.DB_NAME ?? "postgres");
  return withSsl(`postgresql://${user}${pass}@${env.DB_HOST}:${port}/${db}`, env);
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1|postgres|db|host\.docker\.internal)$/i;

/** Remote hosts get sslmode=verify-full (encrypted, certificate checked) unless the URL or DB_SSLMODE specifies a mode (managed Postgres such as Neon/Laravel Cloud rejects plaintext). */
function withSsl(url: string, env: NodeJS.ProcessEnv): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  if (!/^postgres(ql)?:$/i.test(u.protocol) || u.searchParams.has("sslmode") || u.searchParams.has("ssl")) return url;
  const mode = env.DB_SSLMODE || (LOCAL_HOST.test(u.hostname) ? "" : "verify-full");
  if (mode) u.searchParams.set("sslmode", mode);
  return u.toString();
}
