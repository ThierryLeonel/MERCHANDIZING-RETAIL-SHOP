import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Prisma, Tx } from "@retail/db";
import { AuthContext } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { conflict, invalid, notFound } from "../../common/errors";
import { D, Dec, money, sum, ZERO } from "../../common/money";
import { PageQuery, pageArgs, paginate } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { businessDate, dateOnly, SettingsService } from "../../common/settings.service";
import { ApprovalsService } from "../approvals/approvals.service";
import { PostingService } from "./posting.service";

const NORMAL_DEBIT = new Set(["ASSET", "EXPENSE"]);

@Injectable()
export class AccountingService implements OnModuleInit {
  constructor(private prisma: PrismaService, private posting: PostingService, private approvals: ApprovalsService, private settings: SettingsService, private audit: AuditService) {}

  onModuleInit() {
    // Manual journals post only after an approver (not the requester) approves.
    this.approvals.registerHook("MANUAL_JOURNAL", async (tx, req, status, approver) => {
      if (status !== "APPROVED") return;
      const p = req.payload as { entry_date: string; description: string; branch_id?: string; lines: { account_id: string; debit?: string; credit?: string; memo?: string }[]; business_id: string };
      const b = await this.settings.business(p.business_id, tx);
      const j = await this.posting.post(tx, { businessId: p.business_id, branchId: p.branch_id ?? null, entryDate: p.entry_date, sourceType: "manual_journal", sourceId: req.id, description: p.description, createdById: req.requested_by_id, isManual: true, approvalRequestId: req.id, currencyDecimals: b.currency_decimals, lines: p.lines.map((l) => ({ accountId: l.account_id, debit: l.debit ?? 0, credit: l.credit ?? 0, memo: l.memo })) });
      await tx.approvalRequest.update({ where: { id: req.id }, data: { status: "CONSUMED", consumed_at: new Date(), subject_type: "journal_entry", subject_id: j?.id ?? null } });
      await this.audit.record(approver, { action: "journal.manual_posted", entityType: "journal_entry", entityId: j?.id, summary: `Manual journal ${j?.number} posted on approval` }, tx);
    });
    this.approvals.registerHook("PERIOD_REOPEN", async (tx, req, status, approver) => {
      if (status !== "APPROVED" || !req.subject_id) return;
      await tx.fiscalPeriod.update({ where: { id: req.subject_id }, data: { status: "OPEN", closed_at: null, closed_by_id: null } });
      await this.audit.record(approver, { action: "period.reopened", entityType: "fiscal_period", entityId: req.subject_id, summary: "Fiscal period reopened on approval" }, tx);
    });
  }

  async chart(auth: AuthContext, asOf?: string) {
    const accounts = await this.prisma.client.account.findMany({ where: { business_id: auth.businessId }, orderBy: { code: "asc" } });
    const sums = await this.prisma.client.journalLine.groupBy({ by: ["account_id"], where: { journal_entry: { business_id: auth.businessId, ...(asOf ? { entry_date: { lte: dateOnly(asOf) } } : {}) } }, _sum: { debit: true, credit: true } });
    return accounts.map((a) => {
      const s = sums.find((x) => x.account_id === a.id);
      const dr = D(s?._sum.debit ?? 0), cr = D(s?._sum.credit ?? 0);
      return { ...a, debit: dr, credit: cr, balance: NORMAL_DEBIT.has(a.type) ? dr.minus(cr) : cr.minus(dr) };
    });
  }

  async trialBalance(auth: AuthContext, asOf: string) {
    const rows = (await this.chart(auth, asOf)).filter((a) => !a.debit.isZero() || !a.credit.isZero());
    const lines = rows.map((a) => { const net = a.debit.minus(a.credit); return { account_id: a.id, code: a.code, name: a.name, type: a.type, debit: net.gt(0) ? net : ZERO, credit: net.lt(0) ? net.neg() : ZERO }; });
    const totalDr = sum(lines, (l) => l.debit), totalCr = sum(lines, (l) => l.credit);
    return { as_of: asOf, lines, total_debit: totalDr, total_credit: totalCr, balanced: totalDr.equals(totalCr) };
  }

