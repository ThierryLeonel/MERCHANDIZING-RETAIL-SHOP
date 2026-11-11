import { Prisma } from "@retail/db";

/**
 * Exact decimal arithmetic for money and quantities (decimal.js via Prisma).
 * Rounding policy (documentation/accounting/policies.md):
 *  - Monetary amounts are rounded HALF-UP to the business currency precision
 *    (XAF = 0 decimals) at line level; document totals are sums of rounded lines.
 *  - Inventory values follow the same precision; unit costs keep 6 decimals
 *    for information only and are never used to re-derive posted values.
 *  - Quantities have 3 decimals.
 */
export type Dec = Prisma.Decimal;
export type DecInput = string | number | Prisma.Decimal;
export const Decimal = Prisma.Decimal;
export const D = (v: DecInput | null | undefined): Dec => new Prisma.Decimal(v ?? 0);
export const ZERO = D(0);

export function money(v: DecInput, decimals: number): Dec {
  return D(v).toDecimalPlaces(decimals, Prisma.Decimal.ROUND_HALF_UP);
}
export function qty(v: DecInput): Dec {
  return D(v).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);
}
export function unitCost(v: DecInput): Dec {
  return D(v).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}
export function sum<T>(items: T[], f: (t: T) => DecInput): Dec {
  return items.reduce((acc, i) => acc.plus(D(f(i))), ZERO);
}
export function minDec(a: Dec, b: Dec): Dec {
  return a.lessThan(b) ? a : b;
}
/** Serialises decimals as strings in JSON responses (never floats). */
export function toJSONSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) => (val instanceof Prisma.Decimal ? val.toString() : val)));
}
