import { Injectable } from "@nestjs/common";
import type { PriceListKind, Tx } from "@retail/db";
import { D, Dec, money, ZERO } from "../../common/money";

/**
 * Price precedence (deterministic, documented in documentation/requirements/pricing.md):
 *   1. Branch price list item of the requested kind (RETAIL/WHOLESALE) for the
 *      sale's branch, effective at the pricing instant.
 *   2. Business-wide price list item of that kind.
 *   3. The variant's own price (wholesale_price for WHOLESALE, falling back to
 *      retail_price).
 * Within a level the item with the latest effective_from wins; ties break on
 * the latest created_at, then id. Effective window is [effective_from, effective_to).
 *
 * Packaging: the unit price is the base-unit price × unit factor.
 * Minimum price: item.min_price, else variant.min_price, × unit factor.
 * Promotions (Phase 3) will apply after this base price and before manual
 * discounts; promotions do not stack unless flagged stackable.
 */
export interface ResolvedPrice { unitPrice: Dec; minPrice: Dec | null; source: string }

@Injectable()
export class PricingService {
  async resolve(tx: Tx, opts: { businessId: string; branchId: string; variantId: string; kind: PriceListKind; at?: Date; unitFactor?: Dec }): Promise<ResolvedPrice> {
    const at = opts.at ?? new Date();
    const factor = opts.unitFactor ?? D(1);
    const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: opts.variantId } });
    const items = await tx.priceListItem.findMany({
      where: {
        variant_id: opts.variantId,
        effective_from: { lte: at },
        OR: [{ effective_to: null }, { effective_to: { gt: at } }],
        price_list: { business_id: opts.businessId, kind: opts.kind, active: true, OR: [{ branch_id: opts.branchId }, { branch_id: null }] },
      },
      include: { price_list: true },
      orderBy: [{ effective_from: "desc" }, { created_at: "desc" }, { id: "desc" }],
    });
    const pick = items.find((i) => i.price_list.branch_id === opts.branchId) ?? items.find((i) => i.price_list.branch_id === null);
    let base: Dec;
    let min: Dec | null;
    let source: string;
    if (pick) {
      base = D(pick.price);
      min = pick.min_price != null ? D(pick.min_price) : variant.min_price != null ? D(variant.min_price) : null;
      source = `${pick.price_list.branch_id ? "BRANCH" : "BUSINESS"}_LIST:${pick.price_list.code}`;
    } else {
      base = opts.kind === "WHOLESALE" && variant.wholesale_price != null ? D(variant.wholesale_price) : D(variant.retail_price);
      min = variant.min_price != null ? D(variant.min_price) : null;
      source = opts.kind === "WHOLESALE" && variant.wholesale_price != null ? "VARIANT_WHOLESALE" : "VARIANT_RETAIL";
    }
    return { unitPrice: base.times(factor), minPrice: min ? min.times(factor) : null, source };
  }
}

export interface LineTaxInput { unitPrice: Dec; quantity: Dec; discount: Dec; taxPercent: Dec; pricesIncludeTax: boolean; decimals: number }
export interface LineTaxResult { gross: Dec; net: Dec; tax: Dec; total: Dec }

/**
 * Line arithmetic. gross = round(unitPrice × qty); discount reduces gross.
 * Tax-exclusive pricing: net = gross − discount, tax = round(net × r / 100).
 * Tax-inclusive pricing: total = gross − discount, tax = round(total × r / (100 + r)), net = total − tax.
 * Rounding is HALF-UP at currency precision, per line.
 */
export function computeLine(i: LineTaxInput): LineTaxResult {
  const gross = money(i.unitPrice.times(i.quantity), i.decimals);
  const afterDiscount = gross.minus(i.discount);
  if (i.pricesIncludeTax) {
    const tax = i.taxPercent.isZero() ? ZERO : money(afterDiscount.times(i.taxPercent).div(i.taxPercent.plus(100)), i.decimals);
    return { gross, net: afterDiscount.minus(tax), tax, total: afterDiscount };
  }
  const tax = money(afterDiscount.times(i.taxPercent).div(100), i.decimals);
  return { gross, net: afterDiscount, tax, total: afterDiscount.plus(tax) };
}
