/**
 * Resolves the PostgreSQL connection string from DATABASE_URL, DB_URL, or the
 * separate DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME / DB_PASSWORD variables
 * injected by platforms such as Laravel Cloud. Adds sslmode=require for remote
 * hosts unless DB_SSLMODE (or an explicit sslmode in the URL) says otherwise.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.DATABASE_URL || env.DB_URL;
  if (direct) return direct;
  if (!env.DB_HOST) return undefined;
  if (env.DB_CONNECTION && !/^(pgsql|postgres|postgresql)$/i.test(env.DB_CONNECTION)) {
    throw new Error(`DB_CONNECTION is "${env.DB_CONNECTION}". Retail Suite requires PostgreSQL 14+ (attach a Postgres database).`);
  }
  const user = encodeURIComponent(env.DB_USERNAME ?? env.DB_USER ?? "postgres");
  const pass = env.DB_PASSWORD ? `:${encodeURIComponent(env.DB_PASSWORD)}` : "";
  const port = env.DB_PORT || "5432";
  const db = encodeURIComponent(env.DB_DATABASE ?? env.DB_NAME ?? "postgres");
  const local = /^(localhost|127\.0\.0\.1|postgres|db)$/i.test(env.DB_HOST);
  const ssl = env.DB_SSLMODE ?? (local ? "" : "require");
  return `postgresql://${user}${pass}@${env.DB_HOST}:${port}/${db}${ssl ? `?sslmode=${ssl}` : ""}`;
}
