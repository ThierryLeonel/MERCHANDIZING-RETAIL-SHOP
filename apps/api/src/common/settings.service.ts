import { Injectable } from "@nestjs/common";
import type { Business, Tx } from "@retail/db";
import { notFound } from "./errors";
import { PrismaService } from "./prisma.service";

/** Operational policies stored in businesses.settings (JSON), with defaults. */
export interface BusinessPolicies {
  over_receipt_tolerance_percent: number;
  return_window_days: number;
  held_cart_reserves_stock: boolean;
  default_payment_terms_days: number;
}
export const DEFAULT_POLICIES: BusinessPolicies = {
  over_receipt_tolerance_percent: 0,
  return_window_days: 14,
  held_cart_reserves_stock: false,
  default_payment_terms_days: 30,
};

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async business(businessId: string, tx?: Tx): Promise<Business> {
    const b = await (tx ?? this.prisma.client).business.findUnique({ where: { id: businessId } });
    if (!b) throw notFound("Business");
    return b;
  }
  policies(b: Business): BusinessPolicies {
    return { ...DEFAULT_POLICIES, ...((b.settings as object) ?? {}) };
  }
}

/** Calendar date (YYYY-MM-DD) in the business timezone. */
export function businessDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
/** UTC instant range [start, end) covering the given business-local dates. */
export function businessDayRange(from: string, to: string, timezone: string): { gte: Date; lt: Date } {
  return { gte: localMidnightUtc(from, timezone), lt: localMidnightUtc(addDays(to, 1), timezone) };
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function localMidnightUtc(date: string, timezone: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}
export function dateOnly(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}
