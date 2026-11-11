/** API client: bearer token in memory, httpOnly refresh cookie, automatic refresh, structured errors. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any, public requestId?: string) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
export const setAccessToken = (t: string | null) => { accessToken = t; };
export const getAccessToken = () => accessToken;

export async function refresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch("/api/v1/auth/refresh", { method: "POST", credentials: "include" })
      .then(async (r) => { if (!r.ok) return false; accessToken = (await r.json()).access_token; return true; })
      .catch(() => false)
      .finally(() => setTimeout(() => (refreshing = null), 0));
  }
  return refreshing;
}

export function newIdempotencyKey() {
  return crypto.randomUUID();
}

export interface RequestOpts { method?: string; body?: unknown; idempotent?: boolean | string; raw?: boolean; signal?: AbortSignal }

export async function api<T = any>(path: string, opts: RequestOpts = {}): Promise<T> {
  const doFetch = () => {
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (opts.body !== undefined && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (opts.idempotent) headers["Idempotency-Key"] = typeof opts.idempotent === "string" ? opts.idempotent : newIdempotencyKey();
    return fetch(`/api/v1${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers, credentials: "include", signal: opts.signal,
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
    });
  };
  let res = await doFetch();
  if (res.status === 401 && !path.startsWith("/auth/login") && (await refresh())) res = await doFetch();
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new CustomEvent("auth:expired"));
    throw new ApiError(res.status, e.code ?? "HTTP_ERROR", e.message ?? res.statusText, e.details, data?.requestId);
  }
  return data as T;
}

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** Downloads an authenticated CSV export. */
export async function downloadCsv(path: string, filename: string) {
  const res = await api<Response>(path, { raw: true });
  if (!res.ok) throw new ApiError(res.status, "EXPORT_FAILED", "Export failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
