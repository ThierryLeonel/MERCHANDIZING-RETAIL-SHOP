import { Injectable } from "@nestjs/common";
import type { Prisma, Tx } from "@retail/db";
import { AuthContext, assertBranch, assertCan } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { invalid, notFound } from "../../common/errors";
import { D, money, ZERO } from "../../common/money";
import { PageQuery, pageArgs, paginate, orderBy } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { SequenceService } from "../../common/sequence.service";
import { SettingsService, businessDate } from "../../common/settings.service";
import { PostingService } from "../accounting/posting.service";

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService, private seq: SequenceService, private audit: AuditService, private settings: SettingsService, private posting: PostingService) {}

  async create(auth: AuthContext, input: { name: string; phone?: string; email?: string; address?: string; customer_group_id?: string; credit_limit?: string; payment_terms_days?: number; credit_status?: "NONE" | "ACTIVE" | "ON_HOLD" }) {
    if ((input.credit_limit && D(input.credit_limit).gt(0)) || (input.credit_status && input.credit_status !== "NONE")) assertCan(auth, "customers.credit", "Setting credit terms requires customers.credit");
    return this.prisma.tx(async (tx) => {
      const code = await this.seq.next(tx, auth.businessId, "CUSTOMER", "C-", 5);
      const c = await tx.customer.create({ data: { business_id: auth.businessId, code, name: input.name.trim(), phone: input.phone ?? null, email: input.email ?? null, address: input.address ?? null, customer_group_id: input.customer_group_id ?? null, credit_limit: D(input.credit_limit ?? 0), payment_terms_days: input.payment_terms_days ?? 0, credit_status: input.credit_status ?? "NONE" } });
      await this.audit.record(auth, { action: "customer.created", entityType: "customer", entityId: c.id, summary: `Customer ${c.code} ${c.name} created` }, tx);
      return c;
    });
  }

  async update(auth: AuthContext, id: string, input: { name?: string; phone?: string; email?: string; address?: string; customer_group_id?: string; credit_limit?: string; payment_terms_days?: number; credit_status?: "NONE" | "ACTIVE" | "ON_HOLD"; active?: boolean }) {
    const c = await this.prisma.client.customer.findFirst({ where: { id, business_id: auth.businessId } });
    if (!c) throw notFound("Customer");
    if (input.credit_limit !== undefined || input.credit_status !== undefined || input.payment_terms_days !== undefined) assertCan(auth, "customers.credit", "Changing credit terms requires customers.credit");
    const u = await this.prisma.client.customer.update({ where: { id }, data: { ...input, credit_limit: input.credit_limit !== undefined ? D(input.credit_limit) : undefined } });
    await this.audit.record(auth, { action: "customer.updated", entityType: "customer", entityId: id, summary: `Customer ${c.code} updated`, data: { before: { credit_limit: c.credit_limit, credit_status: c.credit_status }, after: input } });
    return u;
  }

  list(auth: AuthContext, q: PageQuery) {
    const where: Prisma.CustomerWhereInput = { business_id: auth.businessId, ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { phone: { contains: q.search } }, { code: { contains: q.search, mode: "insensitive" } }] } : {}) };
    return paginate(q, this.prisma.client.customer.count({ where }), this.prisma.client.customer.findMany({ where, ...pageArgs(q), orderBy: orderBy(q, ["name", "code", "created_at"], "name") }));
  }

  /** Receivable and deposit balances from control accounts. */
  async balances(tx: Tx, businessId: string, customerId: string) {
    const [ar, dep] = await Promise.all([this.posting.accountIdFor(tx, businessId, "customer_receivable"), this.posting.accountIdFor(tx, businessId, "customer_deposit")]);
    const rows = await tx.journalLine.groupBy({ by: ["account_id"], where: { customer_id: customerId, account_id: { in: [ar, dep] } }, _sum: { debit: true, credit: true } });
    const net = (id: string) => { const r = rows.find((x) => x.account_id === id); return D(r?._sum.debit ?? 0).minus(D(r?._sum.credit ?? 0)); };
    return { receivable: net(ar), deposits: net(dep).neg() };
  }

  async get(auth: AuthContext, id: string) {
    const c = await this.prisma.client.customer.findFirst({ where: { id, business_id: auth.businessId } });
    if (!c) throw notFound("Customer");
    const bal = await this.balances(this.prisma.client as unknown as Tx, auth.businessId, id);
    const open = await this.prisma.client.sale.findMany({ where: { customer_id: id, status: "COMPLETED", credit_amount: { gt: 0 } }, orderBy: { completed_at: "asc" }, select: { id: true, number: true, completed_at: true, due_date: true, total: true, credit_amount: true, credit_settled: true } });
    const recent = await this.prisma.client.sale.findMany({ where: { customer_id: id, status: "COMPLETED" }, orderBy: { completed_at: "desc" }, take: 20, select: { id: true, number: true, completed_at: true, total: true } });
    return { ...c, ...bal, available_credit: D(c.credit_limit).minus(bal.receivable), open_invoices: open.filter((s) => D(s.credit_amount).gt(s.credit_settled)).map((s) => ({ ...s, outstanding: D(s.credit_amount).minus(s.credit_settled) })), recent_sales: recent };
  }

  /**
   * Account payment: allocations settle credit sales (Cr Receivable); any
   * unallocated amount is a customer deposit (Cr Customer deposits) — never revenue.
   */
  async receivePayment(auth: AuthContext, customerId: string, input: { branch_id: string; financial_account_id: string; amount: string | number; reference?: string; allocations?: { sale_id: string; amount: string | number }[] }) {
    assertCan(auth, "customers.credit");
    assertBranch(auth, input.branch_id);
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    return this.prisma.tx(async (tx) => {
      const c = await tx.customer.findFirst({ where: { id: customerId, business_id: auth.businessId } });
      if (!c) throw notFound("Customer");
      const fa = await tx.financialAccount.findFirst({ where: { id: input.financial_account_id, business_id: auth.businessId, active: true } });
      if (!fa) throw notFound("Financial account");
      if (fa.kind === "TILL") throw invalid("TILL_NOT_ALLOWED", "Record account payments to a safe, bank or wallet account (till cash is reconciled per session)");
      const amount = money(input.amount, dec);
      if (!amount.gt(0)) throw invalid("INVALID_AMOUNT", "Amount must be positive");
      const payment = await tx.payment.create({ data: { business_id: auth.businessId, branch_id: input.branch_id, customer_id: c.id, method: fa.kind === "BANK" ? "BANK_TRANSFER" : fa.kind === "MOBILE_MONEY" ? "MOBILE_MONEY" : "CASH", status: "CONFIRMED", amount, financial_account_id: fa.id, provider_reference: input.reference ?? null, confirmation_mode: "MANUAL", confirmed_by_id: auth.userId, confirmed_at: new Date(), created_by_id: auth.userId } });
      let allocated = ZERO;
      for (const a of input.allocations ?? []) {
        await tx.$queryRaw`SELECT id FROM sales WHERE id = ${a.sale_id}::uuid FOR UPDATE`;
        const s = await tx.sale.findFirst({ where: { id: a.sale_id, customer_id: c.id, status: "COMPLETED" } });
        if (!s) throw notFound("Credit sale");
        const amt = money(a.amount, dec);
        const outstanding = D(s.credit_amount).minus(s.credit_settled);
        if (!amt.gt(0) || amt.greaterThan(outstanding)) throw invalid("OVER_ALLOCATION", `Allocation exceeds outstanding ${outstanding} on ${s.number}`);
        await tx.sale.update({ where: { id: s.id }, data: { credit_settled: D(s.credit_settled).plus(amt) } });
        await tx.salePaymentAllocation.create({ data: { payment_id: payment.id, sale_id: s.id, amount: amt } });
        allocated = allocated.plus(amt);
      }
      if (allocated.greaterThan(amount)) throw invalid("OVER_ALLOCATION", "Allocations exceed the payment");
      const unallocated = amount.minus(allocated);
      const number = await this.seq.next(tx, auth.businessId, "RECEIPT", "RCPT-");
      await this.posting.post(tx, {
        businessId: auth.businessId, branchId: input.branch_id, entryDate: businessDate(new Date(), b.timezone), sourceType: "customer_payment", sourceId: payment.id, sourceNumber: number,
        description: `Account payment ${number} — ${c.name}`, createdById: auth.userId, currencyDecimals: dec,
        lines: [
          { accountId: fa.gl_account_id, debit: amount, financialAccountId: fa.id, memo: input.reference },
          { account: "customer_receivable", credit: allocated, customerId: c.id },
          { account: "customer_deposit", credit: unallocated, customerId: c.id, memo: "Unapplied payment / deposit" },
        ],
      });
      await this.audit.record(auth, { action: "customer.payment", entityType: "customer", entityId: c.id, summary: `${number}: ${amount} received (${unallocated} unapplied)`, branchId: input.branch_id }, tx);
      return { payment_id: payment.id, number, allocated, unallocated };
    });
  }

  /** Statement from the receivable/deposit control accounts (running balance). */
  async statement(auth: AuthContext, id: string) {
    const c = await this.prisma.client.customer.findFirst({ where: { id, business_id: auth.businessId } });
    if (!c) throw notFound("Customer");
    const db = this.prisma.client as unknown as Tx;
    const [ar, dep] = await Promise.all([this.posting.accountIdFor(db, auth.businessId, "customer_receivable"), this.posting.accountIdFor(db, auth.businessId, "customer_deposit")]);
    const lines = await this.prisma.client.journalLine.findMany({ where: { customer_id: id, account_id: { in: [ar, dep] } }, include: { journal_entry: true }, orderBy: [{ journal_entry: { posted_at: "asc" } }, { line_no: "asc" }] });
    let running = ZERO;
    return {
      customer: c,
      lines: lines.map((l) => {
        running = running.plus(l.debit).minus(l.credit);
        return { date: l.journal_entry.entry_date, number: l.journal_entry.number, source_number: l.journal_entry.source_number, description: l.journal_entry.description, account: l.account_id === ar ? "Receivable" : "Deposit", debit: l.debit, credit: l.credit, balance: running };
      }),
      closing_balance: running,
    };
  }

  /** Receivables ageing by due date buckets (business-local today). */
  async ageing(auth: AuthContext) {
    const b = await this.settings.business(auth.businessId);
    const today = businessDate(new Date(), b.timezone);
    const rows = await this.prisma.client.$queryRaw<any[]>`
      SELECT c.id AS customer_id, c.code, c.name,
        SUM(CASE WHEN s.due_date >= ${today}::date THEN s.credit_amount - s.credit_settled ELSE 0 END) AS current,
        SUM(CASE WHEN ${today}::date - s.due_date BETWEEN 1 AND 30 THEN s.credit_amount - s.credit_settled ELSE 0 END) AS d1_30,
        SUM(CASE WHEN ${today}::date - s.due_date BETWEEN 31 AND 60 THEN s.credit_amount - s.credit_settled ELSE 0 END) AS d31_60,
        SUM(CASE WHEN ${today}::date - s.due_date BETWEEN 61 AND 90 THEN s.credit_amount - s.credit_settled ELSE 0 END) AS d61_90,
        SUM(CASE WHEN ${today}::date - s.due_date > 90 THEN s.credit_amount - s.credit_settled ELSE 0 END) AS d90_plus,
        SUM(s.credit_amount - s.credit_settled) AS total
      FROM sales s JOIN customers c ON c.id = s.customer_id
      WHERE s.business_id = ${auth.businessId}::uuid AND s.status = 'COMPLETED' AND s.credit_amount > s.credit_settled
      GROUP BY c.id, c.code, c.name ORDER BY total DESC`;
    return { as_of: today, rows };
  }

  groups(auth: AuthContext) {
    return this.prisma.client.customerGroup.findMany({ where: { business_id: auth.businessId }, orderBy: { name: "asc" } });
  }
}
