import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Prisma, Tx } from "@retail/db";
import { AuthContext, assertBranch, can } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { conflict, forbidden, invalid, notFound } from "../../common/errors";
import { ApprovalRequiredError } from "../../common/errors";
import { D, Dec, money, qty, sum, unitCost, ZERO } from "../../common/money";
import { PageQuery, pageArgs, paginate } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { SequenceService } from "../../common/sequence.service";
import { businessDate, SettingsService } from "../../common/settings.service";
import { PostingLine, PostingService } from "../accounting/posting.service";
import { ApprovalsService } from "../approvals/approvals.service";
import { StockLedgerService } from "./stock-ledger.service";

export interface AdjustmentInput {
  branch_id: string;
  reason_code: "DAMAGE" | "EXPIRY" | "LOSS" | "FOUND" | "CORRECTION";
  reason: string;
  approval_request_id?: string;
  lines: { variant_id: string; location_id: string; quantity: string | number; batch_id?: string; unit_cost?: string | number }[];
}

@Injectable()
export class InventoryService implements OnModuleInit {
  constructor(
    private prisma: PrismaService, private seq: SequenceService, private audit: AuditService, private settings: SettingsService,
    private posting: PostingService, private ledger: StockLedgerService, private approvals: ApprovalsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHook("STOCK_ADJUSTMENT", async (tx, req, status) => {
      if (status !== "APPROVED" || !req.subject_id) return;
      const count = await tx.stockCount.findUnique({ where: { id: req.subject_id } });
      if (count && count.status === "SUBMITTED") await tx.stockCount.update({ where: { id: count.id }, data: { status: "APPROVED" } });
    });
  }

