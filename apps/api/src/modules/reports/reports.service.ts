import { Injectable } from "@nestjs/common";
import { AuthContext, assertBranch, can } from "../../common/auth-context";
import { forbidden } from "../../common/errors";
import { D } from "../../common/money";
import { PrismaService } from "../../common/prisma.service";
import { addDays, businessDate, businessDayRange, SettingsService } from "../../common/settings.service";

/**
 * Metric definitions (also in documentation/requirements/reports.md):
 *  - Reporting date: the business-local date (businesses.timezone) of
 *    sales.completed_at / document posting time. Accounting reports use journal entry_date.
 *  - Gross sales: Σ line gross (unit price × qty) before discounts.
 *  - Net sales (tax-exclusive): Σ sale_lines.net_amount — after discounts, excluding tax.
 *  - Returns: Σ sales_return_lines.net_refund (tax-exclusive) in the period.
 *  - Cost of sales: Σ weighted-average cost at the moment of sale (sale_lines.cost_amount) less returned cost.
 *  - Gross profit = net sales − returns − cost of sales (net of returned cost).
 *  - Gross margin % = gross profit ÷ (net sales − returns) × 100.
 *  - Markup % = gross profit ÷ cost of sales × 100.
 *  - Collections: confirmed payments by method (cash = amount retained, i.e. tendered − change).
 */