  /**
   * Profit and loss for [from, to] by journal entry date (business-local).
   * Revenue is tax-exclusive and net of returns; gross profit = net revenue − cost of sales.
   */
  async profitAndLoss(auth: AuthContext, from: string, to: string, branchId?: string) {
    const accounts = await this.prisma.client.account.findMany({ where: { business_id: auth.businessId, type: { in: ["REVENUE", "EXPENSE"] } }, orderBy: { code: "asc" } });
    const sums = await this.prisma.client.journalLine.groupBy({ by: ["account_id"], where: { account_id: { in: accounts.map((a) => a.id) }, ...(branchId ? { branch_id: branchId } : {}), journal_entry: { entry_date: { gte: dateOnly(from), lte: dateOnly(to) } } }, _sum: { debit: true, credit: true } });
    const rows = accounts.map((a) => { const s = sums.find((x) => x.account_id === a.id); const dr = D(s?._sum.debit ?? 0), cr = D(s?._sum.credit ?? 0); return { id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, amount: a.type === "REVENUE" ? cr.minus(dr) : dr.minus(cr) }; }).filter((r) => !r.amount.isZero());
    const of = (st: string[]) => rows.filter((r) => st.includes(r.subtype ?? ""));
    const revenue = of(["sales", "sales_returns"]);
    const cogs = of(["cost_of_sales"]);
    const otherIncome = rows.filter((r) => r.type === "REVENUE" && !["sales", "sales_returns"].includes(r.subtype ?? ""));
    const opex = rows.filter((r) => r.type === "EXPENSE" && r.subtype !== "cost_of_sales");
    const netRevenue = sum(revenue, (r) => r.amount), cost = sum(cogs, (r) => r.amount);
    const gross = netRevenue.minus(cost);
    const operating = gross.plus(sum(otherIncome, (r) => r.amount)).minus(sum(opex, (r) => r.amount));
    return {
      from, to, branch_id: branchId ?? null,
      revenue, net_revenue: netRevenue, cost_of_sales: cogs, total_cost_of_sales: cost, gross_profit: gross,
      gross_margin_percent: netRevenue.isZero() ? null : gross.div(netRevenue).times(100).toDecimalPlaces(2),
      other_income: otherIncome, operating_expenses: opex, total_operating_expenses: sum(opex, (r) => r.amount), operating_profit: operating,
    };
  }

  async balanceSheet(auth: AuthContext, asOf: string) {
    const chart = await this.chart(auth, asOf);
    const by = (t: string) => chart.filter((a) => a.type === t && !a.balance.isZero()).map((a) => ({ id: a.id, code: a.code, name: a.name, amount: a.balance }));
    const assets = by("ASSET"), liabilities = by("LIABILITY"), equity = by("EQUITY");
    const earnings = sum(chart.filter((a) => a.type === "REVENUE"), (a) => a.balance).minus(sum(chart.filter((a) => a.type === "EXPENSE"), (a) => a.balance));
    const totalAssets = sum(assets, (a) => a.amount), totalLiab = sum(liabilities, (a) => a.amount), totalEq = sum(equity, (a) => a.amount).plus(earnings);
    return { as_of: asOf, assets, liabilities, equity, current_earnings: earnings, total_assets: totalAssets, total_liabilities: totalLiab, total_equity: totalEq, balanced: totalAssets.equals(totalLiab.plus(totalEq)) };
  }

