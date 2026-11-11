const SENSITIVE = /pass(word)?|token|secret|pin|authorization|cookie|mfa/i;
/** Deep-copies a value, replacing sensitive keys with "[REDACTED]" for logs and audit data. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}