  // ------------------------------------------------------------ opening ----
  /** Opening balances: Dr Inventory / Cr Opening balance equity. */
  async postOpening(auth: AuthContext, input: { branch_id: string; location_id: string; lines: { variant_id: string; quantity: string | number; unit_cost: string | number; batch_number?: string; expiry_date?: string }[] }) {
    assertBranch(auth, input.branch_id);
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const loc = await tx.location.findFirst({ where: { id: input.location_id, branch_id: input.branch_id } });
      if (!loc) throw notFound("Location");
      const number = await this.seq.next(tx, auth.businessId, "OPENING", "OPN-");
      const docId = (await tx.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid() AS id`)[0].id;
      let total = ZERO;
      for (const l of [...input.lines].sort((a, c) => a.variant_id.localeCompare(c.variant_id))) {
        const v = await tx.productVariant.findFirst({ where: { id: l.variant_id, business_id: auth.businessId }, include: { product: true } });
        if (!v) throw notFound("Variant");
        if (v.product.product_type === "NON_STOCK") throw invalid("NON_STOCK", `${v.sku} is non-stock`);
        const q = qty(l.quantity);
        const value = money(q.times(D(l.unit_cost)), dec);
        let batchId: string | null = null;
        if (v.product.track_batches) {
          if (!l.batch_number) throw invalid("BATCH_REQUIRED", `${v.sku} requires a batch number`);
          batchId = (await tx.batch.upsert({ where: { variant_id_batch_number: { variant_id: v.id, batch_number: l.batch_number } }, create: { business_id: auth.businessId, variant_id: v.id, batch_number: l.batch_number, expiry_date: l.expiry_date ? new Date(`${l.expiry_date}T00:00:00Z`) : null }, update: {} })).id;
        }
        await this.ledger.stockIn(tx, { businessId: auth.businessId, branchId: input.branch_id, locationId: loc.id, variantId: v.id, quantity: q, value, movementType: "OPENING_BALANCE", sourceType: "opening_balance", sourceId: docId, documentNumber: number, batchId, userId: auth.userId, currencyDecimals: dec });
        total = total.plus(value);
      }
      await this.posting.post(tx, { businessId: auth.businessId, branchId: input.branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "opening_balance", sourceId: docId, sourceNumber: number, description: `Opening stock ${number}`, createdById: auth.userId, currencyDecimals: dec, lines: [{ account: "inventory", debit: total }, { account: "opening_equity", credit: total }] });
      await this.audit.record(auth, { action: "stock.opening", entityType: "opening_balance", entityId: docId, summary: `${number}: opening stock value ${total}`, branchId: input.branch_id }, tx);
      return { id: docId, number, total };
    }, { timeout: 120_000 });
  }

  // ------------------------------------------------------------ queries ----
  async balances(auth: AuthContext, q: PageQuery & { branch_id: string; location_id?: string; low_only?: string; category_id?: string }) {
    assertBranch(auth, q.branch_id);
    const showCost = can(auth, "products.view_cost");
    const search = q.search ? `%${q.search}%` : null;
    const rows = await this.prisma.client.$queryRaw<any[]>`
      WITH bal AS (
        SELECT sb.variant_id,
          SUM(CASE WHEN l.is_sellable THEN sb.qty_on_hand ELSE 0 END) AS sellable_on_hand,
          SUM(CASE WHEN l.is_sellable THEN sb.qty_reserved ELSE 0 END) AS reserved,
          SUM(CASE WHEN l.kind IN ('QUARANTINE','DAMAGED') THEN sb.qty_on_hand ELSE 0 END) AS quarantined,
          SUM(sb.qty_on_hand) AS on_hand
        FROM stock_balances sb JOIN locations l ON l.id = sb.location_id
        WHERE sb.branch_id = ${q.branch_id}::uuid AND (${q.location_id ?? null}::uuid IS NULL OR sb.location_id = ${q.location_id ?? null}::uuid)
        GROUP BY sb.variant_id
      ), transit AS (
        SELECT stl.variant_id, SUM(stl.qty_dispatched - stl.qty_received - stl.qty_short) AS in_transit
        FROM stock_transfer_lines stl JOIN stock_transfers st ON st.id = stl.stock_transfer_id
        WHERE st.to_branch_id = ${q.branch_id}::uuid AND st.status IN ('DISPATCHED','PARTIALLY_RECEIVED') GROUP BY stl.variant_id
      )
      SELECT v.id AS variant_id, v.sku, v.name, p.name AS product_name, p.product_type, c.name AS category_name, v.reorder_point, v.reorder_qty,
        COALESCE(bal.on_hand,0) AS on_hand, COALESCE(bal.sellable_on_hand,0) AS sellable_on_hand, COALESCE(bal.reserved,0) AS reserved,
        COALESCE(bal.quarantined,0) AS quarantined, COALESCE(bal.sellable_on_hand,0) - COALESCE(bal.reserved,0) AS available,
        COALESCE(transit.in_transit,0) AS in_transit, cp.average_cost, cp.value AS stock_value,
        COUNT(*) OVER() AS total_count
      FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN bal ON bal.variant_id = v.id LEFT JOIN transit ON transit.variant_id = v.id
      LEFT JOIN inventory_cost_pools cp ON cp.variant_id = v.id AND cp.branch_id = ${q.branch_id}::uuid
      WHERE v.business_id = ${auth.businessId}::uuid AND p.product_type <> 'NON_STOCK' AND v.status = 'ACTIVE'
        AND (${search}::text IS NULL OR v.sku ILIKE ${search} OR v.name ILIKE ${search} OR p.name ILIKE ${search})
        AND (${q.category_id ?? null}::uuid IS NULL OR p.category_id = ${q.category_id ?? null}::uuid)
        AND (${q.low_only === "true"} = false OR COALESCE(bal.sellable_on_hand,0) - COALESCE(bal.reserved,0) <= v.reorder_point)
      ORDER BY v.sku LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    const total = Number(rows[0]?.total_count ?? 0);
    return {
      items: rows.map(({ total_count, average_cost, stock_value, ...r }) => ({ ...r, ...(showCost ? { average_cost, stock_value } : {}), low: D(r.available).lte(r.reorder_point) })),
      total, page: q.page, pageSize: q.pageSize,
    };
  }

  async movements(auth: AuthContext, q: PageQuery & { branch_id?: string; variant_id?: string; movement_type?: string; from?: string; to?: string }) {
    if (q.branch_id) assertBranch(auth, q.branch_id);
    const where: Prisma.StockMovementWhereInput = {
      business_id: auth.businessId,
      ...(q.branch_id ? { branch_id: q.branch_id } : auth.allBranches ? {} : { branch_id: { in: auth.branchIds } }),
      ...(q.variant_id ? { variant_id: q.variant_id } : {}), ...(q.movement_type ? { movement_type: q.movement_type as any } : {}),
      ...(q.search ? { document_number: { contains: q.search, mode: "insensitive" } } : {}),
      ...(q.from || q.to ? { occurred_at: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
    };
    const page = await paginate(q, this.prisma.client.stockMovement.count({ where }), this.prisma.client.stockMovement.findMany({ where, ...pageArgs(q), orderBy: { occurred_at: q.order === "asc" ? "asc" : "desc" } }));
    const [variants, locations, batches] = await Promise.all([
      this.prisma.client.productVariant.findMany({ where: { id: { in: page.items.map((m) => m.variant_id) } }, select: { id: true, sku: true, name: true } }),
      this.prisma.client.location.findMany({ where: { id: { in: page.items.map((m) => m.location_id) } }, select: { id: true, code: true, name: true } }),
      this.prisma.client.batch.findMany({ where: { id: { in: page.items.map((m) => m.batch_id).filter(Boolean) as string[] } }, select: { id: true, batch_number: true, expiry_date: true } }),
    ]);
    const showCost = can(auth, "products.view_cost");
    return {
      ...page,
      items: page.items.map((m) => ({
        ...m, unit_cost: showCost ? m.unit_cost : undefined, value: showCost ? m.value : undefined, pool_value_after: showCost ? m.pool_value_after : undefined,
        sku: variants.find((v) => v.id === m.variant_id)?.sku, variant_name: variants.find((v) => v.id === m.variant_id)?.name,
        location: locations.find((l) => l.id === m.location_id)?.code, batch: batches.find((x) => x.id === m.batch_id) ?? null,
      })),
    };
  }

  /** Reorder suggestions: available ≤ reorder point → suggest reorder_qty (or up to 2× reorder point). */
  async reorderSuggestions(auth: AuthContext, branchId: string) {
    const res = await this.balances(auth, { branch_id: branchId, low_only: "true", page: 1, pageSize: 200, order: "asc" } as any);
    const variants = await this.prisma.client.productVariant.findMany({ where: { id: { in: res.items.map((i: any) => i.variant_id) } }, select: { id: true, preferred_supplier_id: true } });
    const suppliers = await this.prisma.client.supplier.findMany({ where: { id: { in: variants.map((v) => v.preferred_supplier_id).filter(Boolean) as string[] } }, select: { id: true, name: true } });
    return res.items.map((i: any) => {
      const v = variants.find((x) => x.id === i.variant_id);
      const target = D(i.reorder_qty).gt(0) ? D(i.reorder_qty) : D(i.reorder_point).times(2).minus(i.available).minus(i.in_transit);
      return { ...i, suggested_qty: target.gt(0) ? target : ZERO, preferred_supplier_id: v?.preferred_supplier_id ?? null, preferred_supplier_name: suppliers.find((s) => s.id === v?.preferred_supplier_id)?.name ?? null };
    });
  }

  async expiring(auth: AuthContext, branchId: string, days: number) {
    assertBranch(auth, branchId);
    const b = await this.settings.business(auth.businessId);
    const today = businessDate(new Date(), b.timezone);
    return this.prisma.client.$queryRaw<any[]>`
      SELECT b.id AS batch_id, b.batch_number, b.expiry_date, v.sku, v.name, l.code AS location, l.kind AS location_kind, sb.qty_on_hand,
        (b.expiry_date - ${today}::date) AS days_to_expiry
      FROM stock_balances sb JOIN batches b ON b.id = sb.batch_id JOIN product_variants v ON v.id = sb.variant_id JOIN locations l ON l.id = sb.location_id
      WHERE sb.branch_id = ${branchId}::uuid AND sb.qty_on_hand > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= (${today}::date + ${days}::int)
      ORDER BY b.expiry_date`;
  }

  // -------------------------------------------------------- adjustments ----
  /**
   * Stock adjustment / write-off. Negative quantities remove stock at average
   * cost (Dr loss or write-off / Cr Inventory); positive "found" stock enters at
   * the current average cost (Dr Inventory / Cr inventory gain).
   * Approval is required above the STOCK_ADJUSTMENT value threshold.
   */
  async adjust(auth: AuthContext, input: AdjustmentInput) {
    assertBranch(auth, input.branch_id);
    if (!input.reason?.trim()) throw invalid("REASON_REQUIRED", "A reason is required");
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      // value preview for approval decision
      let preview = ZERO;
      for (const l of input.lines) {
        const pool = await tx.inventoryCostPool.findUnique({ where: { variant_id_branch_id: { variant_id: l.variant_id, branch_id: input.branch_id } } });
        preview = preview.plus(money(D(l.quantity).abs().times(pool?.average_cost ?? l.unit_cost ?? 0), dec));
      }
      let approvalId: string | null = null;
      if (await this.approvals.isRequired(tx, auth.businessId, "STOCK_ADJUSTMENT", { amount: preview })) {
        if (!input.approval_request_id) throw new ApprovalRequiredError("STOCK_ADJUSTMENT", `Adjustment value ${preview} requires approval`, { amount: preview.toString() });
        await this.approvals.consume(tx, auth, input.approval_request_id, "STOCK_ADJUSTMENT", { minAmount: preview });
        approvalId = input.approval_request_id;
      }
      const number = await this.seq.next(tx, auth.businessId, "ADJUST", "ADJ-");
      const adj = await tx.stockAdjustment.create({ data: { business_id: auth.businessId, branch_id: input.branch_id, number, reason_code: input.reason_code, reason: input.reason, approval_request_id: approvalId, created_by_id: auth.userId } });
      const movementType = input.reason_code === "DAMAGE" ? "DAMAGE" : input.reason_code === "EXPIRY" ? "EXPIRY" : "ADJUSTMENT";
      let lossValue = ZERO, gainValue = ZERO;
      for (const l of [...input.lines].sort((a, c) => a.variant_id.localeCompare(c.variant_id))) {
        const q = qty(l.quantity);
        if (q.isZero()) continue;
        const loc = await tx.location.findFirst({ where: { id: l.location_id, branch_id: input.branch_id } });
        if (!loc) throw notFound("Location");
        const base = { businessId: auth.businessId, branchId: input.branch_id, locationId: loc.id, variantId: l.variant_id, movementType: movementType as any, sourceType: "stock_adjustment", sourceId: adj.id, documentNumber: number, reason: input.reason, batchId: l.batch_id ?? null, userId: auth.userId, currencyDecimals: dec };
        let value: Dec, cost: Dec;
        if (q.lt(0)) {
          const out = await this.ledger.stockOut(tx, { ...base, quantity: q.neg() });
          value = out.value.neg(); cost = out.unitCost; lossValue = lossValue.plus(out.value);
        } else {
          const pool = await tx.inventoryCostPool.findUnique({ where: { variant_id_branch_id: { variant_id: l.variant_id, branch_id: input.branch_id } } });
          const c = pool && D(pool.quantity).gt(0) ? D(pool.average_cost) : D(l.unit_cost ?? 0);
          if (c.isZero() && l.unit_cost == null) throw invalid("COST_REQUIRED", "Enter a unit cost for stock with no cost history");
          const r = await this.ledger.stockIn(tx, { ...base, quantity: q, value: money(q.times(c), dec) });
          value = r.value; cost = r.unitCost; gainValue = gainValue.plus(r.value);
        }
        await tx.stockAdjustmentLine.create({ data: { stock_adjustment_id: adj.id, variant_id: l.variant_id, location_id: loc.id, quantity: q, unit_cost: cost, value } });
      }
      const lossAccount = input.reason_code === "DAMAGE" || input.reason_code === "EXPIRY" ? "inventory_writeoff" : "inventory_loss";
      const lines: PostingLine[] = [
        { account: lossAccount, debit: lossValue, memo: input.reason }, { account: "inventory", credit: lossValue },
        { account: "inventory", debit: gainValue }, { account: "inventory_gain", credit: gainValue, memo: input.reason },
      ];
      const j = await this.posting.post(tx, { businessId: auth.businessId, branchId: input.branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "stock_adjustment", sourceId: adj.id, sourceNumber: number, description: `Stock adjustment ${number}: ${input.reason}`, createdById: auth.userId, currencyDecimals: dec, lines });
      await tx.stockAdjustment.update({ where: { id: adj.id }, data: { status: "POSTED", total_value: gainValue.minus(lossValue), journal_entry_id: j?.id, posted_by_id: auth.userId, posted_at: new Date() } });
      await this.audit.record(auth, { action: "stock.adjusted", entityType: "stock_adjustment", entityId: adj.id, summary: `${number} (${input.reason_code}) net value ${gainValue.minus(lossValue)}`, branchId: input.branch_id, data: input }, tx);
      return tx.stockAdjustment.findUniqueOrThrow({ where: { id: adj.id }, include: { lines: true } });
    });
  }

  /** Moves stock between locations in one branch (e.g. into quarantine, or release to sales floor). */
  async relocate(auth: AuthContext, input: { branch_id: string; variant_id: string; from_location_id: string; to_location_id: string; quantity: string | number; batch_id?: string; reason: string }) {
    assertBranch(auth, input.branch_id);
    const b = await this.settings.business(auth.businessId);
    return this.prisma.tx(async (tx) => {
      const locs = await tx.location.findMany({ where: { id: { in: [input.from_location_id, input.to_location_id] }, branch_id: input.branch_id } });
      if (locs.length !== 2) throw invalid("LOCATION_INVALID", "Both locations must belong to the branch");
      const docId = (await tx.$queryRaw<{ id: string }[]>`SELECT gen_random_uuid() AS id`)[0].id;
      await this.ledger.relocate(tx, { businessId: auth.businessId, branchId: input.branch_id, locationId: input.from_location_id, toLocationId: input.to_location_id, variantId: input.variant_id, quantity: qty(input.quantity), batchId: input.batch_id ?? null, movementType: "RELOCATION", sourceType: "relocation", sourceId: docId, reason: input.reason, userId: auth.userId, currencyDecimals: b.currency_decimals });
      await this.audit.record(auth, { action: "stock.relocated", entityType: "relocation", entityId: docId, summary: `Relocated ${input.quantity} units: ${input.reason}`, branchId: input.branch_id, data: input }, tx);
      return { id: docId };
    });
  }

  // ---------------------------------------------------------- transfers ----
  async createTransfer(auth: AuthContext, input: { from_branch_id: string; from_location_id: string; to_branch_id: string; to_location_id: string; notes?: string; lines: { variant_id: string; quantity: string | number }[] }) {
    assertBranch(auth, input.from_branch_id);
    if (input.from_branch_id === input.to_branch_id) throw invalid("SAME_BRANCH", "Use a relocation for moves within a branch");
    return this.prisma.tx(async (tx) => {
      const [from, to] = await Promise.all([
        tx.location.findFirst({ where: { id: input.from_location_id, branch_id: input.from_branch_id } }),
        tx.location.findFirst({ where: { id: input.to_location_id, branch_id: input.to_branch_id } }),
      ]);
      if (!from || !to) throw invalid("LOCATION_INVALID", "Locations must belong to their branches");
      const number = await this.seq.next(tx, auth.businessId, "TRANSFER_STOCK", "TRF-");
      const t = await tx.stockTransfer.create({
        data: {
          business_id: auth.businessId, number, from_branch_id: input.from_branch_id, from_location_id: from.id, to_branch_id: input.to_branch_id, to_location_id: to.id, notes: input.notes ?? null, created_by_id: auth.userId,
          lines: { create: input.lines.map((l, i) => ({ line_no: i + 1, variant_id: l.variant_id, qty_requested: qty(l.quantity) })) },
        },
        include: { lines: true },
      });
      await this.audit.record(auth, { action: "transfer.created", entityType: "stock_transfer", entityId: t.id, summary: `${number} created`, branchId: input.from_branch_id }, tx);
      return t;
    });
  }

  private async lockTransfer(tx: Tx, auth: AuthContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM stock_transfers WHERE id = ${id}::uuid AND business_id = ${auth.businessId}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound("Transfer");
    return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { lines: true } });
  }

  async approveTransfer(auth: AuthContext, id: string) {
    return this.prisma.tx(async (tx) => {
      const t = await this.lockTransfer(tx, auth, id);
      assertBranch(auth, t.from_branch_id);
      if (t.status !== "DRAFT") throw conflict("TRANSFER_STATE", `Transfer is ${t.status}`);
      if (t.created_by_id === auth.userId && !auth.permissions.has("approve.stock_adjustment")) throw forbidden("Another user must approve this transfer");
      await tx.stockTransfer.update({ where: { id }, data: { status: "APPROVED", approved_by_id: auth.userId, approved_at: new Date() } });
      await this.audit.record(auth, { action: "transfer.approved", entityType: "stock_transfer", entityId: id, summary: `${t.number} approved`, branchId: t.from_branch_id }, tx);
      return tx.stockTransfer.findUnique({ where: { id }, include: { lines: true } });
    });
  }

  /**
   * Dispatch: stock leaves the source at the source branch's average cost and
   * sits in transit (Dr Inventory in transit / Cr Inventory) until received.
   */
  async dispatchTransfer(auth: AuthContext, id: string, quantities?: Record<string, string | number>) {
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const t = await this.lockTransfer(tx, auth, id);
      assertBranch(auth, t.from_branch_id);
      if (t.status !== "APPROVED") throw conflict("TRANSFER_STATE", "Only approved transfers can be dispatched");
      let total = ZERO;
      for (const l of [...t.lines].sort((a, c) => a.variant_id.localeCompare(c.variant_id))) {
        const q = qty(quantities?.[l.id] ?? l.qty_requested);
        if (q.lt(0) || q.greaterThan(l.qty_requested)) throw invalid("INVALID_QUANTITY", "Dispatch quantity must be between 0 and requested");
        if (q.isZero()) continue;
        const out = await this.ledger.stockOut(tx, { businessId: auth.businessId, branchId: t.from_branch_id, locationId: t.from_location_id, variantId: l.variant_id, quantity: q, movementType: "TRANSFER_OUT", sourceType: "stock_transfer", sourceId: t.id, sourceLineId: l.id, documentNumber: t.number, userId: auth.userId, currencyDecimals: dec });
        await tx.stockTransferLine.update({ where: { id: l.id }, data: { qty_dispatched: q, dispatch_value: out.value } });
        total = total.plus(out.value);
      }
      const j = await this.posting.post(tx, { businessId: auth.businessId, branchId: t.from_branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "stock_transfer_dispatch", sourceId: t.id, sourceNumber: t.number, description: `Transfer ${t.number} dispatched`, createdById: auth.userId, currencyDecimals: dec, lines: [{ account: "inventory_in_transit", debit: total }, { account: "inventory", credit: total }] });
      await tx.stockTransfer.update({ where: { id }, data: { status: "DISPATCHED", dispatched_by_id: auth.userId, dispatched_at: new Date() } });
      await this.audit.record(auth, { action: "transfer.dispatched", entityType: "stock_transfer", entityId: id, summary: `${t.number} dispatched, value ${total}`, branchId: t.from_branch_id, data: { journal: j?.number } }, tx);
      return tx.stockTransfer.findUnique({ where: { id }, include: { lines: true } });
    });
  }

  /**
   * Receipt at destination. Received quantities enter the destination pool at
   * the dispatched unit value. Shortages may stay in transit (partial) or be
   * resolved as a loss with a note (Dr Inventory loss / Cr In transit).
   */
  async receiveTransfer(auth: AuthContext, id: string, input: { lines: { line_id: string; qty_received: string | number; qty_short?: string | number; note?: string }[]; close?: boolean }) {
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const t = await this.lockTransfer(tx, auth, id);
      assertBranch(auth, t.to_branch_id);
      if (!["DISPATCHED", "PARTIALLY_RECEIVED"].includes(t.status)) throw conflict("TRANSFER_STATE", "Transfer is not in transit");
      let inValue = ZERO, lossValue = ZERO;
      for (const rl of input.lines) {
        const l = t.lines.find((x) => x.id === rl.line_id);
        if (!l) throw invalid("LINE_INVALID", "Line not on transfer");
        const recv = qty(rl.qty_received), short = qty(rl.qty_short ?? 0);
        const outstanding = D(l.qty_dispatched).minus(l.qty_received).minus(l.qty_short);
        if (recv.lt(0) || short.lt(0) || recv.plus(short).greaterThan(outstanding)) throw invalid("OVER_RECEIPT", `Line ${l.line_no}: at most ${outstanding} outstanding`);
        if (short.gt(0) && !rl.note?.trim()) throw invalid("NOTE_REQUIRED", "Explain transfer shortages");
        // received_value tracks value resolved out of transit (received + written-off shortages)
        const remainingValue = D(l.dispatch_value).minus(l.received_value);
        const allDone = recv.plus(short).equals(outstanding);
        const recvValue = allDone && short.isZero() ? remainingValue : money(recv.times(D(l.dispatch_value).div(l.qty_dispatched)), dec);
        const shortValue = allDone ? remainingValue.minus(recvValue) : money(short.times(D(l.dispatch_value).div(l.qty_dispatched)), dec);
        if (recv.gt(0)) await this.ledger.stockIn(tx, { businessId: auth.businessId, branchId: t.to_branch_id, locationId: t.to_location_id, variantId: l.variant_id, quantity: recv, value: recvValue, movementType: "TRANSFER_IN", sourceType: "stock_transfer", sourceId: t.id, sourceLineId: l.id, documentNumber: t.number, userId: auth.userId, currencyDecimals: dec });
        await tx.stockTransferLine.update({ where: { id: l.id }, data: { qty_received: D(l.qty_received).plus(recv), qty_short: D(l.qty_short).plus(short), received_value: D(l.received_value).plus(recvValue).plus(short.gt(0) ? shortValue : ZERO), discrepancy_note: rl.note ?? l.discrepancy_note } });
        inValue = inValue.plus(recvValue); lossValue = lossValue.plus(short.gt(0) ? shortValue : ZERO);
      }
      await this.posting.post(tx, { businessId: auth.businessId, branchId: t.to_branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "stock_transfer_receipt", sourceId: t.id, sourceNumber: t.number, description: `Transfer ${t.number} received`, createdById: auth.userId, currencyDecimals: dec, lines: [{ account: "inventory", debit: inValue }, { account: "inventory_loss", debit: lossValue, memo: "Transfer shortage" }, { account: "inventory_in_transit", credit: inValue.plus(lossValue) }] });
      const lines = await tx.stockTransferLine.findMany({ where: { stock_transfer_id: id } });
      const complete = lines.every((l) => D(l.qty_received).plus(l.qty_short).gte(l.qty_dispatched));
      await tx.stockTransfer.update({ where: { id }, data: { status: complete ? (input.close ? "CLOSED" : "RECEIVED") : "PARTIALLY_RECEIVED", received_by_id: auth.userId, received_at: new Date(), closed_at: complete && input.close ? new Date() : null } });
      await this.audit.record(auth, { action: "transfer.received", entityType: "stock_transfer", entityId: id, summary: `${t.number} received value ${inValue}, shortage ${lossValue}`, branchId: t.to_branch_id }, tx);
      return tx.stockTransfer.findUnique({ where: { id }, include: { lines: true } });
    });
  }

  async listTransfers(auth: AuthContext, q: PageQuery & { status?: string }) {
    const where: Prisma.StockTransferWhereInput = { business_id: auth.businessId, ...(q.status ? { status: q.status as any } : {}), ...(auth.allBranches ? {} : { OR: [{ from_branch_id: { in: auth.branchIds } }, { to_branch_id: { in: auth.branchIds } }] }) };
    const page = await paginate(q, this.prisma.client.stockTransfer.count({ where }), this.prisma.client.stockTransfer.findMany({ where, ...pageArgs(q), orderBy: { created_at: "desc" }, include: { lines: true } }));
    const variants = await this.prisma.client.productVariant.findMany({ where: { id: { in: page.items.flatMap((t) => t.lines.map((l) => l.variant_id)) } }, select: { id: true, sku: true, name: true } });
    const showCost = can(auth, "products.view_cost");
    return { ...page, items: page.items.map((t) => ({ ...t, lines: t.lines.map((l) => ({ ...l, sku: variants.find((v) => v.id === l.variant_id)?.sku, variant_name: variants.find((v) => v.id === l.variant_id)?.name, dispatch_value: showCost ? l.dispatch_value : undefined, received_value: showCost ? l.received_value : undefined, in_transit: D(l.qty_dispatched).minus(l.qty_received).minus(l.qty_short) })) })) };
  }

  // ------------------------------------------------------------- counts ----
  /** Starts a count: snapshots system quantities for the location (blind-count friendly). */
  async startCount(auth: AuthContext, input: { branch_id: string; location_id: string; variant_ids?: string[]; notes?: string }) {
    assertBranch(auth, input.branch_id);
    return this.prisma.tx(async (tx) => {
      const loc = await tx.location.findFirst({ where: { id: input.location_id, branch_id: input.branch_id } });
      if (!loc) throw notFound("Location");
      const open = await tx.stockCount.findFirst({ where: { location_id: loc.id, status: { in: ["COUNTING", "SUBMITTED", "APPROVED"] } } });
      if (open) throw conflict("COUNT_IN_PROGRESS", `Count ${open.number} is already in progress for this location`);
      const balances = await tx.stockBalance.groupBy({ by: ["variant_id"], where: { location_id: loc.id, ...(input.variant_ids?.length ? { variant_id: { in: input.variant_ids } } : {}) }, _sum: { qty_on_hand: true } });
      const ids = new Set([...balances.map((x) => x.variant_id), ...(input.variant_ids ?? [])]);
      const number = await this.seq.next(tx, auth.businessId, "COUNT", "CNT-");
      return tx.stockCount.create({
        data: {
          business_id: auth.businessId, branch_id: input.branch_id, location_id: loc.id, number, status: "COUNTING", notes: input.notes ?? null, snapshot_at: new Date(), created_by_id: auth.userId,
          lines: { create: [...ids].map((vid) => ({ variant_id: vid, system_qty: D(balances.find((x) => x.variant_id === vid)?._sum.qty_on_hand ?? 0) })) },
        },
        include: { lines: true },
      });
    });
  }

  async recordCount(auth: AuthContext, id: string, counts: { variant_id: string; counted_qty: string | number }[]) {
    return this.prisma.tx(async (tx) => {
      const c = await tx.stockCount.findFirst({ where: { id, business_id: auth.businessId } });
      if (!c) throw notFound("Count");
      assertBranch(auth, c.branch_id);
      if (c.status !== "COUNTING") throw conflict("COUNT_STATE", "Count is not open for entry");
      for (const x of counts) {
        const q = qty(x.counted_qty);
        if (q.lt(0)) throw invalid("INVALID_QUANTITY", "Counted quantity cannot be negative");
        const line = await tx.stockCountLine.findUnique({ where: { stock_count_id_variant_id: { stock_count_id: id, variant_id: x.variant_id } } });
        if (line) await tx.stockCountLine.update({ where: { id: line.id }, data: { counted_qty: q, variance_qty: q.minus(line.system_qty) } });
        else await tx.stockCountLine.create({ data: { stock_count_id: id, variant_id: x.variant_id, system_qty: ZERO, counted_qty: q, variance_qty: q } });
      }
      return tx.stockCount.findUnique({ where: { id }, include: { lines: true } });
    });
  }

  /** Submits the count; variances valued at average cost; approval requested when above threshold. */
  async submitCount(auth: AuthContext, id: string) {
    const b = await this.settings.business(auth.businessId);
    return this.prisma.tx(async (tx) => {
      const c = await tx.stockCount.findFirst({ where: { id, business_id: auth.businessId }, include: { lines: true } });
      if (!c) throw notFound("Count");
      assertBranch(auth, c.branch_id);
      if (c.status !== "COUNTING") throw conflict("COUNT_STATE", "Count already submitted");
      if (c.lines.some((l) => l.counted_qty == null)) throw invalid("COUNT_INCOMPLETE", "Enter a counted quantity for every line (0 if none found)");
      let absValue = ZERO;
      for (const l of c.lines) {
        const pool = await tx.inventoryCostPool.findUnique({ where: { variant_id_branch_id: { variant_id: l.variant_id, branch_id: c.branch_id } } });
        const v = money(D(l.variance_qty).times(pool?.average_cost ?? 0), b.currency_decimals);
        await tx.stockCountLine.update({ where: { id: l.id }, data: { variance_value: v } });
        absValue = absValue.plus(v.abs());
      }
      const needs = absValue.gt(0) && (await this.approvals.isRequired(tx, auth.businessId, "STOCK_ADJUSTMENT", { amount: absValue }));
      let approvalId: string | null = null;
      if (needs) approvalId = (await this.approvals.request(auth, { type: "STOCK_ADJUSTMENT", reason: `Count ${c.number} variances (abs value ${absValue})`, amount: absValue, branchId: c.branch_id, subjectType: "stock_count", subjectId: c.id }, tx)).id;
      await tx.stockCount.update({ where: { id }, data: { status: needs ? "SUBMITTED" : "APPROVED", submitted_at: new Date(), approval_request_id: approvalId } });
      return tx.stockCount.findUnique({ where: { id }, include: { lines: true } });
    });
  }

  /**
   * Posts an approved count. Variance = counted − system snapshot; stock that
   * moved since the snapshot is accounted for by adjusting toward the counted
   * quantity relative to the snapshot (sales after snapshot are not double-counted).
   */
  async postCount(auth: AuthContext, id: string) {
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const c = await tx.stockCount.findFirst({ where: { id, business_id: auth.businessId }, include: { lines: true } });
      if (!c) throw notFound("Count");
      assertBranch(auth, c.branch_id);
      if (c.status !== "APPROVED") throw conflict("COUNT_STATE", "Count must be approved before posting");
      let loss = ZERO, gain = ZERO;
      for (const l of [...c.lines].sort((a, x) => a.variant_id.localeCompare(x.variant_id))) {
        const vq = D(l.variance_qty);
        if (vq.isZero()) continue;
        const base = { businessId: auth.businessId, branchId: c.branch_id, locationId: c.location_id, variantId: l.variant_id, movementType: "COUNT_ADJUSTMENT" as const, sourceType: "stock_count", sourceId: c.id, sourceLineId: l.id, documentNumber: c.number, reason: "Physical count", userId: auth.userId, currencyDecimals: dec };
        if (vq.lt(0)) loss = loss.plus((await this.ledger.stockOut(tx, { ...base, quantity: vq.neg() })).value);
        else {
          const pool = await tx.inventoryCostPool.findUnique({ where: { variant_id_branch_id: { variant_id: l.variant_id, branch_id: c.branch_id } } });
          gain = gain.plus((await this.ledger.stockIn(tx, { ...base, quantity: vq, value: money(vq.times(pool?.average_cost ?? 0), dec) })).value);
        }
      }
      const j = await this.posting.post(tx, { businessId: auth.businessId, branchId: c.branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "stock_count", sourceId: c.id, sourceNumber: c.number, description: `Count ${c.number} variances`, createdById: auth.userId, currencyDecimals: dec, lines: [{ account: "inventory_loss", debit: loss }, { account: "inventory", credit: loss }, { account: "inventory", debit: gain }, { account: "inventory_gain", credit: gain }] });
      await tx.stockCount.update({ where: { id }, data: { status: "POSTED", posted_at: new Date(), journal_entry_id: j?.id ?? null } });
      await this.audit.record(auth, { action: "count.posted", entityType: "stock_count", entityId: id, summary: `${c.number} posted: loss ${loss}, gain ${gain}`, branchId: c.branch_id }, tx);
      return tx.stockCount.findUnique({ where: { id }, include: { lines: true } });
    });
  }

  async getCount(auth: AuthContext, id: string) {
    const c = await this.prisma.client.stockCount.findFirst({ where: { id, business_id: auth.businessId }, include: { lines: true } });
    if (!c) throw notFound("Count");
    assertBranch(auth, c.branch_id);
    const variants = await this.prisma.client.productVariant.findMany({ where: { id: { in: c.lines.map((l) => l.variant_id) } }, select: { id: true, sku: true, name: true } });
    const showCost = can(auth, "products.view_cost");
    return { ...c, lines: c.lines.map((l) => ({ ...l, sku: variants.find((v) => v.id === l.variant_id)?.sku, variant_name: variants.find((v) => v.id === l.variant_id)?.name, variance_value: showCost ? l.variance_value : undefined })) };
  }

  listCounts(auth: AuthContext, q: PageQuery) {
    const where: Prisma.StockCountWhereInput = { business_id: auth.businessId, ...(auth.allBranches ? {} : { branch_id: { in: auth.branchIds } }) };
    return paginate(q, this.prisma.client.stockCount.count({ where }), this.prisma.client.stockCount.findMany({ where, ...pageArgs(q), orderBy: { created_at: "desc" } }));
  }

  listAdjustments(auth: AuthContext, q: PageQuery) {
    const where: Prisma.StockAdjustmentWhereInput = { business_id: auth.businessId, ...(auth.allBranches ? {} : { branch_id: { in: auth.branchIds } }) };
    return paginate(q, this.prisma.client.stockAdjustment.count({ where }), this.prisma.client.stockAdjustment.findMany({ where, ...pageArgs(q), orderBy: { created_at: "desc" }, include: { lines: true } }));
  }

  locations(auth: AuthContext, branchId?: string) {
    return this.prisma.client.location.findMany({ where: { business_id: auth.businessId, active: true, ...(branchId ? { branch_id: branchId } : auth.allBranches ? {} : { branch_id: { in: auth.branchIds } }) }, orderBy: [{ branch_id: "asc" }, { code: "asc" }] });
  }
}

export function avgCost(value: Dec, quantity: Dec) {
  return quantity.gt(0) ? unitCost(value.div(quantity)) : ZERO;
}
export { sum };