  /** Control-account reconciliations (sub-ledgers vs general ledger). */
  async reconciliation(auth: AuthContext) {
    const db = this.prisma.client as unknown as Tx;
    const bal = async (key: any) => {
      const id = await this.posting.accountIdFor(db, auth.businessId, key);
      const s = await this.prisma.client.journalLine.aggregate({ where: { account_id: id }, _sum: { debit: true, credit: true } });
      return D(s._sum.debit ?? 0).minus(D(s._sum.credit ?? 0));
    };
    const pools = await this.prisma.client.inventoryCostPool.aggregate({ where: { business_id: auth.businessId }, _sum: { value: true, quantity: true } });
    const balancesQty = await this.prisma.client.stockBalance.aggregate({ where: { business_id: auth.businessId }, _sum: { qty_on_hand: true } });
    const movementsValue = await this.prisma.client.stockMovement.aggregate({ where: { business_id: auth.businessId }, _sum: { value: true, quantity: true } });
    const inTransit = await this.prisma.client.$queryRaw<{ v: Dec | null }[]>`SELECT SUM(l.dispatch_value - l.received_value) AS v
      FROM stock_transfer_lines l JOIN stock_transfers t ON t.id = l.stock_transfer_id WHERE t.business_id = ${auth.businessId}::uuid AND t.status IN ('DISPATCHED','PARTIALLY_RECEIVED')`;
    const uninvoiced = await this.prisma.client.$queryRaw<{ v: Dec | null }[]>`SELECT SUM(gl.line_value - COALESCE(m.rv, 0)) AS v FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.goods_receipt_id
      LEFT JOIN (SELECT goods_receipt_line_id, SUM(receipt_value) rv FROM invoice_receipt_matches GROUP BY goods_receipt_line_id) m ON m.goods_receipt_line_id = gl.id
      WHERE g.business_id = ${auth.businessId}::uuid AND g.status = 'POSTED'`;
    const supplierOpen = await this.prisma.client.supplierInvoice.aggregate({ where: { business_id: auth.businessId, status: "POSTED" }, _sum: { total: true, amount_paid: true } });
    const arOpen = await this.prisma.client.$queryRaw<{ v: Dec | null }[]>`SELECT SUM(credit_amount - credit_settled) AS v FROM sales WHERE business_id = ${auth.businessId}::uuid AND status = 'COMPLETED'`;
    const [glInv, glTransit, glGrni, glAp, glAr] = await Promise.all([bal("inventory"), bal("inventory_in_transit"), bal("grni"), bal("supplier_payable"), bal("customer_receivable")]);
    const check = (name: string, subledger: Dec, ledger: Dec, note: string) => ({ name, subledger, ledger, difference: subledger.minus(ledger), ok: subledger.equals(ledger), note });
    const openTills = await this.prisma.client.cashierSession.count({ where: { business_id: auth.businessId, status: "OPEN" } });
    const tillAccounts = await this.prisma.client.financialAccount.findMany({ where: { business_id: auth.businessId, kind: "TILL" } });
    const tillBal = await this.prisma.client.journalLine.aggregate({ where: { account_id: { in: tillAccounts.map((t) => t.gl_account_id) } }, _sum: { debit: true, credit: true } });
    return {
      checks: [
        check("Inventory valuation vs inventory control", D(pools._sum.value ?? 0), glInv, "Sum of weighted-average cost pools vs GL inventory account"),
        check("Stock ledger value vs cost pools", D(movementsValue._sum.value ?? 0), D(pools._sum.value ?? 0), "Sum of all stock movement values vs pool values"),
        check("Stock ledger quantity vs balances", D(movementsValue._sum.quantity ?? 0), D(balancesQty._sum.qty_on_hand ?? 0), "Sum of movement quantities vs on-hand balances"),
        check("Inventory in transit", D(inTransit[0]?.v ?? 0), glTransit, "Dispatched, unreceived transfer value vs GL in-transit account"),
        check("Goods received not invoiced", D(uninvoiced[0]?.v ?? 0).neg(), glGrni, "Uninvoiced receipt value vs GRNI (credit balance)"),
        check("Supplier payables", D(supplierOpen._sum.total ?? 0).minus(D(supplierOpen._sum.amount_paid ?? 0)).neg(), glAp, "Open supplier invoices vs payables control (credit balance)"),
        check("Customer receivables", D(arOpen[0]?.v ?? 0), glAr, "Open credit sales vs receivables control"),
      ],
      tills: { open_sessions: openTills, till_gl_balance: D(tillBal._sum.debit ?? 0).minus(D(tillBal._sum.credit ?? 0)), note: "With no open sessions the till balance should be zero (counted cash is moved to the safe at close)" },
    };
  }