export interface Range { from: string; to: string; branch_id?: string }

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService, private settings: SettingsService) {}

  private async ctx(auth: AuthContext, r: Range) {
    if (r.branch_id) assertBranch(auth, r.branch_id);
    const b = await this.settings.business(auth.businessId);
    const range = businessDayRange(r.from, r.to, b.timezone);
    const branches = r.branch_id ? [r.branch_id] : auth.allBranches ? null : auth.branchIds;
    return { b, range, branches };
  }
  private requireCost(auth: AuthContext) {
    if (!can(auth, "products.view_cost") && !can(auth, "reports.financial")) throw forbidden("Margin reports require cost visibility");
  }

  async dailySales(auth: AuthContext, r: Range) {
    const { b, range, branches } = await this.ctx(auth, r);
    const tz = b.timezone;
    const sales = await this.prisma.client.$queryRaw<any[]>`
      SELECT to_char(s.completed_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, COUNT(*)::int AS transactions,
        SUM(s.gross_amount) AS gross_sales, SUM(s.discount_total) AS discounts, SUM(s.net_amount) AS net_sales, SUM(s.tax_total) AS tax, SUM(s.total) AS total
      FROM sales s WHERE s.business_id = ${auth.businessId}::uuid AND s.status = 'COMPLETED' AND s.completed_at >= ${range.gte} AND s.completed_at < ${range.lt}
        AND (${branches}::uuid[] IS NULL OR s.branch_id = ANY(${branches}::uuid[]))
      GROUP BY 1 ORDER BY 1`;
    const collections = await this.prisma.client.$queryRaw<any[]>`
      SELECT to_char(p.confirmed_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, p.method, SUM(p.amount) AS amount, COUNT(*)::int AS count
      FROM payments p LEFT JOIN sales s ON s.id = p.sale_id
      WHERE p.business_id = ${auth.businessId}::uuid AND p.status = 'CONFIRMED' AND p.method <> 'CUSTOMER_CREDIT' AND (s.id IS NULL OR s.status = 'COMPLETED')
        AND p.confirmed_at >= ${range.gte} AND p.confirmed_at < ${range.lt} AND (${branches}::uuid[] IS NULL OR p.branch_id = ANY(${branches}::uuid[]))
      GROUP BY 1, 2 ORDER BY 1, 2`;
    const refunds = await this.prisma.client.$queryRaw<any[]>`
      SELECT to_char(r.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, r.refund_method AS method, SUM(r.refund_total) AS amount, COUNT(*)::int AS count
      FROM sales_returns r WHERE r.business_id = ${auth.businessId}::uuid AND r.created_at >= ${range.gte} AND r.created_at < ${range.lt}
        AND (${branches}::uuid[] IS NULL OR r.branch_id = ANY(${branches}::uuid[])) GROUP BY 1, 2 ORDER BY 1`;
    return { from: r.from, to: r.to, sales, collections, refunds };
  }

  async salesBy(auth: AuthContext, r: Range & { dimension: "product" | "variant" | "category" | "branch" | "cashier" }) {
    const { range, branches } = await this.ctx(auth, r);
    const showCost = can(auth, "products.view_cost") || can(auth, "reports.financial");
    const dim = {
      variant: { key: "v.id", label: "v.sku || ' — ' || v.name" },
      product: { key: "p.id", label: "p.code || ' — ' || p.name" },
      category: { key: "COALESCE(c.id::text, 'none')", label: "COALESCE(c.name, 'Uncategorised')" },
      branch: { key: "br.id", label: "br.code || ' — ' || br.name" },
      cashier: { key: "u.id", label: "u.full_name" },
    }[r.dimension];
    const rows = await this.prisma.client.$queryRawUnsafe<any[]>(`
      SELECT ${dim.key} AS key, ${dim.label} AS label, SUM(sl.quantity_base) AS qty, SUM(sl.gross_amount) AS gross_sales, SUM(sl.discount_amount) AS discounts,
        SUM(sl.net_amount) AS net_sales, SUM(sl.tax_amount) AS tax, SUM(sl.cost_amount) AS cost, SUM(sl.net_amount - sl.cost_amount) AS gross_profit, COUNT(DISTINCT s.id)::int AS transactions
      FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id JOIN product_variants v ON v.id = sl.variant_id JOIN products p ON p.id = v.product_id
      LEFT JOIN categories c ON c.id = p.category_id JOIN branches br ON br.id = s.branch_id JOIN users u ON u.id = s.cashier_id
      WHERE s.business_id = $1::uuid AND s.status = 'COMPLETED' AND s.completed_at >= $2 AND s.completed_at < $3 AND ($4::uuid[] IS NULL OR s.branch_id = ANY($4::uuid[]))
      GROUP BY 1, 2 ORDER BY net_sales DESC LIMIT 500`, auth.businessId, range.gte, range.lt, branches);
    return {
      dimension: r.dimension, from: r.from, to: r.to,
      rows: rows.map((x) => {
        const out: any = { ...x, margin_percent: D(x.net_sales).isZero() ? null : D(x.gross_profit).div(x.net_sales).times(100).toDecimalPlaces(2) };
        if (!showCost) { delete out.cost; delete out.gross_profit; delete out.margin_percent; }
        return out;
      }),
    };
  }

  async grossProfit(auth: AuthContext, r: Range) {
    this.requireCost(auth);
    const { range, branches } = await this.ctx(auth, r);
    const [s] = await this.prisma.client.$queryRaw<any[]>`SELECT COALESCE(SUM(sl.net_amount),0) AS net_sales, COALESCE(SUM(sl.cost_amount),0) AS cost, COALESCE(SUM(sl.discount_amount),0) AS discounts
      FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id WHERE s.business_id = ${auth.businessId}::uuid AND s.status = 'COMPLETED'
        AND s.completed_at >= ${range.gte} AND s.completed_at < ${range.lt} AND (${branches}::uuid[] IS NULL OR s.branch_id = ANY(${branches}::uuid[]))`;
    const [ret] = await this.prisma.client.$queryRaw<any[]>`SELECT COALESCE(SUM(rl.net_refund),0) AS returns, COALESCE(SUM(rl.cost_amount),0) AS returned_cost
      FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.sales_return_id WHERE r.business_id = ${auth.businessId}::uuid
        AND r.created_at >= ${range.gte} AND r.created_at < ${range.lt} AND (${branches}::uuid[] IS NULL OR r.branch_id = ANY(${branches}::uuid[]))`;
    const netRevenue = D(s.net_sales).minus(ret.returns);
    const cost = D(s.cost).minus(ret.returned_cost);
    const gp = netRevenue.minus(cost);
    return { from: r.from, to: r.to, net_sales: D(s.net_sales), returns: D(ret.returns), net_revenue: netRevenue, discounts: D(s.discounts), cost_of_sales: cost, gross_profit: gp,
      gross_margin_percent: netRevenue.isZero() ? null : gp.div(netRevenue).times(100).toDecimalPlaces(2), markup_percent: cost.isZero() ? null : gp.div(cost).times(100).toDecimalPlaces(2) };
  }

  async discountsAndRefunds(auth: AuthContext, r: Range) {
    const { range, branches } = await this.ctx(auth, r);
    const discounts = await this.prisma.client.$queryRaw<any[]>`SELECT s.number AS sale_number, s.id AS sale_id, s.completed_at, u.full_name AS cashier, sl.sku, sl.description, sl.gross_amount, sl.discount_amount, sl.discount_reason, ar.number AS approval
      FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id JOIN users u ON u.id = s.cashier_id LEFT JOIN approval_requests ar ON ar.id = sl.approval_request_id
      WHERE s.business_id = ${auth.businessId}::uuid AND s.status = 'COMPLETED' AND sl.discount_amount > 0 AND s.completed_at >= ${range.gte} AND s.completed_at < ${range.lt}
        AND (${branches}::uuid[] IS NULL OR s.branch_id = ANY(${branches}::uuid[])) ORDER BY s.completed_at DESC LIMIT 1000`;
    const refunds = await this.prisma.client.$queryRaw<any[]>`SELECT r.number, r.id, r.created_at, s.number AS sale_number, r.refund_method, r.refund_total, r.reason, u.full_name AS processed_by
      FROM sales_returns r JOIN sales s ON s.id = r.sale_id JOIN users u ON u.id = r.created_by_id
      WHERE r.business_id = ${auth.businessId}::uuid AND r.created_at >= ${range.gte} AND r.created_at < ${range.lt} AND (${branches}::uuid[] IS NULL OR r.branch_id = ANY(${branches}::uuid[])) ORDER BY r.created_at DESC LIMIT 1000`;
    return { discounts, refunds };
  }

  async inventoryValuation(auth: AuthContext, branchId?: string) {
    this.requireCost(auth);
    if (branchId) assertBranch(auth, branchId);
    const branches = branchId ? [branchId] : auth.allBranches ? null : auth.branchIds;
    const rows = await this.prisma.client.$queryRaw<any[]>`SELECT br.code AS branch, v.sku, v.name, c.name AS category, cp.quantity, cp.average_cost, cp.value
      FROM inventory_cost_pools cp JOIN product_variants v ON v.id = cp.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id JOIN branches br ON br.id = cp.branch_id
      WHERE cp.business_id = ${auth.businessId}::uuid AND (cp.quantity <> 0 OR cp.value <> 0) AND (${branches}::uuid[] IS NULL OR cp.branch_id = ANY(${branches}::uuid[])) ORDER BY br.code, v.sku`;
    return { rows, total_value: rows.reduce((a, r) => a.plus(r.value), D(0)) };
  }

  /** Slow-moving / ageing: on-hand items with no sale in N days, with days since last receipt. */
  async slowMoving(auth: AuthContext, branchId: string, days: number) {
    assertBranch(auth, branchId);
    const showCost = can(auth, "products.view_cost");
    const rows = await this.prisma.client.$queryRaw<any[]>`
      SELECT v.sku, v.name, cp.quantity AS on_hand, cp.value, MAX(CASE WHEN m.movement_type = 'SALE' THEN m.occurred_at END) AS last_sale,
        MAX(CASE WHEN m.movement_type IN ('PURCHASE_RECEIPT','OPENING_BALANCE','TRANSFER_IN') THEN m.occurred_at END) AS last_receipt
      FROM inventory_cost_pools cp JOIN product_variants v ON v.id = cp.variant_id LEFT JOIN stock_movements m ON m.variant_id = cp.variant_id AND m.branch_id = cp.branch_id
      WHERE cp.branch_id = ${branchId}::uuid AND cp.quantity > 0 GROUP BY v.sku, v.name, cp.quantity, cp.value
      HAVING MAX(CASE WHEN m.movement_type = 'SALE' THEN m.occurred_at END) IS NULL OR MAX(CASE WHEN m.movement_type = 'SALE' THEN m.occurred_at END) < now() - make_interval(days => ${days}::int)
      ORDER BY last_sale NULLS FIRST`;
    return rows.map((r) => ({ ...r, value: showCost ? r.value : undefined, days_since_receipt: r.last_receipt ? Math.floor((Date.now() - new Date(r.last_receipt).getTime()) / 86_400_000) : null }));
  }

  async countVariances(auth: AuthContext, r: Range) {
    const { range, branches } = await this.ctx(auth, r);
    const showCost = can(auth, "products.view_cost");
    const rows = await this.prisma.client.$queryRaw<any[]>`SELECT c.number, c.id, c.posted_at, l.code AS location, v.sku, v.name, cl.system_qty, cl.counted_qty, cl.variance_qty, cl.variance_value
      FROM stock_count_lines cl JOIN stock_counts c ON c.id = cl.stock_count_id JOIN product_variants v ON v.id = cl.variant_id JOIN locations l ON l.id = c.location_id
      WHERE c.business_id = ${auth.businessId}::uuid AND c.status = 'POSTED' AND cl.variance_qty <> 0 AND c.posted_at >= ${range.gte} AND c.posted_at < ${range.lt}
        AND (${branches}::uuid[] IS NULL OR c.branch_id = ANY(${branches}::uuid[])) ORDER BY c.posted_at DESC`;
    return rows.map((x) => ({ ...x, variance_value: showCost ? x.variance_value : undefined }));
  }

  async purchasesBySupplier(auth: AuthContext, r: Range) {
    const { range, branches } = await this.ctx(auth, r);
    return this.prisma.client.$queryRaw<any[]>`SELECT sp.code, sp.name, COUNT(DISTINCT g.id)::int AS receipts, SUM(g.total_value) AS received_value
      FROM goods_receipts g JOIN suppliers sp ON sp.id = g.supplier_id
      WHERE g.business_id = ${auth.businessId}::uuid AND g.status = 'POSTED' AND g.posted_at >= ${range.gte} AND g.posted_at < ${range.lt} AND (${branches}::uuid[] IS NULL OR g.branch_id = ANY(${branches}::uuid[]))
      GROUP BY sp.code, sp.name ORDER BY received_value DESC`;
  }

  async supplierAgeing(auth: AuthContext) {
    const b = await this.settings.business(auth.businessId);
    const today = businessDate(new Date(), b.timezone);
    return this.prisma.client.$queryRaw<any[]>`SELECT sp.code, sp.name,
        SUM(CASE WHEN COALESCE(i.due_date, i.invoice_date) >= ${today}::date THEN i.total - i.amount_paid ELSE 0 END) AS current,
        SUM(CASE WHEN ${today}::date - COALESCE(i.due_date, i.invoice_date) BETWEEN 1 AND 30 THEN i.total - i.amount_paid ELSE 0 END) AS d1_30,
        SUM(CASE WHEN ${today}::date - COALESCE(i.due_date, i.invoice_date) BETWEEN 31 AND 60 THEN i.total - i.amount_paid ELSE 0 END) AS d31_60,
        SUM(CASE WHEN ${today}::date - COALESCE(i.due_date, i.invoice_date) > 60 THEN i.total - i.amount_paid ELSE 0 END) AS d60_plus,
        SUM(i.total - i.amount_paid) AS total
      FROM supplier_invoices i JOIN suppliers sp ON sp.id = i.supplier_id WHERE i.business_id = ${auth.businessId}::uuid AND i.status = 'POSTED' AND i.total > i.amount_paid
      GROUP BY sp.code, sp.name ORDER BY total DESC`;
  }

  async cashierVariances(auth: AuthContext, r: Range) {
    const { range, branches } = await this.ctx(auth, r);
    return this.prisma.client.$queryRaw<any[]>`SELECT cs.number, cs.id, u.full_name AS cashier, cr.name AS register, cs.opened_at, cs.closed_at, cs.opening_float, cs.expected_cash, cs.counted_cash, cs.variance, cs.variance_reason, ar.number AS approval
      FROM cashier_sessions cs JOIN users u ON u.id = cs.user_id JOIN cash_registers cr ON cr.id = cs.register_id LEFT JOIN approval_requests ar ON ar.id = cs.variance_approval_id
      WHERE cs.business_id = ${auth.businessId}::uuid AND cs.status = 'CLOSED' AND cs.closed_at >= ${range.gte} AND cs.closed_at < ${range.lt}
        AND (${branches}::uuid[] IS NULL OR cs.branch_id = ANY(${branches}::uuid[])) ORDER BY cs.closed_at DESC`;
  }

  async expenses(auth: AuthContext, r: Range) {
    const { branches } = await this.ctx(auth, r);
    return this.prisma.client.$queryRaw<any[]>`SELECT ec.name AS category, a.code AS account, SUM(el.amount) AS amount, COUNT(DISTINCT e.id)::int AS documents
      FROM expense_lines el JOIN expenses e ON e.id = el.expense_id JOIN expense_categories ec ON ec.id = el.expense_category_id JOIN accounts a ON a.id = ec.account_id
      WHERE e.business_id = ${auth.businessId}::uuid AND e.expense_date BETWEEN ${r.from}::date AND ${r.to}::date AND (${branches}::uuid[] IS NULL OR e.branch_id = ANY(${branches}::uuid[]))
      GROUP BY ec.name, a.code ORDER BY amount DESC`;
  }

  async transfersInTransit(auth: AuthContext) {
    const showCost = can(auth, "products.view_cost");
    const rows = await this.prisma.client.$queryRaw<any[]>`SELECT t.number, t.id, t.dispatched_at, fb.code AS from_branch, tb.code AS to_branch, v.sku, v.name,
        l.qty_dispatched - l.qty_received - l.qty_short AS qty_in_transit, l.dispatch_value - l.received_value AS value_in_transit
      FROM stock_transfer_lines l JOIN stock_transfers t ON t.id = l.stock_transfer_id JOIN branches fb ON fb.id = t.from_branch_id JOIN branches tb ON tb.id = t.to_branch_id JOIN product_variants v ON v.id = l.variant_id
      WHERE t.business_id = ${auth.businessId}::uuid AND t.status IN ('DISPATCHED','PARTIALLY_RECEIVED') AND l.qty_dispatched - l.qty_received - l.qty_short > 0 ORDER BY t.dispatched_at`;
    return rows.map((x) => ({ ...x, value_in_transit: showCost ? x.value_in_transit : undefined }));
  }

  async audit(auth: AuthContext, r: Range & { search?: string; page?: number }) {
    const b = await this.settings.business(auth.businessId);
    const range = businessDayRange(r.from, r.to, b.timezone);
    const rows = await this.prisma.client.auditEvent.findMany({
      where: { business_id: auth.businessId, created_at: range, ...(r.search ? { OR: [{ summary: { contains: r.search, mode: "insensitive" } }, { action: { contains: r.search } }] } : {}) },
      orderBy: { created_at: "desc" }, take: 200, skip: ((r.page ?? 1) - 1) * 200,
    });
    const users = await this.prisma.client.user.findMany({ where: { id: { in: rows.map((x) => x.actor_id).filter(Boolean) as string[] } }, select: { id: true, full_name: true } });
    return rows.map((x) => ({ ...x, actor_name: users.find((u) => u.id === x.actor_id)?.full_name ?? "system" }));
  }

  /** Role-aware dashboard built from live data (no placeholder figures). */
  async dashboard(auth: AuthContext, branchId?: string) {
    const b = await this.settings.business(auth.businessId);
    const today = businessDate(new Date(), b.timezone);
    const branches = branchId ? (assertBranch(auth, branchId), [branchId]) : auth.allBranches ? null : auth.branchIds;
    const range = businessDayRange(today, today, b.timezone);
    const week = businessDayRange(addDays(today, -6), today, b.timezone);
    const out: Record<string, unknown> = { today, currency: b.currency_code };
    if (can(auth, "pos.sell") || can(auth, "reports.view")) {
      const [t] = await this.prisma.client.$queryRaw<any[]>`SELECT COUNT(*)::int AS transactions, COALESCE(SUM(total),0) AS total, COALESCE(SUM(net_amount),0) AS net_sales, COALESCE(AVG(total),0) AS avg_basket
        FROM sales WHERE business_id = ${auth.businessId}::uuid AND status = 'COMPLETED' AND completed_at >= ${range.gte} AND completed_at < ${range.lt} AND (${branches}::uuid[] IS NULL OR branch_id = ANY(${branches}::uuid[]))
          AND (${can(auth, "reports.view")} OR cashier_id = ${auth.userId}::uuid)`;
      out.sales_today = t;
      out.sales_trend = await this.prisma.client.$queryRaw<any[]>`SELECT to_char(completed_at AT TIME ZONE ${b.timezone}, 'YYYY-MM-DD') AS day, COALESCE(SUM(total),0) AS total, COUNT(*)::int AS transactions
        FROM sales WHERE business_id = ${auth.businessId}::uuid AND status = 'COMPLETED' AND completed_at >= ${week.gte} AND completed_at < ${week.lt} AND (${branches}::uuid[] IS NULL OR branch_id = ANY(${branches}::uuid[]))
          AND (${can(auth, "reports.view")} OR cashier_id = ${auth.userId}::uuid) GROUP BY 1 ORDER BY 1`;
      out.collections_today = await this.prisma.client.$queryRaw<any[]>`SELECT p.method, SUM(p.amount) AS amount FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE p.business_id = ${auth.businessId}::uuid AND p.status = 'CONFIRMED' AND s.status = 'COMPLETED' AND s.completed_at >= ${range.gte} AND s.completed_at < ${range.lt}
          AND (${branches}::uuid[] IS NULL OR s.branch_id = ANY(${branches}::uuid[])) AND (${can(auth, "reports.view")} OR s.cashier_id = ${auth.userId}::uuid) GROUP BY p.method`;
    }
    if (can(auth, "reports.financial") || can(auth, "products.view_cost")) {
      const [g] = await this.prisma.client.$queryRaw<any[]>`SELECT COALESCE(SUM(sl.net_amount),0) AS net, COALESCE(SUM(sl.cost_amount),0) AS cost FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
        WHERE s.business_id = ${auth.businessId}::uuid AND s.status = 'COMPLETED' AND s.completed_at >= ${range.gte} AND s.completed_at < ${range.lt} AND (${branches}::uuid[] IS NULL OR s.branch_id = ANY(${branches}::uuid[]))`;
      out.gross_profit_today = { net_sales: g.net, cost: g.cost, gross_profit: D(g.net).minus(g.cost) };
      const [inv] = await this.prisma.client.$queryRaw<any[]>`SELECT COALESCE(SUM(value),0) AS value FROM inventory_cost_pools WHERE business_id = ${auth.businessId}::uuid AND (${branches}::uuid[] IS NULL OR branch_id = ANY(${branches}::uuid[]))`;
      out.inventory_value = inv.value;
    }
    if (can(auth, "inventory.view")) {
      const [low] = await this.prisma.client.$queryRaw<any[]>`SELECT COUNT(*)::int AS n FROM (SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
          LEFT JOIN stock_balances sb ON sb.variant_id = v.id AND (${branches}::uuid[] IS NULL OR sb.branch_id = ANY(${branches}::uuid[])) LEFT JOIN locations l ON l.id = sb.location_id AND l.is_sellable
          WHERE v.business_id = ${auth.businessId}::uuid AND v.status = 'ACTIVE' AND p.product_type <> 'NON_STOCK' AND v.reorder_point > 0
          GROUP BY v.id, v.reorder_point HAVING COALESCE(SUM(CASE WHEN l.id IS NOT NULL THEN sb.qty_on_hand - sb.qty_reserved END),0) <= v.reorder_point) x`;
      out.low_stock_count = low.n;
      out.transfers_in_transit = await this.prisma.client.stockTransfer.count({ where: { business_id: auth.businessId, status: { in: ["DISPATCHED", "PARTIALLY_RECEIVED"] } } });
    }
    if (can(auth, "purchasing.view")) {
      out.open_purchase_orders = await this.prisma.client.purchaseOrder.count({ where: { business_id: auth.businessId, status: { in: ["SUBMITTED", "APPROVED", "PARTIALLY_RECEIVED"] } } });
    }
    if (can(auth, "approvals.view")) out.pending_approvals = await this.prisma.client.approvalRequest.count({ where: { business_id: auth.businessId, status: "PENDING" } });
    if (can(auth, "sessions.view_all")) out.open_sessions = await this.prisma.client.cashierSession.count({ where: { business_id: auth.businessId, status: "OPEN" } });
    if (can(auth, "inventory.view")) out.notifications = await this.prisma.client.notification.findMany({ where: { business_id: auth.businessId, read_at: null }, orderBy: { created_at: "desc" }, take: 8 });
    return out;
  }
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? (typeof (v as any).toFixed === "function" ? String(v) : JSON.stringify(v)) : String(v);
    // neutralise spreadsheet formula injection
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
