import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Prisma, Tx } from "@retail/db";
import { AuthContext, assertBranch, branchFilter } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { conflict, forbidden, invalid, notFound } from "../../common/errors";
import { D, Dec, money, qty, sum, unitCost, ZERO } from "../../common/money";
import { PageQuery, pageArgs, paginate, orderBy } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { SequenceService } from "../../common/sequence.service";
import { businessDate, SettingsService } from "../../common/settings.service";
import { PostingService } from "../accounting/posting.service";
import { ApprovalsService } from "../approvals/approvals.service";
import { StockLedgerService } from "../inventory/stock-ledger.service";

export interface PoLineInput { variant_id: string; unit_id?: string; quantity: string | number; unit_cost: string | number }
export interface PoInput { branch_id: string; supplier_id: string; order_date?: string; expected_date?: string; payment_type?: "CASH" | "CREDIT"; notes?: string; lines: PoLineInput[] }
export interface ReceiptLineInput {
  purchase_order_line_id?: string;
  variant_id: string;
  unit_id?: string;
  qty_accepted: string | number;
  qty_damaged?: string | number;
  qty_rejected?: string | number;
  unit_cost?: string | number;
  batch_number?: string;
  expiry_date?: string;
  serial_numbers?: string[];
}
export interface ReceiptInput { branch_id: string; supplier_id?: string; purchase_order_id?: string; location_id?: string; supplier_reference?: string; notes?: string; lines: ReceiptLineInput[] }
export interface InvoiceInput {
  branch_id: string; supplier_id: string; supplier_invoice_no: string; invoice_date: string; due_date?: string; notes?: string;
  lines: { goods_receipt_line_id?: string; quantity_base?: string | number; base_unit_cost?: string | number; tax_rate_id?: string; description?: string; amount?: string | number; expense_account_id?: string }[];
}
export interface SupplierPaymentInput { branch_id: string; supplier_id: string; financial_account_id: string; amount: string | number; payment_date: string; reference?: string; allocations?: { supplier_invoice_id: string; amount: string | number }[] }