  listJournals(auth: AuthContext, q: PageQuery & { source_type?: string; from?: string; to?: string; account_id?: string }) {
    const where: Prisma.JournalEntryWhereInput = {
      business_id: auth.businessId, ...(q.source_type ? { source_type: q.source_type } : {}),
      ...(q.search ? { OR: [{ number: { contains: q.search, mode: "insensitive" } }, { source_number: { contains: q.search, mode: "insensitive" } }, { description: { contains: q.search, mode: "insensitive" } }] } : {}),
      ...(q.from || q.to ? { entry_date: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
      ...(q.account_id ? { lines: { some: { account_id: q.account_id } } } : {}),
    };
    return paginate(q, this.prisma.client.journalEntry.count({ where }), this.prisma.client.journalEntry.findMany({ where, ...pageArgs(q), orderBy: [{ posted_at: "desc" }] }));
  }

  async getJournal(auth: AuthContext, id: string) {
    const j = await this.prisma.client.journalEntry.findFirst({ where: { id, business_id: auth.businessId }, include: { lines: { orderBy: { line_no: "asc" } } } });
    if (!j) throw notFound("Journal entry");
    const accounts = await this.prisma.client.account.findMany({ where: { id: { in: j.lines.map((l) => l.account_id) } } });
    return { ...j, lines: j.lines.map((l) => ({ ...l, account_code: accounts.find((a) => a.id === l.account_id)?.code, account_name: accounts.find((a) => a.id === l.account_id)?.name })) };
  }

  async requestManualJournal(auth: AuthContext, input: { entry_date: string; description: string; branch_id?: string; lines: { account_id: string; debit?: string; credit?: string; memo?: string }[] }) {
    const b = await this.settings.business(auth.businessId);
    const dr = sum(input.lines, (l) => money(l.debit ?? 0, b.currency_decimals)), cr = sum(input.lines, (l) => money(l.credit ?? 0, b.currency_decimals));
    if (!dr.equals(cr) || dr.isZero()) throw invalid("UNBALANCED_JOURNAL", `Debits (${dr}) must equal credits (${cr})`);
    const accounts = await this.prisma.client.account.findMany({ where: { id: { in: input.lines.map((l) => l.account_id) }, business_id: auth.businessId } });
    const bad = accounts.find((a) => !a.allow_manual || !a.is_postable);
    if (bad || accounts.length !== new Set(input.lines.map((l) => l.account_id)).size) throw invalid("ACCOUNT_CONTROL", `Account ${bad?.code ?? ""} cannot take manual journals (control accounts are posted by their modules)`);
    await this.posting.periodFor(this.prisma.client as unknown as Tx, auth.businessId, input.entry_date);
    return this.approvals.request(auth, { type: "MANUAL_JOURNAL", reason: input.description, amount: dr, branchId: input.branch_id ?? null, payload: { ...input, business_id: auth.businessId } });
  }

  async reverseManual(auth: AuthContext, id: string, reason: string) {
    const b = await this.settings.business(auth.businessId);
    return this.prisma.tx(async (tx) => {
      const j = await tx.journalEntry.findFirst({ where: { id, business_id: auth.businessId } });
      if (!j) throw notFound("Journal entry");
      if (!j.is_manual) throw invalid("NOT_MANUAL", "Source-document journals are corrected through their documents (returns, adjustments, credit notes)");
      const rev = await this.posting.reverse(tx, id, { date: businessDate(new Date(), b.timezone), reason, userId: auth.userId, currencyDecimals: b.currency_decimals });
      await this.audit.record(auth, { action: "journal.reversed", entityType: "journal_entry", entityId: id, summary: `${j.number} reversed by ${rev.number}: ${reason}` }, tx);
      return rev;
    });
  }

  periods(auth: AuthContext) {
    return this.prisma.client.fiscalPeriod.findMany({ where: { business_id: auth.businessId }, orderBy: { start_date: "desc" } });
  }

  async closePeriod(auth: AuthContext, id: string) {
    return this.prisma.tx(async (tx) => {
      const p = await tx.fiscalPeriod.findFirst({ where: { id, business_id: auth.businessId } });
      if (!p) throw notFound("Fiscal period");
      if (p.status === "CLOSED") throw conflict("PERIOD_CLOSED", "Period is already closed");
      const earlierOpen = await tx.fiscalPeriod.count({ where: { business_id: auth.businessId, status: "OPEN", end_date: { lt: p.start_date } } });
      if (earlierOpen) throw invalid("EARLIER_OPEN", "Close earlier periods first");
      await tx.fiscalPeriod.update({ where: { id }, data: { status: "CLOSED", closed_by_id: auth.userId, closed_at: new Date() } });
      await this.audit.record(auth, { action: "period.closed", entityType: "fiscal_period", entityId: id, summary: `Period ${p.name} closed` }, tx);
      return tx.fiscalPeriod.findUnique({ where: { id } });
    });
  }

  async requestReopen(auth: AuthContext, id: string, reason: string) {
    const p = await this.prisma.client.fiscalPeriod.findFirst({ where: { id, business_id: auth.businessId } });
    if (!p) throw notFound("Fiscal period");
    if (p.status !== "CLOSED") throw invalid("PERIOD_OPEN", "Period is open");
    return this.approvals.request(auth, { type: "PERIOD_REOPEN", reason, subjectType: "fiscal_period", subjectId: id, payload: { period: p.name } });
  }
}
