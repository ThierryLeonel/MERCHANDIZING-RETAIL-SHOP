import { Injectable, Logger } from "@nestjs/common";
import type { Business, PaymentMethod, Prisma, PriceListKind, Sale, Tx } from "@retail/db";
import { randomBytes } from "node:crypto";
import { AuthContext, assertBranch, assertCan, branchFilter, can } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { ApprovalRequiredError, conflict, forbidden, invalid, notFound } from "../../common/errors";
import { FinanceService } from "../finance/finance.service";
import { D, Dec, money, qty, sum, unitCost, ZERO } from "../../common/money";
import { PageQuery, pageArgs, paginate } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { SequenceService } from "../../common/sequence.service";
import { addDays, businessDate, SettingsService } from "../../common/settings.service";
import { config } from "../../config";
import { PostingLine, PostingService } from "../accounting/posting.service";
import { ApprovalsService } from "../approvals/approvals.service";
import { computeLine, PricingService } from "../catalogue/pricing.service";
import { StockLedgerService } from "../inventory/stock-ledger.service";
import { PaymentAdapterRegistry } from "./payment-adapters";

export interface CheckoutLine {
  variant_id: string;
  quantity: string | number;
  unit_id?: string;
  discount_amount?: string | number;
  discount_percent?: string | number;
  discount_reason?: string;
  override_price?: string | number;
  approval_request_id?: string;
  serial_number_id?: string;
}
export interface CheckoutPayment {
  method: PaymentMethod;
  amount: string | number;
  amount_tendered?: string | number;
  financial_account_id?: string;
  payer_phone?: string;
  reference?: string; // manual confirmation reference (terminal approval code, transfer ref)
  approval_request_id?: string; // credit exception
}
export interface CheckoutInput {
  branch_id: string;
  register_id: string;
  customer_id?: string;
  price_list_kind?: PriceListKind;
  lines: CheckoutLine[];
  payments: CheckoutPayment[];
  notes?: string;
  exchange_return_id?: string;
}
export interface ReturnInput {
  sale_id: string;
  register_id?: string;
  reason: string;
  refund_method: PaymentMethod;
  financial_account_id?: string;
  reference?: string;
  approval_request_id?: string;
  lines: { sale_line_id: string; quantity: string | number; condition: "SELLABLE" | "QUARANTINED" | "DAMAGED" | "SUPPLIER_RETURN_PENDING" | "NON_RESTOCKABLE"; inspection_notes?: string }[];
}

const ELECTRONIC: PaymentMethod[] = ["MOBILE_MONEY", "CARD", "BANK_TRANSFER"];

export interface CartQuote {
  lines: { variant_id: string; sku: string; description: string; quantity: Dec; unit_price: Dec; discount_amount: Dec; net_amount: Dec; tax_amount: Dec; line_total: Dec; needs_approval: string | null; min_price: Dec | null }[];
  gross_amount: Dec; discount_total: Dec; net_amount: Dec; tax_total: Dec; total: Dec; price_list_kind: string;
}


@Injectable()
export class SalesService {
  private log = new Logger("Sales");
  constructor(
    private prisma: PrismaService, private seq: SequenceService, private audit: AuditService, private settings: SettingsService,
    private posting: PostingService, private ledger: StockLedgerService, private pricing: PricingService, private approvals: ApprovalsService,
    private adapters: PaymentAdapterRegistry, private finance: FinanceService,
  ) {}

  async openSessionFor(tx: Tx, auth: AuthContext, registerId: string, branchId: string) {
    const register = await tx.cashRegister.findFirst({ where: { id: registerId, business_id: auth.businessId, active: true } });
    if (!register || register.branch_id !== branchId) throw invalid("REGISTER_INVALID", "Register not found at this branch");
    const session = await tx.cashierSession.findFirst({ where: { register_id: registerId, status: "OPEN" } });
    if (!session) throw invalid("NO_OPEN_SESSION", "Open a cashier session on this register before selling");
    if (session.user_id !== auth.userId) throw forbidden("This register's session belongs to another cashier");
    return { register, session };
  }

  private async defaultAccount(tx: Tx, businessId: string, branchId: string, method: PaymentMethod, tillAccountId: string) {
    if (method === "CASH") return tillAccountId;
    const kind = method === "MOBILE_MONEY" ? "MOBILE_MONEY" : method === "CARD" ? "CLEARING" : "BANK";
    const fa = (await tx.financialAccount.findFirst({ where: { business_id: businessId, kind, active: true, branch_id: branchId } }))
      ?? (await tx.financialAccount.findFirst({ where: { business_id: businessId, kind, active: true, branch_id: null } }));
    if (!fa) throw invalid("NO_COLLECTION_ACCOUNT", `No ${kind.toLowerCase().replace("_", " ")} financial account configured for ${method}`);
    return fa.id;
  }

  /** Outstanding credit (receivable) across a customer's completed sales. */
  async customerOutstanding(tx: Tx, customerId: string): Promise<Dec> {
    const r = await tx.$queryRaw<{ o: Dec | null }[]>`SELECT SUM(credit_amount - credit_settled) AS o FROM sales WHERE customer_id = ${customerId}::uuid AND status = 'COMPLETED'`;
    return D(r[0]?.o ?? 0);
  }

  // ------------------------------------------------------------ checkout ----
  /** Server-side cart pricing for the POS (no writes, approvals not consumed). */
  async quote(auth: AuthContext, input: Omit<CheckoutInput, "payments">) {
    return this.checkout(auth, { ...input, payments: [] }, undefined, { dryRun: true }) as unknown as Promise<CartQuote>;
  }