@Injectable()
export class PurchasingService implements OnModuleInit {
  constructor(
    private prisma: PrismaService, private seq: SequenceService, private audit: AuditService, private settings: SettingsService,
    private posting: PostingService, private ledger: StockLedgerService, private approvals: ApprovalsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHook("PURCHASE_ORDER", async (tx, req, status, approver) => {
      if (!req.subject_id) return;
      const po = await tx.purchaseOrder.findUnique({ where: { id: req.subject_id } });
      if (!po || po.status !== "SUBMITTED") return;
      if (po.created_by_id === approver.userId) throw forbidden("The creator of a purchase order cannot approve it");
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: status === "APPROVED" ? { status: "APPROVED", approved_by_id: approver.userId, approved_at: new Date() } : { status: "DRAFT", approval_request_id: null },
      });
    });
  }

  /** Resolves the purchase/sale unit factor for a variant (base unit = 1). */
  async unitFactor(tx: Tx, variantId: string, unitId?: string | null): Promise<{ unitId: string; factor: Dec }> {
    const v = await tx.productVariant.findUnique({ where: { id: variantId }, include: { product: true, unit_conversions: true } });
    if (!v) throw notFound("Variant");
    if (!unitId || unitId === v.product.base_unit_id) return { unitId: v.product.base_unit_id, factor: D(1) };
    const c = v.unit_conversions.find((x) => x.unit_id === unitId);
    if (!c) throw invalid("UNIT_NOT_CONFIGURED", `No packaging conversion for this unit on SKU ${v.sku}`);
    return { unitId, factor: D(c.factor) };
  }

  // ---------------------------------------------------------- suppliers ----
  listSuppliers(auth: AuthContext, q: PageQuery) {
    const where: Prisma.SupplierWhereInput = { business_id: auth.businessId, ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { code: { contains: q.search, mode: "insensitive" } }, { phone: { contains: q.search } }] } : {}) };
    return paginate(q, this.prisma.client.supplier.count({ where }), this.prisma.client.supplier.findMany({ where, ...pageArgs(q), orderBy: orderBy(q, ["name", "code", "created_at"], "name") }));
  }

  /** Supplier balance from the payables control account (credit − debit), plus advances. */
  async supplierBalance(auth: AuthContext, supplierId: string) {
    const [payable, advance] = await Promise.all([
      this.posting.accountIdFor(this.prisma.client as unknown as Tx, auth.businessId, "supplier_payable"),
      this.posting.accountIdFor(this.prisma.client as unknown as Tx, auth.businessId, "supplier_advance"),
    ]);
    const rows = await this.prisma.client.journalLine.groupBy({ by: ["account_id"], where: { supplier_id: supplierId, account_id: { in: [payable, advance] } }, _sum: { debit: true, credit: true } });
    const bal = (id: string) => { const r = rows.find((x) => x.account_id === id); return D(r?._sum.credit ?? 0).minus(D(r?._sum.debit ?? 0)); };
    return { payable: bal(payable), advances: bal(advance).neg() };
  }

  // ---------------------------------------------------- purchase orders ----
  async createPO(auth: AuthContext, input: PoInput) {
    assertBranch(auth, input.branch_id);
    if (!input.lines?.length) throw invalid("LINES_REQUIRED", "Add at least one line");
    const b = await this.settings.business(auth.businessId);
    return this.prisma.tx(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: input.supplier_id, business_id: auth.businessId, active: true } });
      if (!supplier) throw notFound("Supplier");
      const lines: Prisma.PurchaseOrderLineCreateWithoutPurchase_orderInput[] = [];
      let n = 0;
      for (const l of input.lines) {
        const { unitId, factor } = await this.unitFactor(tx, l.variant_id, l.unit_id);
        const q = qty(l.quantity);
        if (!q.gt(0)) throw invalid("INVALID_QUANTITY", "Quantities must be positive");
        const cost = unitCost(l.unit_cost);
        const v = await tx.productVariant.findUniqueOrThrow({ where: { id: l.variant_id }, include: { product: true } });
        if (v.product.product_type === "NON_STOCK") throw invalid("NON_STOCK", `${v.sku} is a non-stock item and cannot be purchased into inventory`);
        const tax = v.product.tax_rate_id ? await tx.taxRate.findUnique({ where: { id: v.product.tax_rate_id } }) : null;
        const subtotal = money(q.times(cost), b.currency_decimals);
        const taxPct = D(tax?.rate_percent ?? 0);
        lines.push({
          line_no: ++n, variant_id: l.variant_id, unit_id: unitId, unit_factor: factor, quantity: q, quantity_base: qty(q.times(factor)),
          unit_cost: cost, tax_rate_id: tax?.id ?? null, tax_percent: taxPct, line_subtotal: subtotal, line_tax: money(subtotal.times(taxPct).div(100), b.currency_decimals),
        });
      }
      const subtotal = sum(lines, (l) => l.line_subtotal as Dec);
      const taxTotal = sum(lines, (l) => l.line_tax as Dec);
      const number = await this.seq.next(tx, auth.businessId, "PO", "PO-");
      const today = businessDate(new Date(), b.timezone);
      const po = await tx.purchaseOrder.create({
        data: {
          business_id: auth.businessId, branch_id: input.branch_id, supplier_id: input.supplier_id, number,
          order_date: new Date(`${input.order_date ?? today}T00:00:00Z`), expected_date: input.expected_date ? new Date(`${input.expected_date}T00:00:00Z`) : null,
          payment_type: input.payment_type ?? "CREDIT", notes: input.notes ?? null, subtotal, tax_total: taxTotal, total: subtotal.plus(taxTotal),
          created_by_id: auth.userId, lines: { create: lines },
        },
      });
      await this.audit.record(auth, { action: "po.created", entityType: "purchase_order", entityId: po.id, summary: `${number} created for ${supplier.name}`, branchId: input.branch_id }, tx);
      return po;
    });
  }

  async submitPO(auth: AuthContext, id: string, reason?: string) {
    return this.prisma.tx(async (tx) => {
      const po = await this.lockPO(tx, auth, id);
      if (po.status !== "DRAFT") throw conflict("PO_NOT_DRAFT", `Only draft orders can be submitted (status ${po.status})`);
      const needs = await this.approvals.isRequired(tx, auth.businessId, "PURCHASE_ORDER", { amount: po.total });
      if (!needs) {
        await tx.purchaseOrder.update({ where: { id }, data: { status: "APPROVED", submitted_at: new Date(), approved_at: new Date() } });
        await this.audit.record(auth, { action: "po.auto_approved", entityType: "purchase_order", entityId: id, summary: `${po.number} submitted and auto-approved (below threshold)`, branchId: po.branch_id }, tx);
      } else {
        const req = await this.approvals.request(auth, { type: "PURCHASE_ORDER", reason: reason ?? `Approve ${po.number}`, amount: po.total, branchId: po.branch_id, subjectType: "purchase_order", subjectId: po.id, payload: { number: po.number } }, tx);
        await tx.purchaseOrder.update({ where: { id }, data: { status: "SUBMITTED", submitted_at: new Date(), approval_request_id: req.id } });
      }
      return tx.purchaseOrder.findUnique({ where: { id } });
    });
  }

  async cancelPO(auth: AuthContext, id: string, reason: string) {
    return this.prisma.tx(async (tx) => {
      const po = await this.lockPO(tx, auth, id);
      if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(po.status) || po.receipt_status !== "NOT_RECEIVED") throw conflict("PO_NOT_CANCELLABLE", "Only unreceived orders can be cancelled");
      await tx.purchaseOrder.update({ where: { id }, data: { status: "CANCELLED" } });
      if (po.approval_request_id) await tx.approvalRequest.updateMany({ where: { id: po.approval_request_id, status: "PENDING" }, data: { status: "CANCELLED" } });
      await this.audit.record(auth, { action: "po.cancelled", entityType: "purchase_order", entityId: id, summary: `${po.number} cancelled: ${reason}`, branchId: po.branch_id }, tx);
      return tx.purchaseOrder.findUnique({ where: { id } });
    });
  }

  async closePO(auth: AuthContext, id: string, reason: string) {
    return this.prisma.tx(async (tx) => {
      const po = await this.lockPO(tx, auth, id);
      if (!["PARTIALLY_RECEIVED", "FULLY_RECEIVED"].includes(po.status)) throw conflict("PO_NOT_CLOSABLE", "Only received or partially received orders can be closed");
      await tx.purchaseOrder.update({ where: { id }, data: { status: "CLOSED", closed_at: new Date() } });
      await this.audit.record(auth, { action: "po.closed", entityType: "purchase_order", entityId: id, summary: `${po.number} closed: ${reason}`, branchId: po.branch_id }, tx);
      return tx.purchaseOrder.findUnique({ where: { id } });
    });
  }

  private async lockPO(tx: Tx, auth: AuthContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchase_orders WHERE id = ${id}::uuid AND business_id = ${auth.businessId}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound("Purchase order");
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    assertBranch(auth, po.branch_id);
    return po;
  }

  listPOs(auth: AuthContext, q: PageQuery & { status?: string; supplier_id?: string }) {
    const where: Prisma.PurchaseOrderWhereInput = {
      business_id: auth.businessId, ...branchFilter(auth),
      ...(q.status ? { status: q.status as any } : {}), ...(q.supplier_id ? { supplier_id: q.supplier_id } : {}),
      ...(q.search ? { number: { contains: q.search, mode: "insensitive" } } : {}),
    };
    return paginate(q, this.prisma.client.purchaseOrder.count({ where }), this.prisma.client.purchaseOrder.findMany({ where, ...pageArgs(q), orderBy: orderBy(q, ["created_at", "number", "total", "order_date"], "created_at") }))
      .then(async (page) => {
        const sup = await this.prisma.client.supplier.findMany({ where: { id: { in: page.items.map((p) => p.supplier_id) } }, select: { id: true, name: true } });
        return { ...page, items: page.items.map((p) => ({ ...p, supplier_name: sup.find((s) => s.id === p.supplier_id)?.name })) };
      });
  }

  async getPO(auth: AuthContext, id: string) {
    const po = await this.prisma.client.purchaseOrder.findFirst({ where: { id, business_id: auth.businessId }, include: { lines: { orderBy: { line_no: "asc" } } } });
    if (!po) throw notFound("Purchase order");
    assertBranch(auth, po.branch_id);
    const [variants, units, supplier, receipts, approval] = await Promise.all([
      this.prisma.client.productVariant.findMany({ where: { id: { in: po.lines.map((l) => l.variant_id) } }, select: { id: true, sku: true, name: true, product: { select: { track_batches: true, track_expiry: true, track_serials: true } } } }),
      this.prisma.client.unit.findMany({ where: { business_id: auth.businessId } }),
      this.prisma.client.supplier.findUnique({ where: { id: po.supplier_id } }),
      this.prisma.client.goodsReceipt.findMany({ where: { purchase_order_id: id }, orderBy: { created_at: "asc" } }),
      po.approval_request_id ? this.prisma.client.approvalRequest.findUnique({ where: { id: po.approval_request_id } }) : null,
    ]);
    return {
      ...po, supplier, receipts, approval,
      lines: po.lines.map((l) => {
        const v = variants.find((x) => x.id === l.variant_id);
        return { ...l, sku: v?.sku, variant_name: v?.name, unit_code: units.find((u) => u.id === l.unit_id)?.code, tracking: v?.product, remaining_base: D(l.quantity_base).minus(l.received_base) };
      }),
    };
  }

  // ---------------------------------------------------- goods receipts ----
  /**
   * Posts a goods receipt atomically: stock in (accepted → receiving location,
   * damaged → DAMAGED location, rejected → not stocked), weighted-average
   * cost update, and journal Dr Inventory / Cr Goods Received Not Invoiced.
   */
  async receive(auth: AuthContext, input: ReceiptInput, idempotencyKey?: string) {
    assertBranch(auth, input.branch_id);
    if (!input.lines?.length) throw invalid("LINES_REQUIRED", "Add at least one line");
    const b = await this.settings.business(auth.businessId);
    const policies = this.settings.policies(b);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      let po: Awaited<ReturnType<typeof this.lockPO>> | null = null;
      let supplierId = input.supplier_id;
      if (input.purchase_order_id) {
        po = await this.lockPO(tx, auth, input.purchase_order_id);
        if (!["APPROVED", "PARTIALLY_RECEIVED"].includes(po.status)) throw conflict("PO_NOT_RECEIVABLE", `Purchase order ${po.number} is ${po.status.replace("_", " ").toLowerCase()} and cannot be received`);
        if (po.branch_id !== input.branch_id) throw invalid("BRANCH_MISMATCH", "Receive the order at the branch it was raised for");
        supplierId = po.supplier_id;
      } else if (!auth.permissions.has("purchasing.manage")) {
        throw forbidden("Receiving without a purchase order requires purchasing.manage");
      }
      if (!supplierId) throw invalid("SUPPLIER_REQUIRED", "Supplier is required");
      const locations = await tx.location.findMany({ where: { branch_id: input.branch_id, active: true } });
      const receiveLoc = input.location_id ? locations.find((l) => l.id === input.location_id) : (locations.find((l) => l.is_default) ?? locations.find((l) => l.is_sellable));
      if (!receiveLoc) throw invalid("LOCATION_REQUIRED", "No receiving location configured for this branch");
      const damagedLoc = locations.find((l) => l.kind === "DAMAGED");
      const number = await this.seq.next(tx, auth.businessId, "GRN", "GRN-");
      const receipt = await tx.goodsReceipt.create({
        data: {
          business_id: auth.businessId, branch_id: input.branch_id, location_id: receiveLoc.id, supplier_id: supplierId, purchase_order_id: po?.id ?? null,
          number, status: "DRAFT", supplier_reference: input.supplier_reference ?? null, received_at: new Date(), notes: input.notes ?? null,
          idempotency_key: idempotencyKey ?? null, created_by_id: auth.userId,
        },
      });
      const today = businessDate(new Date(), b.timezone);
      let total = ZERO;
      let lineNo = 0;
      // lock variants in a stable order
      const sorted = [...input.lines].sort((a, c) => a.variant_id.localeCompare(c.variant_id));
      for (const l of sorted) {
        const poLine = l.purchase_order_line_id ? po?.lines.find((x) => x.id === l.purchase_order_line_id) : undefined;
        if (po && !poLine) throw invalid("PO_LINE_REQUIRED", "Each line must reference a line on the purchase order");
        if (poLine && poLine.variant_id !== l.variant_id) throw invalid("PO_LINE_MISMATCH", "Variant does not match the purchase order line");
        const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: l.variant_id }, include: { product: true } });
        const { unitId, factor } = poLine && !l.unit_id ? { unitId: poLine.unit_id, factor: D(poLine.unit_factor) } : await this.unitFactor(tx, l.variant_id, l.unit_id);
        const acc = qty(l.qty_accepted ?? 0), dmg = qty(l.qty_damaged ?? 0), rej = qty(l.qty_rejected ?? 0);
        if (acc.lt(0) || dmg.lt(0) || rej.lt(0)) throw invalid("INVALID_QUANTITY", "Quantities cannot be negative");
        if (acc.plus(dmg).plus(rej).isZero()) continue;
        const accBase = qty(acc.times(factor)), dmgBase = qty(dmg.times(factor)), rejBase = qty(rej.times(factor));
        const purchaseUnitCost = l.unit_cost != null ? unitCost(l.unit_cost) : poLine ? D(poLine.unit_cost).times(factor).div(poLine.unit_factor) : null;
        if (purchaseUnitCost == null) throw invalid("COST_REQUIRED", `Unit cost is required for ${variant.sku}`);
        const baseCost = unitCost(purchaseUnitCost.div(factor));
        if (poLine) {
          const after = D(poLine.received_base).plus(accBase).plus(dmgBase);
          const limit = D(poLine.quantity_base).times(D(100).plus(policies.over_receipt_tolerance_percent)).div(100);
          if (after.greaterThan(limit)) {
            throw invalid("OVER_RECEIPT", `${variant.sku}: receiving ${accBase.plus(dmgBase)} would exceed the ordered ${poLine.quantity_base} (tolerance ${policies.over_receipt_tolerance_percent}%)`);
          }
          await tx.purchaseOrderLine.update({ where: { id: poLine.id }, data: { received_base: after } });
          poLine.received_base = after;
        }
        let batchId: string | null = null;
        if (variant.product.track_batches && accBase.plus(dmgBase).gt(0)) {
          if (!l.batch_number) throw invalid("BATCH_REQUIRED", `${variant.sku} requires a batch number`);
          if (variant.product.track_expiry && !l.expiry_date) throw invalid("EXPIRY_REQUIRED", `${variant.sku} requires an expiry date`);
          const batch = await tx.batch.upsert({
            where: { variant_id_batch_number: { variant_id: variant.id, batch_number: l.batch_number } },
            create: { business_id: auth.businessId, variant_id: variant.id, batch_number: l.batch_number, expiry_date: l.expiry_date ? new Date(`${l.expiry_date}T00:00:00Z`) : null },
            update: {},
          });
          batchId = batch.id;
        }
        const serials = (l.serial_numbers ?? []).map((s) => s.trim()).filter(Boolean);
        if (variant.product.track_serials) {
          if (!accBase.plus(dmgBase).isInteger() || serials.length !== accBase.plus(dmgBase).toNumber()) {
            throw invalid("SERIALS_REQUIRED", `${variant.sku} requires exactly ${accBase.plus(dmgBase)} serial number(s)`);
          }
          if (new Set(serials).size !== serials.length) throw invalid("DUPLICATE_SERIAL", "Serial numbers must be unique");
        }
        const accValue = money(accBase.times(baseCost), dec);
        const dmgValue = money(dmgBase.times(baseCost), dec);
        const line = await tx.goodsReceiptLine.create({
          data: {
            goods_receipt_id: receipt.id, purchase_order_line_id: poLine?.id ?? null, line_no: ++lineNo, variant_id: variant.id, unit_id: unitId, unit_factor: factor,
            qty_accepted: acc, qty_damaged: dmg, qty_rejected: rej, accepted_base: accBase, damaged_base: dmgBase, rejected_base: rejBase,
            unit_cost: purchaseUnitCost, base_unit_cost: baseCost, line_value: accValue.plus(dmgValue),
            batch_number: l.batch_number ?? null, expiry_date: l.expiry_date ? new Date(`${l.expiry_date}T00:00:00Z`) : null, serial_numbers: serials,
          },
        });
        const common = { businessId: auth.businessId, branchId: input.branch_id, variantId: variant.id, movementType: "PURCHASE_RECEIPT" as const, sourceType: "goods_receipt", sourceId: receipt.id, sourceLineId: line.id, documentNumber: number, batchId, userId: auth.userId, currencyDecimals: dec };
        if (accBase.gt(0)) await this.ledger.stockIn(tx, { ...common, locationId: receiveLoc.id, quantity: accBase, value: accValue });
        if (dmgBase.gt(0)) {
          if (!damagedLoc) throw invalid("DAMAGED_LOCATION_MISSING", "Configure a DAMAGED location for this branch to receive damaged goods");
          await this.ledger.stockIn(tx, { ...common, locationId: damagedLoc.id, quantity: dmgBase, value: dmgValue, reason: "Received damaged" });
        }
        let si = 0;
        for (const s of serials) {
          const isDamaged = si++ >= accBase.toNumber();
          await tx.serialNumber.create({
            data: {
              business_id: auth.businessId, variant_id: variant.id, serial: s, status: isDamaged ? "DAMAGED" : "IN_STOCK", location_id: isDamaged ? damagedLoc!.id : receiveLoc.id,
              warranty_until: variant.product.warranty_months ? null : null,
            },
          });
        }
        total = total.plus(accValue).plus(dmgValue);
      }
      if (lineNo === 0) throw invalid("NOTHING_RECEIVED", "Enter at least one received quantity");
      const journal = await this.posting.post(tx, {
        businessId: auth.businessId, branchId: input.branch_id, entryDate: today, sourceType: "goods_receipt", sourceId: receipt.id, sourceNumber: number,
        description: `Goods receipt ${number}${po ? ` (${po.number})` : ""}`, createdById: auth.userId, currencyDecimals: dec,
        lines: [
          { account: "inventory", debit: total, memo: number },
          { account: "grni", credit: total, memo: number, supplierId },
        ],
      });
      await tx.goodsReceipt.update({ where: { id: receipt.id }, data: { status: "POSTED", total_value: total, posted_at: new Date(), posted_by_id: auth.userId, journal_entry_id: journal?.id ?? null } });
      if (po) {
        const lines = await tx.purchaseOrderLine.findMany({ where: { purchase_order_id: po.id } });
        const full = lines.every((x) => D(x.received_base).gte(x.quantity_base));
        const any = lines.some((x) => D(x.received_base).gt(0));
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { receipt_status: full ? "FULLY_RECEIVED" : any ? "PARTIALLY_RECEIVED" : "NOT_RECEIVED", status: full ? "FULLY_RECEIVED" : "PARTIALLY_RECEIVED" },
        });
      }
      await this.audit.record(auth, { action: "grn.posted", entityType: "goods_receipt", entityId: receipt.id, summary: `${number} posted, value ${total}`, branchId: input.branch_id }, tx);
      return tx.goodsReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { lines: true } });
    }, { timeout: 60_000 });
  }

  listReceipts(auth: AuthContext, q: PageQuery & { supplier_id?: string; uninvoiced?: string }) {
    const where: Prisma.GoodsReceiptWhereInput = {
      business_id: auth.businessId, ...branchFilter(auth), status: "POSTED",
      ...(q.supplier_id ? { supplier_id: q.supplier_id } : {}), ...(q.search ? { number: { contains: q.search, mode: "insensitive" } } : {}),
    };
    return paginate(q, this.prisma.client.goodsReceipt.count({ where }), this.prisma.client.goodsReceipt.findMany({ where, ...pageArgs(q), orderBy: { created_at: "desc" }, include: { lines: true } }))
      .then(async (page) => {
        const sup = await this.prisma.client.supplier.findMany({ where: { id: { in: page.items.map((p) => p.supplier_id) } }, select: { id: true, name: true } });
        const vars = await this.prisma.client.productVariant.findMany({ where: { id: { in: page.items.flatMap((r) => r.lines.map((l) => l.variant_id)) } }, select: { id: true, sku: true, name: true } });
        return {
          ...page,
          items: page.items.map((r) => ({
            ...r, supplier_name: sup.find((s) => s.id === r.supplier_id)?.name,
            lines: r.lines.map((l) => ({ ...l, sku: vars.find((v) => v.id === l.variant_id)?.sku, variant_name: vars.find((v) => v.id === l.variant_id)?.name, uninvoiced_base: D(l.accepted_base).plus(l.damaged_base).minus(l.invoiced_base) })),
          })),
        };
      });
  }

  // --------------------------------------------------- supplier invoices ----
  /**
   * Posts a supplier invoice matched to receipt lines. Inventory is NOT
   * increased again: the invoice clears GRNI at receipt value; any price
   * difference goes to Purchase Price Variance (documented policy).
   */
  async postInvoice(auth: AuthContext, input: InvoiceInput) {
    assertBranch(auth, input.branch_id);
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const supplier = await tx.supplier.findFirst({ where: { id: input.supplier_id, business_id: auth.businessId } });
      if (!supplier) throw notFound("Supplier");
      const number = await this.seq.next(tx, auth.businessId, "SINV", "SINV-");
      const inv = await tx.supplierInvoice.create({
        data: {
          business_id: auth.businessId, branch_id: input.branch_id, supplier_id: supplier.id, number, supplier_invoice_no: input.supplier_invoice_no.trim(),
          invoice_date: new Date(`${input.invoice_date}T00:00:00Z`), due_date: input.due_date ? new Date(`${input.due_date}T00:00:00Z`) : null, notes: input.notes ?? null, created_by_id: auth.userId,
        },
      });
      const jl: { account?: any; accountId?: string; debit?: Dec; credit?: Dec; memo?: string; supplierId?: string }[] = [];
      let subtotal = ZERO, taxTotal = ZERO, n = 0;
      const touchedPoLines = new Set<string>();
      for (const l of input.lines) {
        if (l.goods_receipt_line_id) {
          const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM goods_receipt_lines WHERE id = ${l.goods_receipt_line_id}::uuid FOR UPDATE`;
          if (!rows.length) throw notFound("Receipt line");
          const grl = await tx.goodsReceiptLine.findUniqueOrThrow({ where: { id: l.goods_receipt_line_id }, include: { goods_receipt: true } });
          if (grl.goods_receipt.supplier_id !== supplier.id || grl.goods_receipt.status !== "POSTED") throw invalid("RECEIPT_MISMATCH", "Receipt line belongs to another supplier or is not posted");
          const q = qty(l.quantity_base ?? D(grl.accepted_base).plus(grl.damaged_base).minus(grl.invoiced_base));
          const remaining = D(grl.accepted_base).plus(grl.damaged_base).minus(grl.invoiced_base);
          if (!q.gt(0) || q.greaterThan(remaining)) throw invalid("INVOICE_EXCEEDS_RECEIPT", `Invoice quantity ${q} exceeds uninvoiced received quantity ${remaining}`);
          const invCost = unitCost(l.base_unit_cost ?? grl.base_unit_cost);
          // The final match takes the exact remaining receipt value so GRNI clears to zero.
          const prior = await tx.invoiceReceiptMatch.aggregate({ where: { goods_receipt_line_id: grl.id }, _sum: { receipt_value: true } });
          const receiptValue = remaining.equals(q) ? D(grl.line_value).minus(D(prior._sum.receipt_value ?? 0)) : money(q.times(grl.base_unit_cost), dec);
          const invoiceValue = money(q.times(invCost), dec);
          const variance = invoiceValue.minus(receiptValue);
          const tax = l.tax_rate_id ? await tx.taxRate.findUnique({ where: { id: l.tax_rate_id } }) : null;
          const lineTax = tax ? money(invoiceValue.times(tax.rate_percent).div(100), dec) : ZERO;
          const il = await tx.supplierInvoiceLine.create({
            data: { supplier_invoice_id: inv.id, line_no: ++n, goods_receipt_line_id: grl.id, variant_id: grl.variant_id, description: `Receipt ${grl.goods_receipt.number} line ${grl.line_no}`, quantity_base: q, base_unit_cost: invCost, line_subtotal: invoiceValue, tax_rate_id: tax?.id ?? null, line_tax: lineTax },
          });
          await tx.invoiceReceiptMatch.create({ data: { supplier_invoice_line_id: il.id, goods_receipt_line_id: grl.id, quantity_base: q, receipt_value: receiptValue, invoice_value: invoiceValue, price_variance: variance } });
          await tx.goodsReceiptLine.update({ where: { id: grl.id }, data: { invoiced_base: D(grl.invoiced_base).plus(q) } });
          if (grl.purchase_order_line_id) {
            await tx.purchaseOrderLine.update({ where: { id: grl.purchase_order_line_id }, data: { invoiced_base: { increment: q } } });
            touchedPoLines.add(grl.purchase_order_line_id);
          }
          jl.push({ account: "grni", debit: receiptValue, memo: `${number} clears ${grl.goods_receipt.number}`, supplierId: supplier.id });
          if (!variance.isZero()) jl.push({ account: "purchase_price_variance", debit: variance.gt(0) ? variance : ZERO, credit: variance.lt(0) ? variance.neg() : ZERO, memo: `Price variance ${grl.goods_receipt.number}` });
          if (lineTax.gt(0)) jl.push(tax!.input_account_id ? { accountId: tax!.input_account_id, debit: lineTax, memo: `Input tax ${tax!.code}` } : { account: "input_tax", debit: lineTax, memo: "Input tax" });
          subtotal = subtotal.plus(invoiceValue); taxTotal = taxTotal.plus(lineTax);
        } else {
          if (!l.expense_account_id || l.amount == null || !l.description) throw invalid("CHARGE_INCOMPLETE", "Non-receipt lines need description, amount and expense account");
          const amt = money(l.amount, dec);
          await tx.supplierInvoiceLine.create({ data: { supplier_invoice_id: inv.id, line_no: ++n, description: l.description, quantity_base: D(1), base_unit_cost: amt, line_subtotal: amt, expense_account_id: l.expense_account_id } });
          jl.push({ accountId: l.expense_account_id, debit: amt, memo: l.description });
          subtotal = subtotal.plus(amt);
        }
      }
      if (n === 0) throw invalid("LINES_REQUIRED", "Add at least one invoice line");
      const total = subtotal.plus(taxTotal);
      jl.push({ account: "supplier_payable", credit: total, memo: `${supplier.name} inv ${input.supplier_invoice_no}`, supplierId: supplier.id });
      const journal = await this.posting.post(tx, { businessId: auth.businessId, branchId: input.branch_id, entryDate: input.invoice_date, sourceType: "supplier_invoice", sourceId: inv.id, sourceNumber: number, description: `Supplier invoice ${input.supplier_invoice_no} (${supplier.name})`, createdById: auth.userId, currencyDecimals: dec, lines: jl });
      await tx.supplierInvoice.update({ where: { id: inv.id }, data: { status: "POSTED", subtotal, tax_total: taxTotal, total, journal_entry_id: journal?.id, posted_at: new Date(), posted_by_id: auth.userId } });
      for (const poLineId of touchedPoLines) {
        const pl = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLineId } });
        const lines = await tx.purchaseOrderLine.findMany({ where: { purchase_order_id: pl.purchase_order_id } });
        const full = lines.every((x) => D(x.invoiced_base).gte(x.quantity_base));
        await tx.purchaseOrder.update({ where: { id: pl.purchase_order_id }, data: { invoice_status: full ? "FULLY_INVOICED" : "PARTIALLY_INVOICED" } });
      }
      await this.audit.record(auth, { action: "supplier_invoice.posted", entityType: "supplier_invoice", entityId: inv.id, summary: `${number} (${input.supplier_invoice_no}) posted, total ${total}`, branchId: input.branch_id }, tx);
      return tx.supplierInvoice.findUniqueOrThrow({ where: { id: inv.id }, include: { lines: true } });
    });
  }

  listInvoices(auth: AuthContext, q: PageQuery & { supplier_id?: string; open?: string }) {
    const where: Prisma.SupplierInvoiceWhereInput = { business_id: auth.businessId, ...branchFilter(auth), status: "POSTED", ...(q.supplier_id ? { supplier_id: q.supplier_id } : {}), ...(q.search ? { OR: [{ number: { contains: q.search, mode: "insensitive" } }, { supplier_invoice_no: { contains: q.search, mode: "insensitive" } }] } : {}) };
    return paginate(q, this.prisma.client.supplierInvoice.count({ where }), this.prisma.client.supplierInvoice.findMany({ where, ...pageArgs(q), orderBy: { invoice_date: "desc" } })).then(async (page) => {
      const sup = await this.prisma.client.supplier.findMany({ where: { id: { in: page.items.map((p) => p.supplier_id) } }, select: { id: true, name: true } });
      return { ...page, items: page.items.map((i) => ({ ...i, supplier_name: sup.find((s) => s.id === i.supplier_id)?.name, outstanding: D(i.total).minus(i.amount_paid) })).filter((i) => q.open !== "true" || i.outstanding.gt(0)) };
    });
  }

  // --------------------------------------------------- supplier payments ----
  async paySupplier(auth: AuthContext, input: SupplierPaymentInput) {
    assertBranch(auth, input.branch_id);
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const amount = money(input.amount, dec);
      if (!amount.gt(0)) throw invalid("INVALID_AMOUNT", "Amount must be positive");
      const fa = await tx.financialAccount.findFirst({ where: { id: input.financial_account_id, business_id: auth.businessId, active: true } });
      if (!fa) throw notFound("Financial account");
      let allocated = ZERO;
      const number = await this.seq.next(tx, auth.businessId, "SPAY", "SPAY-");
      const payment = await tx.supplierPayment.create({
        data: { business_id: auth.businessId, branch_id: input.branch_id, supplier_id: input.supplier_id, number, payment_date: new Date(`${input.payment_date}T00:00:00Z`), financial_account_id: fa.id, amount, reference: input.reference ?? null, created_by_id: auth.userId },
      });
      for (const a of input.allocations ?? []) {
        const amt = money(a.amount, dec);
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM supplier_invoices WHERE id = ${a.supplier_invoice_id}::uuid FOR UPDATE`;
        if (!rows.length) throw notFound("Supplier invoice");
        const inv = await tx.supplierInvoice.findUniqueOrThrow({ where: { id: a.supplier_invoice_id } });
        if (inv.supplier_id !== input.supplier_id || inv.status !== "POSTED") throw invalid("INVOICE_MISMATCH", "Invoice belongs to another supplier or is not posted");
        const outstanding = D(inv.total).minus(inv.amount_paid);
        if (!amt.gt(0) || amt.greaterThan(outstanding)) throw invalid("OVER_ALLOCATION", `Allocation ${amt} exceeds outstanding ${outstanding} on ${inv.number}`);
        await tx.supplierInvoice.update({ where: { id: inv.id }, data: { amount_paid: D(inv.amount_paid).plus(amt) } });
        await tx.supplierPaymentAllocation.create({ data: { supplier_payment_id: payment.id, supplier_invoice_id: inv.id, amount: amt } });
        allocated = allocated.plus(amt);
      }
      if (allocated.greaterThan(amount)) throw invalid("OVER_ALLOCATION", "Allocations exceed the payment amount");
      const unallocated = amount.minus(allocated);
      const journal = await this.posting.post(tx, {
        businessId: auth.businessId, branchId: input.branch_id, entryDate: input.payment_date, sourceType: "supplier_payment", sourceId: payment.id, sourceNumber: number,
        description: `Supplier payment ${number}`, createdById: auth.userId, currencyDecimals: dec,
        lines: [
          { account: "supplier_payable", debit: allocated, supplierId: input.supplier_id, memo: number },
          { account: "supplier_advance", debit: unallocated, supplierId: input.supplier_id, memo: `${number} advance` },
          { accountId: fa.gl_account_id, credit: amount, financialAccountId: fa.id, memo: input.reference ?? number },
        ],
      });
      await tx.supplierPayment.update({ where: { id: payment.id }, data: { unallocated, journal_entry_id: journal?.id } });
      await this.audit.record(auth, { action: "supplier_payment.posted", entityType: "supplier_payment", entityId: payment.id, summary: `${number} paid ${amount} (${unallocated} unallocated)`, branchId: input.branch_id }, tx);
      return tx.supplierPayment.findUniqueOrThrow({ where: { id: payment.id }, include: { allocations: true } });
    });
  }
}
