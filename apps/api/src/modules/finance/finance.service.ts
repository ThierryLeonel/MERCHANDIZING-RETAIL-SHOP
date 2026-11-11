import { Injectable } from "@nestjs/common";
import type { Prisma, Tx } from "@retail/db";
import { AuthContext, assertBranch, assertCan, branchFilter } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { conflict, forbidden, invalid, notFound } from "../../common/errors";
import { ApprovalRequiredError } from "../../common/errors";
import { D, Dec, money, sum, ZERO } from "../../common/money";
import { PageQuery, pageArgs, paginate } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { SequenceService } from "../../common/sequence.service";
import { businessDate, SettingsService } from "../../common/settings.service";
import { PostingService } from "../accounting/posting.service";
import { ApprovalsService } from "../approvals/approvals.service";

@Injectable()
export class FinanceService {
  constructor(private prisma: PrismaService, private seq: SequenceService, private audit: AuditService, private settings: SettingsService, private posting: PostingService, private approvals: ApprovalsService) {}

  // ---------------------------------------------------- cashier sessions ----
  async openSession(auth: AuthContext, input: { register_id: string; opening_float: string | number; float_source_account_id?: string }) {
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const reg = await tx.cashRegister.findFirst({ where: { id: input.register_id, business_id: auth.businessId, active: true } });
      if (!reg) throw notFound("Register");
      assertBranch(auth, reg.branch_id);
      const mine = await tx.cashierSession.findFirst({ where: { user_id: auth.userId, status: { not: "CLOSED" } } });
      if (mine) throw conflict("SESSION_ALREADY_OPEN", "You already have an open session; close it first");
      const float = money(input.opening_float, dec);
      if (float.lt(0)) throw invalid("INVALID_AMOUNT", "Opening float cannot be negative");
      let sourceId: string | null = null;
      if (float.gt(0)) {
        const src = input.float_source_account_id
          ? await tx.financialAccount.findFirst({ where: { id: input.float_source_account_id, business_id: auth.businessId } })
          : await tx.financialAccount.findFirst({ where: { business_id: auth.businessId, branch_id: reg.branch_id, kind: "SAFE", active: true } });
        if (!src) throw invalid("FLOAT_SOURCE_REQUIRED", "Choose the safe/petty cash account the float comes from");
        sourceId = src.id;
      }
      const number = await this.seq.next(tx, auth.businessId, "SESSION", "CS-");
      let session;
      try {
        session = await tx.cashierSession.create({ data: { business_id: auth.businessId, branch_id: reg.branch_id, register_id: reg.id, user_id: auth.userId, number, opening_float: float, float_source_account_id: sourceId } });
      } catch {
        throw conflict("REGISTER_IN_USE", "This register already has an open session");
      }
      if (float.gt(0)) {
        const till = await tx.financialAccount.findUniqueOrThrow({ where: { id: reg.till_account_id } });
        const src = await tx.financialAccount.findUniqueOrThrow({ where: { id: sourceId! } });
        const j = await this.posting.post(tx, {
          businessId: auth.businessId, branchId: reg.branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "cashier_session", sourceId: session.id, sourceNumber: number,
          description: `Opening float ${number}`, createdById: auth.userId, currencyDecimals: dec,
          lines: [{ accountId: till.gl_account_id, debit: float, financialAccountId: till.id }, { accountId: src.gl_account_id, credit: float, financialAccountId: src.id }],
        });
        await tx.cashMovement.create({ data: { business_id: auth.businessId, cashier_session_id: session.id, kind: "OPENING_FLOAT", amount: float, counter_account_id: sourceId, reason: "Opening float", journal_entry_id: j?.id, created_by_id: auth.userId } });
      }
      await this.audit.record(auth, { action: "session.opened", entityType: "cashier_session", entityId: session.id, summary: `${number} opened with float ${float}`, branchId: reg.branch_id }, tx);
      return session;
    });
  }

  /** Expected cash = float + cash collections − cash refunds + cash in − drops − paid-outs. */
  async sessionSummary(tx: Tx, sessionId: string) {
    const s = await tx.cashierSession.findUniqueOrThrow({ where: { id: sessionId } });
    const [cashPays, refunds, movements, byMethod, salesAgg] = await Promise.all([
      tx.payment.aggregate({ where: { cashier_session_id: sessionId, method: "CASH", status: "CONFIRMED", sale: { status: "COMPLETED" } }, _sum: { amount: true, amount_tendered: true, change_given: true } }),
      tx.refund.aggregate({ where: { cashier_session_id: sessionId, method: "CASH" }, _sum: { amount: true } }),
      tx.cashMovement.groupBy({ by: ["kind"], where: { cashier_session_id: sessionId }, _sum: { amount: true } }),
      tx.payment.groupBy({ by: ["method"], where: { cashier_session_id: sessionId, status: "CONFIRMED", sale: { status: "COMPLETED" } }, _sum: { amount: true }, _count: true }),
      tx.sale.aggregate({ where: { cashier_session_id: sessionId, status: "COMPLETED" }, _sum: { total: true, discount_total: true }, _count: true }),
    ]);
    const mv = (k: string) => D(movements.find((m) => m.kind === k)?._sum.amount ?? 0);
    const cashSales = D(cashPays._sum.amount ?? 0);
    const cashRefunds = D(refunds._sum.amount ?? 0);
    const expected = D(s.opening_float).plus(cashSales).minus(cashRefunds).plus(mv("CASH_IN")).minus(mv("CASH_DROP")).minus(mv("PAID_OUT"));
    return {
      session: s,
      opening_float: D(s.opening_float), cash_sales: cashSales, cash_tendered: D(cashPays._sum.amount_tendered ?? 0), change_given: D(cashPays._sum.change_given ?? 0),
      cash_refunds: cashRefunds, cash_in: mv("CASH_IN"), cash_drops: mv("CASH_DROP"), paid_outs: mv("PAID_OUT"), expected_cash: expected,
      collections_by_method: byMethod.map((m) => ({ method: m.method, amount: D(m._sum.amount ?? 0), count: m._count })),
      sales_count: salesAgg._count, sales_total: D(salesAgg._sum.total ?? 0), discounts: D(salesAgg._sum.discount_total ?? 0),
    };
  }

  private async lockSession(tx: Tx, auth: AuthContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cashier_sessions WHERE id = ${id}::uuid AND business_id = ${auth.businessId}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound("Cashier session");
    const s = await tx.cashierSession.findUniqueOrThrow({ where: { id } });
    assertBranch(auth, s.branch_id);
    if (s.user_id !== auth.userId && !auth.permissions.has("sessions.view_all")) throw forbidden("This session belongs to another cashier");
    return s;
  }

  async cashMovement(auth: AuthContext, sessionId: string, input: { kind: "CASH_DROP" | "PAID_OUT" | "CASH_IN"; amount: string | number; counter_account_id?: string; expense_account_id?: string; reason: string; approval_request_id?: string }) {
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    if (input.kind === "CASH_DROP") assertCan(auth, "sessions.cash_drop");
    if (input.kind === "PAID_OUT") assertCan(auth, "sessions.paid_out");
    if (!input.reason?.trim()) throw invalid("REASON_REQUIRED", "A reason is required");
    return this.prisma.tx(async (tx) => {
      const s = await this.lockSession(tx, auth, sessionId);
      if (s.status !== "OPEN") throw conflict("SESSION_NOT_OPEN", "Session is not open");
      const amount = money(input.amount, dec);
      if (!amount.gt(0)) throw invalid("INVALID_AMOUNT", "Amount must be positive");
      const reg = await tx.cashRegister.findUniqueOrThrow({ where: { id: s.register_id } });
      const till = await tx.financialAccount.findUniqueOrThrow({ where: { id: reg.till_account_id } });
      if (input.kind !== "CASH_IN") {
        const summary = await this.sessionSummary(tx, s.id);
        if (amount.greaterThan(summary.expected_cash)) throw invalid("INSUFFICIENT_CASH", `The till is expected to hold only ${summary.expected_cash}`);
      }
      let approvalId: string | null = null;
      if (input.kind === "PAID_OUT" && (await this.approvals.isRequired(tx, auth.businessId, "PAID_OUT", { amount }))) {
        if (!input.approval_request_id) throw new ApprovalRequiredError("PAID_OUT", `Paid-out of ${amount} needs approval`, { amount: amount.toString() });
        await this.approvals.consume(tx, auth, input.approval_request_id, "PAID_OUT", { minAmount: amount });
        approvalId = input.approval_request_id;
      }
      const lines: any[] = [];
      if (input.kind === "PAID_OUT") {
        if (!input.expense_account_id) throw invalid("EXPENSE_ACCOUNT_REQUIRED", "Choose the expense account");
        lines.push({ accountId: input.expense_account_id, debit: amount, memo: input.reason }, { accountId: till.gl_account_id, credit: amount, financialAccountId: till.id });
      } else {
        const other = input.counter_account_id
          ? await tx.financialAccount.findFirst({ where: { id: input.counter_account_id, business_id: auth.businessId } })
          : await tx.financialAccount.findFirst({ where: { business_id: auth.businessId, branch_id: s.branch_id, kind: "SAFE", active: true } });
        if (!other) throw invalid("ACCOUNT_REQUIRED", "Choose the safe account");
        const [dr, cr] = input.kind === "CASH_DROP" ? [other, till] : [till, other];
        lines.push({ accountId: dr.gl_account_id, debit: amount, financialAccountId: dr.id, memo: input.reason }, { accountId: cr.gl_account_id, credit: amount, financialAccountId: cr.id });
        input.counter_account_id = other.id;
      }
      const j = await this.posting.post(tx, { businessId: auth.businessId, branchId: s.branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "cash_movement", sourceId: s.id, sourceNumber: s.number, description: `${input.kind.replace("_", " ").toLowerCase()} ${s.number}: ${input.reason}`, createdById: auth.userId, currencyDecimals: dec, lines });
      const m = await tx.cashMovement.create({ data: { business_id: auth.businessId, cashier_session_id: s.id, kind: input.kind, amount, counter_account_id: input.counter_account_id ?? null, expense_account_id: input.expense_account_id ?? null, reason: input.reason, approval_request_id: approvalId, journal_entry_id: j?.id, created_by_id: auth.userId } });
      await this.audit.record(auth, { action: `session.${input.kind.toLowerCase()}`, entityType: "cashier_session", entityId: s.id, summary: `${input.kind} ${amount} on ${s.number}: ${input.reason}`, branchId: s.branch_id }, tx);
      return m;
    });
  }

  /**
   * Closes a session: records the count, posts any variance (cash over/short)
   * and transfers the counted cash to the safe so the till returns to zero.
   * Variances need a reason; above the policy threshold they need approval.
   */
  async closeSession(auth: AuthContext, sessionId: string, input: { counted_cash: string | number; denominations?: Record<string, number>; variance_reason?: string; approval_request_id?: string; transfer_to_account_id?: string }) {
    assertCan(auth, "sessions.close");
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const s = await this.lockSession(tx, auth, sessionId);
      if (s.status !== "OPEN") throw conflict("SESSION_NOT_OPEN", "Session is already closed");
      const pending = await tx.sale.count({ where: { cashier_session_id: s.id, status: "PENDING_PAYMENT" } });
      if (pending) throw conflict("PENDING_SALES", `Resolve ${pending} sale(s) awaiting payment before closing`);
      const summary = await this.sessionSummary(tx, s.id);
      const counted = money(input.counted_cash, dec);
      if (counted.lt(0)) throw invalid("INVALID_AMOUNT", "Counted cash cannot be negative");
      const variance = counted.minus(summary.expected_cash);
      let approvalId: string | null = null;
      if (!variance.isZero()) {
        if (!input.variance_reason?.trim()) throw invalid("VARIANCE_REASON_REQUIRED", `Counted cash differs from expected by ${variance}. Explain the variance.`, { expected: summary.expected_cash.toString(), variance: variance.toString() });
        if (await this.approvals.isRequired(tx, auth.businessId, "CASH_VARIANCE", { amount: variance })) {
          if (!input.approval_request_id) throw new ApprovalRequiredError("CASH_VARIANCE", `Variance of ${variance} exceeds the tolerance and needs approval`, { amount: variance.abs().toString(), expected: summary.expected_cash.toString(), variance: variance.toString() });
          await this.approvals.consume(tx, auth, input.approval_request_id, "CASH_VARIANCE", { minAmount: variance.abs() });
          approvalId = input.approval_request_id;
        }
      }
      await tx.cashCount.create({ data: { cashier_session_id: s.id, denominations: input.denominations ?? {}, total: counted, counted_by_id: auth.userId } });
      const reg = await tx.cashRegister.findUniqueOrThrow({ where: { id: s.register_id } });
      const till = await tx.financialAccount.findUniqueOrThrow({ where: { id: reg.till_account_id } });
      const dest = input.transfer_to_account_id
        ? await tx.financialAccount.findFirst({ where: { id: input.transfer_to_account_id, business_id: auth.businessId } })
        : await tx.financialAccount.findFirst({ where: { business_id: auth.businessId, branch_id: s.branch_id, kind: "SAFE", active: true } });
      if (!dest) throw invalid("ACCOUNT_REQUIRED", "Choose where the counted cash goes (safe)");
      const lines: any[] = [];
      if (variance.gt(0)) lines.push({ accountId: till.gl_account_id, debit: variance, financialAccountId: till.id, memo: "Cash over" }, { account: "cash_over", credit: variance, memo: input.variance_reason });
      if (variance.lt(0)) lines.push({ account: "cash_short", debit: variance.neg(), memo: input.variance_reason }, { accountId: till.gl_account_id, credit: variance.neg(), financialAccountId: till.id, memo: "Cash short" });
      if (counted.gt(0)) lines.push({ accountId: dest.gl_account_id, debit: counted, financialAccountId: dest.id, memo: "Session takings" }, { accountId: till.gl_account_id, credit: counted, financialAccountId: till.id, memo: "Session takings" });
      const j = lines.length ? await this.posting.post(tx, { businessId: auth.businessId, branchId: s.branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "cashier_session_close", sourceId: s.id, sourceNumber: s.number, description: `Close ${s.number}`, createdById: auth.userId, currencyDecimals: dec, lines }) : null;
      await tx.cashierSession.update({
        where: { id: s.id },
        data: { status: "CLOSED", closed_at: new Date(), expected_cash: summary.expected_cash, counted_cash: counted, variance, variance_reason: input.variance_reason ?? null, variance_approval_id: approvalId, closing_transfer_account_id: dest.id, closing_journal_id: j?.id ?? null, closed_by_id: auth.userId },
      });
      await this.audit.record(auth, { action: "session.closed", entityType: "cashier_session", entityId: s.id, summary: `${s.number} closed: expected ${summary.expected_cash}, counted ${counted}, variance ${variance}`, branchId: s.branch_id }, tx);
      return { ...(await tx.cashierSession.findUniqueOrThrow({ where: { id: s.id } })), summary };
    });
  }

  listSessions(auth: AuthContext, q: PageQuery & { status?: string; branch_id?: string }) {
    const where: Prisma.CashierSessionWhereInput = {
      business_id: auth.businessId, ...branchFilter(auth), ...(q.status ? { status: q.status as any } : {}), ...(q.branch_id ? { branch_id: q.branch_id } : {}),
      ...(auth.permissions.has("sessions.view_all") ? {} : { user_id: auth.userId }),
    };
    return paginate(q, this.prisma.client.cashierSession.count({ where }), this.prisma.client.cashierSession.findMany({ where, ...pageArgs(q), orderBy: { opened_at: "desc" } })).then(async (page) => {
      const [users, regs] = await Promise.all([
        this.prisma.client.user.findMany({ where: { id: { in: page.items.map((s) => s.user_id) } }, select: { id: true, full_name: true } }),
        this.prisma.client.cashRegister.findMany({ where: { id: { in: page.items.map((s) => s.register_id) } }, select: { id: true, name: true, code: true } }),
      ]);
      return { ...page, items: page.items.map((s) => ({ ...s, cashier_name: users.find((u) => u.id === s.user_id)?.full_name, register_name: regs.find((r) => r.id === s.register_id)?.name })) };
    });
  }

  async getSession(auth: AuthContext, id: string) {
    const s = await this.prisma.client.cashierSession.findFirst({ where: { id, business_id: auth.businessId } });
    if (!s) throw notFound("Session");
    assertBranch(auth, s.branch_id);
    if (s.user_id !== auth.userId && !auth.permissions.has("sessions.view_all")) throw forbidden();
    const summary = await this.sessionSummary(this.prisma.client as unknown as Tx, id);
    const movements = await this.prisma.client.cashMovement.findMany({ where: { cashier_session_id: id }, orderBy: { created_at: "asc" } });
    return { ...summary, movements };
  }

  async currentSession(auth: AuthContext) {
    const s = await this.prisma.client.cashierSession.findFirst({ where: { user_id: auth.userId, status: "OPEN" } });
    if (!s) return null;
    return this.getSession(auth, s.id);
  }

  // ----------------------------------------------------- funds transfers ----
  /** Internal transfer between financial accounts (not an expense). Optional bank fee is expensed. */
  async transfer(auth: AuthContext, input: { from_account_id: string; to_account_id: string; amount: string | number; fee_amount?: string | number; transfer_date: string; reference?: string }) {
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      if (input.from_account_id === input.to_account_id) throw invalid("SAME_ACCOUNT", "Choose two different accounts");
      const [from, to] = await Promise.all([
        tx.financialAccount.findFirst({ where: { id: input.from_account_id, business_id: auth.businessId } }),
        tx.financialAccount.findFirst({ where: { id: input.to_account_id, business_id: auth.businessId } }),
      ]);
      if (!from || !to) throw notFound("Financial account");
      if (from.kind === "TILL" || to.kind === "TILL") throw invalid("TILL_TRANSFER", "Use cashier session drops/close for till movements");
      const amount = money(input.amount, dec), fee = money(input.fee_amount ?? 0, dec);
      if (!amount.gt(0) || fee.lt(0)) throw invalid("INVALID_AMOUNT", "Amount must be positive");
      const number = await this.seq.next(tx, auth.businessId, "TRANSFER", "FT-");
      const t = await tx.fundsTransfer.create({ data: { business_id: auth.businessId, number, from_account_id: from.id, to_account_id: to.id, amount, fee_amount: fee, reference: input.reference ?? null, transfer_date: new Date(`${input.transfer_date}T00:00:00Z`), created_by_id: auth.userId } });
      const j = await this.posting.post(tx, {
        businessId: auth.businessId, branchId: from.branch_id ?? to.branch_id, entryDate: input.transfer_date, sourceType: "funds_transfer", sourceId: t.id, sourceNumber: number, description: `Transfer ${from.name} → ${to.name}`, createdById: auth.userId, currencyDecimals: dec,
        lines: [
          { accountId: to.gl_account_id, debit: amount.minus(fee), financialAccountId: to.id },
          { account: "payment_fees", debit: fee, memo: "Transfer fee" },
          { accountId: from.gl_account_id, credit: amount, financialAccountId: from.id },
        ],
      });
      await tx.fundsTransfer.update({ where: { id: t.id }, data: { journal_entry_id: j?.id } });
      await this.audit.record(auth, { action: "funds.transferred", entityType: "funds_transfer", entityId: t.id, summary: `${number}: ${amount} ${from.name} → ${to.name}` }, tx);
      return t;
    });
  }

  /** Book balances of financial accounts from the ledger. */
  async accountBalances(auth: AuthContext) {
    const fas = await this.prisma.client.financialAccount.findMany({ where: { business_id: auth.businessId, ...(auth.allBranches ? {} : { OR: [{ branch_id: null }, { branch_id: { in: auth.branchIds } }] }) }, orderBy: { code: "asc" } });
    const sums = await this.prisma.client.journalLine.groupBy({ by: ["account_id"], where: { account_id: { in: fas.map((f) => f.gl_account_id) } }, _sum: { debit: true, credit: true } });
    return fas.map((f) => { const s = sums.find((x) => x.account_id === f.gl_account_id); return { ...f, balance: D(s?._sum.debit ?? 0).minus(D(s?._sum.credit ?? 0)) }; });
  }

  // ------------------------------------------------------------ expenses ----
  async createExpense(auth: AuthContext, input: { branch_id: string; expense_date: string; payee: string; financial_account_id: string; reference?: string; lines: { expense_category_id: string; description: string; amount: string | number }[] }) {
    assertBranch(auth, input.branch_id);
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const fa = await tx.financialAccount.findFirst({ where: { id: input.financial_account_id, business_id: auth.businessId, active: true } });
      if (!fa) throw notFound("Financial account");
      if (fa.kind === "TILL") throw invalid("TILL_EXPENSE", "Pay expenses from the till through a session paid-out");
      const cats = await tx.expenseCategory.findMany({ where: { business_id: auth.businessId, id: { in: input.lines.map((l) => l.expense_category_id) } } });
      const lines = input.lines.map((l) => {
        const c = cats.find((x) => x.id === l.expense_category_id);
        if (!c) throw notFound("Expense category");
        const amount = money(l.amount, dec);
        if (!amount.gt(0)) throw invalid("INVALID_AMOUNT", "Amounts must be positive");
        return { ...l, amount, account_id: c.account_id };
      });
      const total = sum(lines, (l) => l.amount);
      const number = await this.seq.next(tx, auth.businessId, "EXPENSE", "EXP-");
      const e = await tx.expense.create({ data: { business_id: auth.businessId, branch_id: input.branch_id, number, expense_date: new Date(`${input.expense_date}T00:00:00Z`), payee: input.payee, financial_account_id: fa.id, reference: input.reference ?? null, total, created_by_id: auth.userId, lines: { create: lines.map((l) => ({ expense_category_id: l.expense_category_id, description: l.description, amount: l.amount })) } } });
      const j = await this.posting.post(tx, {
        businessId: auth.businessId, branchId: input.branch_id, entryDate: input.expense_date, sourceType: "expense", sourceId: e.id, sourceNumber: number, description: `Expense ${number} — ${input.payee}`, createdById: auth.userId, currencyDecimals: dec,
        lines: [...lines.map((l) => ({ accountId: l.account_id, debit: l.amount, memo: l.description })), { accountId: fa.gl_account_id, credit: total, financialAccountId: fa.id }],
      });
      await tx.expense.update({ where: { id: e.id }, data: { journal_entry_id: j?.id } });
      await this.audit.record(auth, { action: "expense.posted", entityType: "expense", entityId: e.id, summary: `${number} ${input.payee} ${total}`, branchId: input.branch_id }, tx);
      return tx.expense.findUniqueOrThrow({ where: { id: e.id }, include: { lines: true } });
    });
  }

  listExpenses(auth: AuthContext, q: PageQuery) {
    const where: Prisma.ExpenseWhereInput = { business_id: auth.businessId, ...branchFilter(auth), ...(q.search ? { OR: [{ payee: { contains: q.search, mode: "insensitive" } }, { number: { contains: q.search, mode: "insensitive" } }] } : {}) };
    return paginate(q, this.prisma.client.expense.count({ where }), this.prisma.client.expense.findMany({ where, ...pageArgs(q), orderBy: { expense_date: "desc" }, include: { lines: true } }));
  }
}