  async checkout(auth: AuthContext, input: CheckoutInput, idempotencyKey?: string, opts: { dryRun?: boolean } = {}) {
    assertBranch(auth, input.branch_id);
    if (!input.lines?.length) throw invalid("CART_EMPTY", "The cart is empty");
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    const result = await this.prisma.tx(async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.sale.findUnique({ where: { business_id_idempotency_key: { business_id: auth.businessId, idempotency_key: idempotencyKey } } });
        if (existing) return { sale: existing, replay: true };
      }
      const { register, session } = await this.openSessionFor(tx, auth, input.register_id, input.branch_id);
      let customer = null;
      if (input.customer_id) {
        customer = await tx.customer.findFirst({ where: { id: input.customer_id, business_id: auth.businessId, active: true } });
        if (!customer) throw notFound("Customer");
      }
      let kind: PriceListKind = input.price_list_kind ?? "RETAIL";
      if (customer?.customer_group_id && !input.price_list_kind) {
        const g = await tx.customerGroup.findUnique({ where: { id: customer.customer_group_id } });
        kind = g?.price_list_kind ?? "RETAIL";
      }
      const discountPolicy = await this.approvals.policy(tx, auth.businessId, "DISCOUNT");

      // ---- price lines on the server (client prices are never trusted)
      const priced: (Prisma.SaleLineCreateWithoutSaleInput & { _variant: any; _tax: any })[] = [];
      let lineNo = 0;
      for (const l of input.lines) {
        const variant = await tx.productVariant.findFirst({ where: { id: l.variant_id, business_id: auth.businessId }, include: { product: true, unit_conversions: true } });
        if (!variant || variant.status !== "ACTIVE") throw invalid("VARIANT_UNAVAILABLE", "Product is not available for sale");
        let factor = D(1);
        let unitCode = (await tx.unit.findUnique({ where: { id: variant.product.base_unit_id } }))?.code ?? "PCS";
        if (l.unit_id && l.unit_id !== variant.product.base_unit_id) {
          const c = variant.unit_conversions.find((x) => x.unit_id === l.unit_id && x.is_sellable);
          if (!c) throw invalid("UNIT_NOT_SELLABLE", `${variant.sku} cannot be sold in that unit`);
          factor = D(c.factor);
          unitCode = (await tx.unit.findUnique({ where: { id: l.unit_id } }))?.code ?? unitCode;
        }
        const q = qty(l.quantity);
        if (!q.gt(0)) throw invalid("INVALID_QUANTITY", "Quantity must be positive");
        if (variant.product.track_serials && (!l.serial_number_id || !q.times(factor).equals(1))) {
          throw invalid("SERIAL_REQUIRED", `${variant.sku} is serial-tracked: scan one serial number per line`);
        }
        const resolved = await this.pricing.resolve(tx, { businessId: auth.businessId, branchId: input.branch_id, variantId: variant.id, kind, unitFactor: factor });
        let unitPrice = money(resolved.unitPrice, Math.max(dec, 2));
        let source = resolved.source;
        let needsOverrideApproval = false;
        if (l.override_price != null) {
          assertCan(auth, "pos.price_override", "Price overrides require pos.price_override");
          unitPrice = money(l.override_price, Math.max(dec, 2));
          source = "MANUAL_OVERRIDE";
        }
        const gross = money(unitPrice.times(q), dec);
        let discount = ZERO;
        if (l.discount_percent != null) discount = money(gross.times(D(l.discount_percent)).div(100), dec);
        if (l.discount_amount != null) discount = discount.plus(money(l.discount_amount, dec));
        if (discount.lt(0) || discount.greaterThan(gross)) throw invalid("INVALID_DISCOUNT", "Discount must be between zero and the line amount");
        if (discount.gt(0)) {
          assertCan(auth, "pos.discount", "Discounts require pos.discount");
          if (!l.discount_reason?.trim()) throw invalid("DISCOUNT_REASON_REQUIRED", `Enter a reason for the discount on ${variant.sku}`);
        }
        const effectiveUnit = gross.minus(discount).div(q);
        if (resolved.minPrice && effectiveUnit.lessThan(resolved.minPrice)) needsOverrideApproval = true;
        const discountPct = gross.isZero() ? ZERO : discount.div(gross).times(100);
        const needsDiscountApproval = discount.gt(0) && !!discountPolicy?.enabled && discountPolicy.threshold_percent != null && discountPct.greaterThan(discountPolicy.threshold_percent);
        let approvalId: string | null = null;
        let pendingApproval: string | null = null;
        if ((needsOverrideApproval || needsDiscountApproval) && opts.dryRun) {
          pendingApproval = needsOverrideApproval ? "PRICE_OVERRIDE" : "DISCOUNT";
        } else if (needsOverrideApproval || needsDiscountApproval) {
          const type = needsOverrideApproval ? "PRICE_OVERRIDE" : "DISCOUNT";
          if (!l.approval_request_id) {
            throw new ApprovalRequiredError(type, needsOverrideApproval
              ? `${variant.sku}: price ${effectiveUnit.toDecimalPlaces(dec)} is below the minimum ${resolved.minPrice!.toDecimalPlaces(dec)}`
              : `${variant.sku}: discount ${discountPct.toDecimalPlaces(1)}% exceeds the ${discountPolicy!.threshold_percent}% limit`,
              { variant_id: variant.id, line_index: lineNo, amount: discount.plus(resolved.minPrice && needsOverrideApproval ? resolved.minPrice.times(q).minus(gross.minus(discount)) : 0).toString() });
          }
          await this.approvals.consume(tx, auth, l.approval_request_id, type, {});
          approvalId = l.approval_request_id;
        }
        const tax = variant.product.tax_rate_id ? await tx.taxRate.findUnique({ where: { id: variant.product.tax_rate_id } }) : null;
        const taxPct = D(tax?.active ? tax.rate_percent : 0);
        const calc = computeLine({ unitPrice, quantity: q, discount, taxPercent: taxPct, pricesIncludeTax: b.prices_include_tax, decimals: dec });
        priced.push({
          line_no: ++lineNo, variant_id: variant.id, sku: variant.sku, description: variant.name, unit_code: unitCode, unit_factor: factor,
          quantity: q, quantity_base: qty(q.times(factor)), unit_price: unitPrice, price_source: source, list_price: money(resolved.unitPrice, Math.max(dec, 2)),
          discount_amount: discount, discount_reason: discount.gt(0) ? l.discount_reason!.trim() : null, approval_request_id: approvalId,
          gross_amount: calc.gross, net_amount: calc.net, tax_rate_id: tax?.id ?? null, tax_percent: taxPct, tax_amount: calc.tax, line_total: calc.total,
          serial_number_id: l.serial_number_id ?? null, _variant: variant, _tax: tax, _pending: pendingApproval, _min: resolved.minPrice,
        } as any);
      }
      const total = sum(priced, (p) => p.line_total as Dec);
      const netTotal = sum(priced, (p) => p.net_amount as Dec);
      const taxTotal = sum(priced, (p) => p.tax_amount as Dec);
      if (opts.dryRun) {
        return {
          quote: {
            lines: priced.map((p: any) => ({ variant_id: p.variant_id, sku: p.sku, description: p.description, unit_code: p.unit_code, quantity: p.quantity, unit_price: p.unit_price, list_price: p.list_price, price_source: p.price_source, min_price: p._min, discount_amount: p.discount_amount, net_amount: p.net_amount, tax_percent: p.tax_percent, tax_amount: p.tax_amount, line_total: p.line_total, needs_approval: p._pending })),
            gross_amount: sum(priced, (p) => p.gross_amount as Dec), discount_total: sum(priced, (p) => p.discount_amount as Dec), net_amount: netTotal, tax_total: taxTotal, total, price_list_kind: kind,
          },
        } as any;
      }

      // ---- validate tenders
      if (!input.payments?.length) throw invalid("PAYMENT_REQUIRED", "Add a payment");
      let paid = ZERO, credit = ZERO, change = ZERO;
      const payments: { method: PaymentMethod; amount: Dec; tendered: Dec | null; change: Dec; accountId: string | null; confirmed: boolean; reference?: string; phone?: string; provider?: string | null }[] = [];
      for (const p of input.payments) {
        const amount = money(p.amount, dec);
        if (!amount.gt(0)) throw invalid("INVALID_PAYMENT", "Payment amounts must be positive");
        if (p.method === "CUSTOMER_CREDIT") {
          assertCan(auth, "pos.credit_sale", "Credit sales require pos.credit_sale");
          if (!customer) throw invalid("CUSTOMER_REQUIRED", "Select a customer for a credit sale");
          if (customer.credit_status !== "ACTIVE") throw invalid("CREDIT_NOT_ACTIVE", `${customer.name} does not have an active credit account`);
          const outstanding = await this.customerOutstanding(tx, customer.id);
          const exceed = outstanding.plus(credit).plus(amount).minus(customer.credit_limit);
          if (exceed.gt(0)) {
            if (!p.approval_request_id) throw new ApprovalRequiredError("CUSTOMER_CREDIT", `Credit limit exceeded by ${exceed.toDecimalPlaces(dec)} (limit ${D(customer.credit_limit).toDecimalPlaces(dec)}, outstanding ${outstanding.toDecimalPlaces(dec)})`, { customer_id: customer.id, amount: exceed.toString() });
            await this.approvals.consume(tx, auth, p.approval_request_id, "CUSTOMER_CREDIT", { minAmount: exceed });
          }
          credit = credit.plus(amount);
          continue;
        }
        let tendered: Dec | null = null, chg = ZERO;
        if (p.method === "CASH") {
          tendered = p.amount_tendered != null ? money(p.amount_tendered, dec) : amount;
          if (tendered.lessThan(amount)) throw invalid("TENDER_TOO_LOW", "Cash tendered is less than the cash amount");
          chg = tendered.minus(amount);
          change = change.plus(chg);
        }
        const accountId = p.financial_account_id ?? (await this.defaultAccount(tx, auth.businessId, input.branch_id, p.method, register.till_account_id));
        let confirmed = p.method === "CASH";
        if (ELECTRONIC.includes(p.method) && p.reference?.trim()) {
          assertCan(auth, "pos.confirm_payment", "Confirming electronic payments manually requires pos.confirm_payment");
          confirmed = true;
        }
        const provider = p.method === "MOBILE_MONEY" && !confirmed ? this.adapters.defaultProvider() : null;
        // Without a provider adapter, mobile money also waits for authorised manual confirmation.
        // Card / bank transfer without a confirmed reference stay PENDING until an authorised user confirms them.
        payments.push({ method: p.method, amount, tendered, change: chg, accountId, confirmed, reference: p.reference?.trim(), phone: p.payer_phone, provider });
        paid = paid.plus(amount);
      }
      if (!paid.plus(credit).equals(total)) {
        throw invalid("PAYMENT_MISMATCH", `Payments (${paid.plus(credit)}) must equal the sale total (${total})`, { total: total.toString(), paid: paid.plus(credit).toString() });
      }
      const allConfirmed = payments.every((p) => p.confirmed);

      // ---- create the sale
      const branch = await tx.branch.findUniqueOrThrow({ where: { id: input.branch_id } });
      const number = await this.seq.next(tx, auth.businessId, `SALE:${branch.code}`, `S-${branch.code}-`);
      const today = businessDate(new Date(), b.timezone);
      const sale = await tx.sale.create({
        data: {
          business_id: auth.businessId, branch_id: input.branch_id, location_id: register.location_id, register_id: register.id, cashier_session_id: session.id,
          customer_id: customer?.id ?? null, number, status: "PENDING_PAYMENT", price_list_kind: kind,
          gross_amount: sum(priced, (p) => p.gross_amount as Dec), discount_total: sum(priced, (p) => p.discount_amount as Dec),
          net_amount: netTotal, tax_total: taxTotal, total, amount_paid: ZERO, credit_amount: credit, change_given: change,
          due_date: credit.gt(0) ? new Date(`${addDays(today, customer!.payment_terms_days || 30)}T00:00:00Z`) : null,
          notes: input.notes ?? null, exchange_return_id: input.exchange_return_id ?? null, cashier_id: auth.userId, idempotency_key: idempotencyKey ?? null,
          lines: { create: priced.map(({ _variant, _tax, _pending, _min, ...l }: any) => ({ ...l, taxes: l.tax_rate_id && D(l.tax_amount as Dec).gt(0) ? { create: [{ tax_rate_id: l.tax_rate_id, tax_code: _tax.code, rate_percent: l.tax_percent as Dec, taxable_base: l.net_amount as Dec, amount: l.tax_amount as Dec }] } : undefined })) },
        },
        include: { lines: true },
      });
      for (const p of payments) {
        const pay = await tx.payment.create({
          data: {
            business_id: auth.businessId, branch_id: input.branch_id, sale_id: sale.id, customer_id: customer?.id ?? null, cashier_session_id: session.id,
            method: p.method, status: p.confirmed ? "CONFIRMED" : "PENDING", amount: p.amount, amount_tendered: p.tendered, change_given: p.change,
            financial_account_id: p.accountId, provider: p.provider ?? null, provider_reference: p.reference ?? null, payer_phone: p.phone ?? null,
            confirmation_mode: p.method === "CASH" ? "CASH" : p.confirmed ? "MANUAL" : "PROVIDER",
            confirmed_by_id: p.confirmed ? auth.userId : null, confirmed_at: p.confirmed ? new Date() : null, created_by_id: auth.userId,
          },
        });
        if (!p.confirmed && p.provider) await this.startAttempt(tx, pay.id, p.provider, auth.businessId, p.amount, b.currency_code, p.phone);
        if (p.confirmed && ELECTRONIC.includes(p.method)) {
          await this.audit.record(auth, { action: "payment.manually_confirmed", entityType: "payment", entityId: pay.id, summary: `${p.method} ${p.amount} confirmed manually, ref ${p.reference}`, branchId: input.branch_id }, tx);
        }
      }
      if (allConfirmed) {
        await this.finalize(tx, b, sale.id, auth.userId);
      } else {
        // Reserve stock while the customer approves the electronic payment.
        await this.reserveForSale(tx, b, sale, priced.map((p) => p._variant), today);
      }
      await this.audit.record(auth, { action: allConfirmed ? "sale.completed" : "sale.pending_payment", entityType: "sale", entityId: sale.id, summary: `${number} total ${total}`, branchId: input.branch_id }, tx);
      return { sale: await tx.sale.findUniqueOrThrow({ where: { id: sale.id } }), replay: false };
    }, { timeout: 60_000 });
    if ((result as any).quote) return (result as any).quote;
    return this.getSale(auth, result.sale.id);
  }

  private async reserveForSale(tx: Tx, b: Business, sale: Sale & { lines: any[] }, variants: any[], today: string) {
    const lines = [...sale.lines].sort((a, c) => a.variant_id.localeCompare(c.variant_id));
    for (const line of lines) {
      const v = variants.find((x) => x.id === line.variant_id);
      if (v.product.product_type === "NON_STOCK") continue;
      const plan = v.product.track_batches ? await this.ledger.planFefo(tx, sale.location_id, v.id, D(line.quantity_base), today) : [{ batchId: null, quantity: D(line.quantity_base) }];
      for (const p of plan) {
        await this.ledger.reserve(tx, { businessId: b.id, locationId: sale.location_id, variantId: v.id, batchId: p.batchId, quantity: p.quantity, sourceType: "sale", sourceId: sale.id, expiresAt: new Date(Date.now() + config.paymentTimeoutSeconds * 2000) });
      }
    }
  }

  private async startAttempt(tx: Tx, paymentId: string, provider: string, businessId: string, amount: Dec, currency: string, phone?: string) {
    const ref = `PA-${randomBytes(9).toString("hex")}`;
    await tx.paymentAttempt.create({ data: { payment_id: paymentId, provider, request_reference: ref, expires_at: new Date(Date.now() + config.paymentTimeoutSeconds * 1000) } });
    await tx.outboxEvent.create({ data: { business_id: businessId, topic: "payment.initiate", payload: { request_reference: ref, amount: amount.toString(), currency, payer_phone: phone ?? null } } });
  }

  /**
   * Completes a sale: stock out at weighted-average cost (FEFO for batches,
   * named serial for serial items), records cost on lines, and posts one
   * balanced journal for collections, revenue, tax and cost of sales.
   */
  async finalize(tx: Tx, b: Business, saleId: string, userId: string) {
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status FROM sales WHERE id = ${saleId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound("Sale");
    if (locked[0].status !== "PENDING_PAYMENT") return;
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { lines: true, payments: true } });
    const dec = b.currency_decimals;
    const today = businessDate(new Date(), b.timezone);
    const reservations = await tx.stockReservation.findMany({ where: { source_type: "sale", source_id: sale.id, released_at: null } });
    let costTotal = ZERO;
    const lines = [...sale.lines].sort((a, c) => a.variant_id.localeCompare(c.variant_id));
    for (const line of lines) {
      const v = await tx.productVariant.findUniqueOrThrow({ where: { id: line.variant_id }, include: { product: true } });
      if (v.product.product_type === "NON_STOCK") continue;
      const base = { businessId: b.id, branchId: sale.branch_id, locationId: sale.location_id, variantId: v.id, movementType: "SALE" as const, sourceType: "sale", sourceId: sale.id, sourceLineId: line.id, documentNumber: sale.number, userId, currencyDecimals: dec, requireSellable: true };
      let lineCost = ZERO;
      const myRes = reservations.filter((r) => r.variant_id === v.id && D(r.quantity).gt(0));
      if (myRes.length) {
        let need = D(line.quantity_base);
        for (const r of myRes) {
          if (need.lte(0)) break;
          const take = D(r.quantity).lessThan(need) ? D(r.quantity) : need;
          const out = await this.ledger.stockOut(tx, { ...base, quantity: take, batchId: r.batch_id, fromReservation: true });
          lineCost = lineCost.plus(out.value);
          need = need.minus(take);
          r.quantity = D(r.quantity).minus(take) as any;
          await tx.stockReservation.update({ where: { id: r.id }, data: { released_at: new Date() } });
        }
      } else if (line.serial_number_id) {
        const serial = await tx.serialNumber.findFirst({ where: { id: line.serial_number_id, variant_id: v.id } });
        if (!serial || serial.status !== "IN_STOCK" || serial.location_id !== sale.location_id) throw invalid("SERIAL_UNAVAILABLE", `Serial for ${v.sku} is not in stock at this location`);
        const out = await this.ledger.stockOut(tx, { ...base, quantity: D(line.quantity_base), serialNumberId: serial.id });
        lineCost = out.value;
        const warranty = v.product.warranty_months ? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + v.product.warranty_months, new Date().getUTCDate())) : null;
        const upd = await tx.serialNumber.updateMany({ where: { id: serial.id, status: "IN_STOCK" }, data: { status: "SOLD", sale_line_id: line.id, location_id: null, warranty_until: warranty } });
        if (upd.count !== 1) throw conflict("SERIAL_TAKEN", "Serial number was sold concurrently");
      } else if (v.product.track_batches) {
        const plan = await this.ledger.planFefo(tx, sale.location_id, v.id, D(line.quantity_base), today);
        for (const p of plan) lineCost = lineCost.plus((await this.ledger.stockOut(tx, { ...base, quantity: p.quantity, batchId: p.batchId })).value);
      } else {
        lineCost = (await this.ledger.stockOut(tx, { ...base, quantity: D(line.quantity_base) })).value;
      }
      costTotal = costTotal.plus(lineCost);
      await tx.saleLine.update({ where: { id: line.id }, data: { cost_amount: lineCost, unit_cost: unitCost(lineCost.div(line.quantity_base)) } });
    }
    const confirmed = sale.payments.filter((p) => p.status === "CONFIRMED");
    const paid = sum(confirmed.filter((p) => p.method !== "CUSTOMER_CREDIT"), (p) => p.amount);
    if (!paid.plus(sale.credit_amount).equals(sale.total)) throw invalid("PAYMENT_INCOMPLETE", "Sale payments are not complete");
    // ---- journal
    const accounts = await tx.financialAccount.findMany({ where: { id: { in: confirmed.map((p) => p.financial_account_id!).filter(Boolean) } } });
    const jl: PostingLine[] = [];
    for (const p of confirmed) {
      const fa = accounts.find((a) => a.id === p.financial_account_id)!;
      jl.push({ accountId: fa.gl_account_id, debit: p.amount, financialAccountId: fa.id, memo: `${p.method}${p.provider_reference ? ` ${p.provider_reference}` : ""}` });
    }
    if (D(sale.credit_amount).gt(0)) jl.push({ account: "customer_receivable", debit: sale.credit_amount, customerId: sale.customer_id, memo: "Credit sale" });
    jl.push({ account: "sales_revenue", credit: sale.net_amount, memo: "Sales (tax-exclusive)" });
    const taxByRate = new Map<string | null, Dec>();
    for (const l of sale.lines) if (D(l.tax_amount).gt(0)) taxByRate.set(l.tax_rate_id, (taxByRate.get(l.tax_rate_id) ?? ZERO).plus(l.tax_amount));
    for (const [rateId, amt] of taxByRate) {
      const rate = rateId ? await tx.taxRate.findUnique({ where: { id: rateId } }) : null;
      jl.push(rate?.output_account_id ? { accountId: rate.output_account_id, credit: amt, memo: `Output tax ${rate.code}` } : { account: "output_tax", credit: amt, memo: "Output tax" });
    }
    jl.push({ account: "cost_of_sales", debit: costTotal, memo: "Cost of sales" }, { account: "inventory", credit: costTotal, memo: "Cost of sales" });
    const journal = await this.posting.post(tx, { businessId: b.id, branchId: sale.branch_id, entryDate: today, sourceType: "sale", sourceId: sale.id, sourceNumber: sale.number, description: `Sale ${sale.number}`, createdById: userId, currencyDecimals: dec, lines: jl });
    await tx.sale.update({ where: { id: sale.id }, data: { status: "COMPLETED", completed_at: new Date(), amount_paid: paid, cost_total: costTotal, journal_entry_id: journal?.id ?? null } });
    await tx.outboxEvent.create({ data: { business_id: b.id, topic: "sale.completed", payload: { sale_id: sale.id, branch_id: sale.branch_id, variant_ids: sale.lines.map((l) => l.variant_id) } } });
  }

  // ------------------------------------------------- payment state machine ----
  /** Authorised manual confirmation of a pending electronic payment. */
  async confirmPayment(auth: AuthContext, paymentId: string, reference: string) {
    assertCan(auth, "pos.confirm_payment");
    if (!reference?.trim()) throw invalid("REFERENCE_REQUIRED", "A payment reference is required");
    const b = await this.settings.business(auth.businessId);
    await this.prisma.tx(async (tx) => {
      const p = await this.lockPayment(tx, auth.businessId, paymentId);
      assertBranch(auth, p.branch_id);
      if (p.status !== "PENDING") throw conflict("PAYMENT_NOT_PENDING", `Payment is ${p.status.toLowerCase()}`);
      await tx.payment.update({ where: { id: p.id }, data: { status: "CONFIRMED", confirmation_mode: "MANUAL", provider_reference: reference.trim(), confirmed_by_id: auth.userId, confirmed_at: new Date() } });
      await tx.paymentAttempt.updateMany({ where: { payment_id: p.id, status: "PENDING" }, data: { status: "CANCELLED", last_error: "Superseded by manual confirmation" } });
      await this.audit.record(auth, { action: "payment.manually_confirmed", entityType: "payment", entityId: p.id, summary: `${p.method} ${p.amount} confirmed manually, ref ${reference}`, branchId: p.branch_id }, tx);
      if (p.sale_id) await this.finalizeIfPaid(tx, b, p.sale_id, auth.userId);
    });
    return this.prisma.client.payment.findUnique({ where: { id: paymentId } });
  }

  private async lockPayment(tx: Tx, businessId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${id}::uuid AND business_id = ${businessId}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound("Payment");
    return tx.payment.findUniqueOrThrow({ where: { id } });
  }

  async finalizeIfPaid(tx: Tx, b: Business, saleId: string, userId: string) {
    const pays = await tx.payment.findMany({ where: { sale_id: saleId, status: { in: ["PENDING", "CONFIRMED"] } } });
    if (pays.some((p) => p.status === "PENDING")) return false;
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId } });
    const paid = sum(pays.filter((p) => p.status === "CONFIRMED" && p.method !== "CUSTOMER_CREDIT"), (p) => p.amount);
    if (!paid.plus(sale.credit_amount).equals(sale.total)) return false;
    await this.finalize(tx, b, saleId, userId);
    return true;
  }

  /**
   * Provider webhook (or simulator). Duplicate callbacks are ignored via the
   * unique (provider, event_id) constraint; late callbacks for attempts that
   * already reached a final state are recorded but change nothing.
   */
  async handleProviderEvent(provider: string, event: { event_id: string; request_reference: string; status: "SUCCESSFUL" | "FAILED"; external_reference?: string }, raw: object) {
    return this.prisma.tx(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO payment_provider_events (id, provider, event_id, payload, received_at)
        VALUES (gen_random_uuid(), ${provider}, ${event.event_id}, ${JSON.stringify(raw)}::jsonb, now()) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`;
      if (!inserted.length) return { outcome: "duplicate" };
      const attempt = await tx.paymentAttempt.findUnique({ where: { request_reference: event.request_reference } });
      const done = async (outcome: string) => { await tx.paymentProviderEvent.update({ where: { id: inserted[0].id }, data: { processed_at: new Date(), outcome } }); return { outcome }; };
      if (!attempt) return done("unknown_attempt");
      const payment = await this.lockPayment(tx, (await tx.payment.findUniqueOrThrow({ where: { id: attempt.payment_id } })).business_id, attempt.payment_id);
      if (attempt.status !== "PENDING" || payment.status !== "PENDING") return done(`ignored_final_state_${payment.status.toLowerCase()}`);
      if (event.status === "SUCCESSFUL") {
        await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "CONFIRMED", external_reference: event.external_reference ?? null } });
        await tx.payment.update({ where: { id: payment.id }, data: { status: "CONFIRMED", confirmation_mode: "PROVIDER", provider_reference: event.external_reference ?? attempt.request_reference, confirmed_at: new Date() } });
        const b = await this.settings.business(payment.business_id, tx);
        if (payment.sale_id) await this.finalizeIfPaid(tx, b, payment.sale_id, payment.created_by_id);
        return done("confirmed");
      }
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "FAILED", last_error: "Declined by provider" } });
      await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failure_reason: "Declined by provider" } });
      return done("failed");
    });
  }

  /** Worker: expires pending attempts past their deadline (timeout recovery). */
  async expireStaleAttempts(now = new Date()) {
    const stale = await this.prisma.client.paymentAttempt.findMany({ where: { status: "PENDING", expires_at: { lt: now } }, take: 50 });
    let n = 0;
    for (const a of stale) {
      await this.prisma.tx(async (tx) => {
        const p = await tx.payment.findUniqueOrThrow({ where: { id: a.payment_id } });
        await this.lockPayment(tx, p.business_id, p.id);
        const fresh = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: a.id } });
        if (fresh.status !== "PENDING") return;
        // A live adapter would query the provider's status endpoint here before failing the attempt.
        await tx.paymentAttempt.update({ where: { id: a.id }, data: { status: "FAILED", last_error: "Timed out awaiting provider confirmation", last_checked_at: now } });
        const upd = await tx.payment.updateMany({ where: { id: p.id, status: "PENDING" }, data: { status: "FAILED", failure_reason: "Timed out — retry, use another method, or confirm manually with a reference" } });
        if (upd.count) n++;
      });
    }
    return n;
  }

  /** Adds a replacement tender to a pending sale after a failed/expired attempt. */
  async addPayment(auth: AuthContext, saleId: string, p: CheckoutPayment) {
    const b = await this.settings.business(auth.businessId);
    await this.prisma.tx(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM sales WHERE id = ${saleId}::uuid AND business_id = ${auth.businessId}::uuid FOR UPDATE`;
      if (!rows.length) throw notFound("Sale");
      const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { payments: true } });
      assertBranch(auth, sale.branch_id);
      if (sale.status !== "PENDING_PAYMENT") throw conflict("SALE_NOT_PENDING", "Sale is not awaiting payment");
      const { register, session } = await this.openSessionFor(tx, auth, sale.register_id!, sale.branch_id);
      const active = sum(sale.payments.filter((x) => x.status !== "FAILED" && x.status !== "CANCELLED" && x.method !== "CUSTOMER_CREDIT"), (x) => x.amount);
      const due = D(sale.total).minus(sale.credit_amount).minus(active);
      const amount = money(p.amount, b.currency_decimals);
      if (!amount.equals(due)) throw invalid("PAYMENT_MISMATCH", `Amount must equal the outstanding ${due}`);
      if (p.method === "CUSTOMER_CREDIT") throw invalid("UNSUPPORTED", "Use a collection method to settle the remaining amount");
      const tendered = p.method === "CASH" ? money(p.amount_tendered ?? amount, b.currency_decimals) : null;
      if (tendered && tendered.lessThan(amount)) throw invalid("TENDER_TOO_LOW", "Cash tendered is less than the amount due");
      const manual = ELECTRONIC.includes(p.method) && !!p.reference?.trim();
      if (manual) assertCan(auth, "pos.confirm_payment");
      const provider = p.method === "MOBILE_MONEY" && !manual ? this.adapters.defaultProvider() : null;
      const confirmed = p.method === "CASH" || manual;
      const pay = await tx.payment.create({
        data: {
          business_id: auth.businessId, branch_id: sale.branch_id, sale_id: sale.id, customer_id: sale.customer_id, cashier_session_id: session.id, method: p.method,
          status: confirmed ? "CONFIRMED" : "PENDING", amount, amount_tendered: tendered, change_given: tendered ? tendered.minus(amount) : ZERO,
          financial_account_id: p.financial_account_id ?? (await this.defaultAccount(tx, auth.businessId, sale.branch_id, p.method, register.till_account_id)),
          provider, provider_reference: p.reference?.trim() ?? null, payer_phone: p.payer_phone ?? null, confirmation_mode: p.method === "CASH" ? "CASH" : manual ? "MANUAL" : "PROVIDER",
          confirmed_by_id: confirmed ? auth.userId : null, confirmed_at: confirmed ? new Date() : null, created_by_id: auth.userId,
        },
      });
      if (tendered) await tx.sale.update({ where: { id: sale.id }, data: { change_given: D(sale.change_given).plus(tendered.minus(amount)) } });
      if (provider) await this.startAttempt(tx, pay.id, provider, auth.businessId, amount, b.currency_code, p.payer_phone);
      if (confirmed) await this.finalizeIfPaid(tx, b, sale.id, auth.userId);
    });
    return this.getSale(auth, saleId);
  }

  async cancelPending(auth: AuthContext, saleId: string, reason: string) {
    await this.prisma.tx(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM sales WHERE id = ${saleId}::uuid AND business_id = ${auth.businessId}::uuid FOR UPDATE`;
      if (!rows.length) throw notFound("Sale");
      const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { payments: true } });
      assertBranch(auth, sale.branch_id);
      if (sale.status !== "PENDING_PAYMENT") throw conflict("SALE_NOT_PENDING", "Only sales awaiting payment can be cancelled");
      if (sale.payments.some((p) => p.status === "CONFIRMED" && p.method !== "CASH" && p.method !== "CUSTOMER_CREDIT")) {
        throw conflict("CONFIRMED_PAYMENT_EXISTS", "An electronic payment is already confirmed; complete the sale with the remaining amount instead of cancelling");
      }
      await tx.payment.updateMany({ where: { sale_id: saleId, status: { in: ["PENDING", "CONFIRMED"] } }, data: { status: "CANCELLED" } });
      await tx.paymentAttempt.updateMany({ where: { payment: { sale_id: saleId }, status: "PENDING" }, data: { status: "CANCELLED" } });
      await this.ledger.releaseReservations(tx, "sale", saleId);
      await tx.sale.update({ where: { id: saleId }, data: { status: "CANCELLED", cancelled_at: new Date() } });
      await this.audit.record(auth, { action: "sale.cancelled", entityType: "sale", entityId: saleId, summary: `${sale.number} cancelled before completion: ${reason}`, branchId: sale.branch_id }, tx);
    });
    return this.getSale(auth, saleId);
  }

  // ------------------------------------------------------------- returns ----
  /**
   * Customer return referencing the original sale lines. Refunds the original
   * line amounts pro rata; restocks at the ORIGINAL line cost (not today's
   * price); classifies stock by condition; posts a reversing journal.
   */
  async returnSale(auth: AuthContext, input: ReturnInput, idempotencyKey?: string) {
    assertCan(auth, "pos.return");
    if (!input.reason?.trim()) throw invalid("REASON_REQUIRED", "A return reason is required");
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    const policies = this.settings.policies(b);
    const id = await this.prisma.tx(async (tx) => {
      const sale = await tx.sale.findFirst({ where: { id: input.sale_id, business_id: auth.businessId }, include: { lines: true, payments: true } });
      if (!sale) throw notFound("Sale");
      assertBranch(auth, sale.branch_id);
      if (sale.status !== "COMPLETED") throw invalid("SALE_NOT_COMPLETED", "Only completed sales can be returned");
      const ageDays = (Date.now() - sale.completed_at!.getTime()) / 86_400_000;
      const locations = await tx.location.findMany({ where: { branch_id: sale.branch_id, active: true } });
      const quarantine = locations.find((l) => l.kind === "QUARANTINE");
      const damaged = locations.find((l) => l.kind === "DAMAGED") ?? quarantine;
      const number = await this.seq.next(tx, auth.businessId, "RETURN", "RET-");
      const lines: { saleLine: (typeof sale.lines)[number]; q: Dec; net: Dec; tax: Dec; cost: Dec; condition: ReturnInput["lines"][number]["condition"]; notes?: string; locationId: string | null }[] = [];
      for (const rl of input.lines) {
        await tx.$queryRaw`SELECT id FROM sale_lines WHERE id = ${rl.sale_line_id}::uuid FOR UPDATE`;
        const sl = await tx.saleLine.findFirst({ where: { id: rl.sale_line_id, sale_id: sale.id } });
        if (!sl) throw invalid("LINE_NOT_ON_SALE", "Return line does not belong to this sale");
        const q = qty(rl.quantity);
        const remaining = D(sl.quantity_base).minus(sl.qty_returned_base);
        if (!q.gt(0) || q.greaterThan(remaining)) throw invalid("RETURN_EXCEEDS_SOLD", `${sl.sku}: can return at most ${remaining} more`, { sale_line_id: sl.id, remaining: remaining.toString() });
        const final = q.equals(remaining);
        const priorReturns = await tx.salesReturnLine.aggregate({ where: { sale_line_id: sl.id }, _sum: { net_refund: true, tax_refund: true, cost_amount: true } });
        // include shares already taken by earlier lines of THIS return for the same sale line
        const pend = lines.filter((x) => x.saleLine.id === sl.id);
        const share = (total: Dec, prior: Dec, pending: Dec) => (final ? total.minus(prior).minus(pending) : money(total.times(q).div(sl.quantity_base), dec));
        const net = share(D(sl.net_amount), D(priorReturns._sum.net_refund ?? 0), sum(pend, (x) => x.net));
        const tax = share(D(sl.tax_amount), D(priorReturns._sum.tax_refund ?? 0), sum(pend, (x) => x.tax));
        const cost = share(D(sl.cost_amount), D(priorReturns._sum.cost_amount ?? 0), sum(pend, (x) => x.cost));
        const locationId = rl.condition === "SELLABLE" ? sale.location_id : rl.condition === "NON_RESTOCKABLE" ? null : rl.condition === "DAMAGED" ? (damaged?.id ?? null) : (quarantine?.id ?? null);
        if (rl.condition !== "NON_RESTOCKABLE" && !locationId) throw invalid("LOCATION_MISSING", "Configure QUARANTINE and DAMAGED locations for this branch");
        lines.push({ saleLine: sl, q, net, tax, cost, condition: rl.condition, notes: rl.inspection_notes, locationId });
        await tx.saleLine.update({ where: { id: sl.id }, data: { qty_returned_base: D(sl.qty_returned_base).plus(q) } });
      }
      const refundNet = sum(lines, (l) => l.net), refundTax = sum(lines, (l) => l.tax), refundTotal = refundNet.plus(refundTax);
      const costTotal = sum(lines, (l) => l.cost);
      const needsApproval = (await this.approvals.isRequired(tx, auth.businessId, "REFUND", { amount: refundTotal })) || ageDays > policies.return_window_days;
      let approvedBy: string | null = null;
      if (needsApproval) {
        if (!input.approval_request_id) throw new ApprovalRequiredError("REFUND", ageDays > policies.return_window_days ? `Sale is outside the ${policies.return_window_days}-day return window` : `Refund ${refundTotal} exceeds the approval threshold`, { amount: refundTotal.toString(), sale_id: sale.id });
        const req = await this.approvals.consume(tx, auth, input.approval_request_id, "REFUND", { minAmount: refundTotal });
        approvedBy = req.decided_by_id;
      }
      // refund destination
      let refundAccountId: string | null = null;
      let sessionId: string | null = null;
      const jl: PostingLine[] = [{ account: "sales_returns", debit: refundNet, memo: `Return ${number}` }];
      for (const l of lines) if (l.tax.gt(0)) {
        const rate = l.saleLine.tax_rate_id ? await tx.taxRate.findUnique({ where: { id: l.saleLine.tax_rate_id } }) : null;
        jl.push(rate?.output_account_id ? { accountId: rate.output_account_id, debit: l.tax, memo: "Output tax reversal" } : { account: "output_tax", debit: l.tax, memo: "Output tax reversal" });
      }
      if (input.refund_method === "CASH") {
        const { register, session } = await this.openSessionFor(tx, auth, input.register_id ?? sale.register_id!, sale.branch_id);
        refundAccountId = register.till_account_id; sessionId = session.id;
        const till = await this.finance.sessionSummary(tx, session.id);
        if (refundTotal.greaterThan(till.expected_cash)) throw invalid("INSUFFICIENT_CASH", `The till holds only ${till.expected_cash}; refund ${refundTotal} by another method or from another till`);
      } else if (input.refund_method === "CUSTOMER_CREDIT") {
        if (!sale.customer_id) throw invalid("CUSTOMER_REQUIRED", "Refund to account requires a sale with a customer");
      } else {
        refundAccountId = input.financial_account_id ?? null;
        if (!refundAccountId) throw invalid("ACCOUNT_REQUIRED", "Choose the account the refund is paid from");
        if (!input.reference?.trim()) throw invalid("REFERENCE_REQUIRED", "Enter the refund transaction reference");
      }
      if (input.refund_method === "CUSTOMER_CREDIT") {
        const outstanding = D(sale.credit_amount).minus(sale.credit_settled);
        const toAr = outstanding.lessThan(refundTotal) ? outstanding : refundTotal;
        if (toAr.gt(0)) {
          jl.push({ account: "customer_receivable", credit: toAr, customerId: sale.customer_id, memo: `Return ${number}` });
          await tx.sale.update({ where: { id: sale.id }, data: { credit_settled: D(sale.credit_settled).plus(toAr) } });
        }
        if (refundTotal.minus(toAr).gt(0)) jl.push({ account: "customer_deposit", credit: refundTotal.minus(toAr), customerId: sale.customer_id, memo: `Store credit ${number}` });
      } else {
        const fa = await tx.financialAccount.findFirstOrThrow({ where: { id: refundAccountId!, business_id: auth.businessId } });
        jl.push({ accountId: fa.gl_account_id, credit: refundTotal, financialAccountId: fa.id, memo: `Refund ${number}` });
      }
      const ret = await tx.salesReturn.create({
        data: {
          business_id: auth.businessId, branch_id: sale.branch_id, sale_id: sale.id, number, reason: input.reason.trim(), refund_method: input.refund_method,
          refund_total: refundTotal, tax_total: refundTax, cost_total: costTotal, cashier_session_id: sessionId, approval_request_id: input.approval_request_id ?? null,
          approved_by_id: approvedBy, created_by_id: auth.userId, idempotency_key: idempotencyKey ?? null,
          lines: { create: lines.map((l) => ({ sale_line_id: l.saleLine.id, variant_id: l.saleLine.variant_id, quantity_base: l.q, condition: l.condition, inspection_notes: l.notes ?? null, location_id: l.locationId, net_refund: l.net, tax_refund: l.tax, unit_cost: l.saleLine.unit_cost, cost_amount: l.cost, serial_number_id: l.saleLine.serial_number_id })) },
        },
        include: { lines: true },
      });
      // stock at original cost
      let restockedCost = ZERO, writtenOff = ZERO;
      for (const rl of [...ret.lines].sort((a, c) => a.variant_id.localeCompare(c.variant_id))) {
        const v = await tx.productVariant.findUniqueOrThrow({ where: { id: rl.variant_id }, include: { product: true } });
        if (v.product.product_type === "NON_STOCK") continue;
        if (!rl.location_id) { writtenOff = writtenOff.plus(rl.cost_amount); continue; }
        await this.ledger.stockIn(tx, { businessId: auth.businessId, branchId: sale.branch_id, locationId: rl.location_id, variantId: v.id, quantity: D(rl.quantity_base), value: D(rl.cost_amount), movementType: "CUSTOMER_RETURN", sourceType: "sales_return", sourceId: ret.id, sourceLineId: rl.id, documentNumber: number, reason: rl.condition, serialNumberId: rl.serial_number_id, userId: auth.userId, currencyDecimals: dec });
        if (rl.serial_number_id) await tx.serialNumber.update({ where: { id: rl.serial_number_id }, data: { status: rl.condition === "SELLABLE" ? "IN_STOCK" : "RETURNED", location_id: rl.location_id, sale_line_id: null } });
        restockedCost = restockedCost.plus(rl.cost_amount);
      }
      jl.push({ account: "inventory", debit: restockedCost, memo: "Returned stock at original cost" });
      jl.push({ account: "inventory_writeoff", debit: writtenOff, memo: "Non-restockable returns" });
      jl.push({ account: "cost_of_sales", credit: restockedCost.plus(writtenOff), memo: "Cost of sales reversal" });
      const journal = await this.posting.post(tx, { businessId: auth.businessId, branchId: sale.branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "sales_return", sourceId: ret.id, sourceNumber: number, description: `Return ${number} of ${sale.number}`, createdById: auth.userId, currencyDecimals: dec, lines: jl });
      await tx.salesReturn.update({ where: { id: ret.id }, data: { journal_entry_id: journal?.id } });
      if (input.refund_method !== "CUSTOMER_CREDIT") {
        await tx.refund.create({ data: { business_id: auth.businessId, sales_return_id: ret.id, method: input.refund_method, amount: refundTotal, financial_account_id: refundAccountId, reference: input.reference ?? null, cashier_session_id: sessionId, created_by_id: auth.userId } });
      }
      await this.audit.record(auth, { action: "sale.returned", entityType: "sales_return", entityId: ret.id, summary: `${number}: refund ${refundTotal} on ${sale.number}`, branchId: sale.branch_id, data: { reason: input.reason, lines: input.lines } }, tx);
      return ret.id;
    }, { timeout: 60_000 });
    return this.prisma.client.salesReturn.findUniqueOrThrow({ where: { id }, include: { lines: true } });
  }

  // ------------------------------------------------------------- queries ----
  async getSale(auth: AuthContext, id: string) {
    const sale = await this.prisma.client.sale.findFirst({ where: { id, business_id: auth.businessId }, include: { lines: { orderBy: { line_no: "asc" } }, payments: { include: { attempts: true }, orderBy: { created_at: "asc" } } } });
    if (!sale) throw notFound("Sale");
    assertBranch(auth, sale.branch_id);
    const showCost = can(auth, "products.view_cost");
    const [customer, cashier, branch, returns] = await Promise.all([
      sale.customer_id ? this.prisma.client.customer.findUnique({ where: { id: sale.customer_id }, select: { id: true, name: true, phone: true, code: true } }) : null,
      this.prisma.client.user.findUnique({ where: { id: sale.cashier_id }, select: { full_name: true } }),
      this.prisma.client.branch.findUnique({ where: { id: sale.branch_id } }),
      this.prisma.client.salesReturn.findMany({ where: { sale_id: id }, select: { id: true, number: true, refund_total: true, created_at: true } }),
    ]);
    return {
      ...sale,
      cost_total: showCost ? sale.cost_total : undefined,
      lines: sale.lines.map((l) => ({ ...l, unit_cost: showCost ? l.unit_cost : undefined, cost_amount: showCost ? l.cost_amount : undefined, returnable_base: D(l.quantity_base).minus(l.qty_returned_base) })),
      customer, cashier_name: cashier?.full_name, branch, returns,
      simulator: config.mobileMoneyMode === "simulator",
    };
  }

  async listSales(auth: AuthContext, q: PageQuery & { branch_id?: string; status?: string; from?: string; to?: string; customer_id?: string; session_id?: string }) {
    const where: Prisma.SaleWhereInput = {
      business_id: auth.businessId, ...branchFilter(auth),
      ...(q.branch_id ? { branch_id: q.branch_id } : {}), ...(q.status ? { status: q.status as any } : {}),
      ...(q.customer_id ? { customer_id: q.customer_id } : {}), ...(q.session_id ? { cashier_session_id: q.session_id } : {}),
      ...(q.search ? { number: { contains: q.search, mode: "insensitive" } } : {}),
      ...(q.from || q.to ? { created_at: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
    };
    const page = await paginate(q, this.prisma.client.sale.count({ where }), this.prisma.client.sale.findMany({ where, ...pageArgs(q), orderBy: { created_at: "desc" }, select: { id: true, number: true, status: true, total: true, created_at: true, completed_at: true, customer_id: true, cashier_id: true, branch_id: true, credit_amount: true, credit_settled: true } }));
    const [customers, users] = await Promise.all([
      this.prisma.client.customer.findMany({ where: { id: { in: page.items.map((s) => s.customer_id).filter(Boolean) as string[] } }, select: { id: true, name: true } }),
      this.prisma.client.user.findMany({ where: { id: { in: page.items.map((s) => s.cashier_id) } }, select: { id: true, full_name: true } }),
    ]);
    return { ...page, items: page.items.map((s) => ({ ...s, customer_name: customers.find((c) => c.id === s.customer_id)?.name ?? null, cashier_name: users.find((u) => u.id === s.cashier_id)?.full_name })) };
  }

  // --------------------------------------------------------- held carts ----
  holdCart(auth: AuthContext, input: { branch_id: string; register_id?: string; label: string; customer_id?: string; payload: object }) {
    assertBranch(auth, input.branch_id);
    // Held carts never reserve stock (policy held_cart_reserves_stock = false); prices are re-resolved on recall.
    return this.prisma.client.heldCart.create({ data: { business_id: auth.businessId, branch_id: input.branch_id, register_id: input.register_id ?? null, user_id: auth.userId, label: input.label, customer_id: input.customer_id ?? null, payload: input.payload as any } });
  }
  listHeld(auth: AuthContext, branchId: string) {
    assertBranch(auth, branchId);
    return this.prisma.client.heldCart.findMany({ where: { business_id: auth.businessId, branch_id: branchId }, orderBy: { created_at: "desc" } });
  }
  async recallHeld(auth: AuthContext, id: string) {
    const h = await this.prisma.client.heldCart.findFirst({ where: { id, business_id: auth.businessId } });
    if (!h) throw notFound("Held cart");
    assertBranch(auth, h.branch_id);
    await this.prisma.client.heldCart.delete({ where: { id } });
    return h;
  }
}
