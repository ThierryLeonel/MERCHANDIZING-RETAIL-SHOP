/** Business-aware formatting (currency precision and timezone come from business settings). */
export interface BusinessFormat { currency_code: string; currency_decimals: number; timezone: string; locale: string }
let fmt: BusinessFormat = { currency_code: "XAF", currency_decimals: 0, timezone: "Africa/Douala", locale: "en" };
export const setBusinessFormat = (f: BusinessFormat) => { fmt = f; };
export const businessFormat = () => fmt;

const localeTag = () => (fmt.locale === "fr" ? "fr-CM" : "en-CM");

/** Formats a decimal string for display only (no arithmetic is done on floats). */
export function money(v: string | number | null | undefined, opts: { symbol?: boolean } = {}) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  const s = new Intl.NumberFormat(localeTag(), { minimumFractionDigits: fmt.currency_decimals, maximumFractionDigits: fmt.currency_decimals }).format(n);
  return opts.symbol === false ? s : `${s} ${fmt.currency_code === "XAF" ? "FCFA" : fmt.currency_code}`;
}
export function qty(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === "") return "—";
  return new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 3 }).format(Number(v));
}
export function dateTime(v: string | Date | null | undefined) {
  if (!v) return "—";
  return new Intl.DateTimeFormat(localeTag(), { timeZone: fmt.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(v));
}
export function date(v: string | Date | null | undefined) {
  if (!v) return "—";
  const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && v.length <= 24 && v.endsWith("T00:00:00.000Z") ? new Date(v.slice(0, 10) + "T12:00:00Z") : new Date(v);
  return new Intl.DateTimeFormat(localeTag(), { timeZone: typeof v === "string" && v.endsWith("T00:00:00.000Z") ? "UTC" : fmt.timezone, dateStyle: "medium" }).format(d);
}
export function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fmt.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function addDays(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
/** Exact integer-string arithmetic helpers for UI totals of entered amounts (server remains authoritative). */
export function sumStrings(values: (string | number)[], decimals = 2) {
  const scale = 10 ** decimals;
  const total = values.reduce<number>((a, v) => a + Math.round(Number(v || 0) * scale), 0) / scale;
  const s = total.toFixed(decimals);
  // strip trailing fractional zeros only (never integer zeros: "5500" stays "5500")
  const out = decimals > 0 ? s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : s;
  return out === "-0" ? "0" : out;
}
export const humanize = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
