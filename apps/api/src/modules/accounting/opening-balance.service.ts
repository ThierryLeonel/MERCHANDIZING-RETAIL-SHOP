import { Injectable } from "@nestjs/common";
import { AuthContext, assertCan } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { invalid, notFound } from "../../common/errors";
import { D, money, sum, ZERO } from "../../common/money";
import { PrismaService } from "../../common/prisma.service";
import { SequenceService } from "../../common/sequence.service";
import { SettingsService, businessDate } from "../../common/settings.service";
import { PostingLine, PostingService } from "./posting.service";

type Amount = string | number;
export interface OpeningBalanceInput {
  as_of_date: string;
  notes?: string;
  /** Balance of each cash / bank / wallet account (negative = overdraft). */
  accounts?: { financial_account_id: string; amount: Amount }[];
  /** What each customer owed (receivable) and/or held as store credit (deposit). */
  customers?: { customer_id: string; owed?: Amount; store_credit?: Amount; reference?: string; due_date?: string }[];
  /** What the business owed each supplier. */
  suppliers?: { supplier_id: string; owed: Amount; reference?: string; due_date?: string }[];
  /** Any other balance (loans, equipment, capital, other receivables…). */
  other?: { account_id: string; debit?: Amount; credit?: Amount; memo?: string }[];
}

/**
 * Opening balances for a business starting to use the system. One document
 * posts one journal (source "opening_balance"); the difference between debits
 * and credits goes to Opening balance equity. Customer amounts become open items
 * that later payments settle, supplier amounts become opening supplier invoices,
 * so statements, ageing, payments and the control-account reconciliation all
 * include them. Opening stock is entered separately (it needs quantities and
 * costs per product) through Import → Opening stock.
 */
@Injectable()
export class OpeningBalanceService {
  constructor(private prisma: PrismaService, private posting: PostingService, private seq: SequenceService, private settings: SettingsService, private audit: AuditService) {}

  /** GL accounts that may take a free opening balance: postable, active, not system-controlled, not a cash/bank account. */
  private async eligibleAccounts(businessId: string) {
    const db = this.prisma.client;
    const [accounts, rules, fas] = await Promise.all([
      db.account.findMany({ where: { business_id: businessId, active: true, is_postable: true }, orderBy: { code: "asc" } }),
      db.postingRule.findMany({ where: { business_id: businessId }, select: { account_id: true } }),
      db.financialAccount.findMany({ where: { business_id: businessId }, select: { gl_account_id: true } }),
    ]);
    const blocked = new Set([...rules.map((r) => r.account_id), ...fas.map((f) => f.gl_account_id)]);
    return accounts.filter((a) => !blocked.has(a.id) && !a.is_control);
  }

  async options(auth: AuthContext) {
    assertCan(auth, "accounting.opening_balances");
    const db = this.prisma.client, b = auth.businessId;
    const [fas, customers, suppliers, accounts, inventory, docs] = await Promise.all([
      db.financialAccount.findMany({ where: { business_id: b, active: true, kind: { not: "TILL" } }, orderBy: { code: "asc" } }),
      db.customer.findMany({ where: { business_id: b, active: true }, select: { id: true, code: true, name: true }, orderBy: { name: "asc" } }),
      db.supplier.findMany({ where: { business_id: b, active: true }, select: { id: true, code: true, name: true }, orderBy: { name: "asc" } }),
      this.eligibleAccounts(b),
      db.inventoryCostPool.aggregate({ where: { business_id: b }, _sum: { value: true } }),
      this.list(auth),
    ]);
    const balances = await db.journalLine.groupBy({ by: ["account_id"], where: { account_id: { in: fas.map((f) => f.gl_account_id) } }, _sum: { debit: true, credit: true } });
    return {
      today: businessDate(new Date(), (await this.settings.business(b)).timezone),
      financial_accounts: fas.map((f) => { const x = balances.find((r) => r.account_id === f.gl_account_id); return { id: f.id, code: f.code, name: f.name, kind: f.kind, current_balance: D(x?._sum.debit ?? 0).minus(D(x?._sum.credit ?? 0)) }; }),
      customers, suppliers,
      accounts: accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type })),
      inventory_value: D(inventory._sum.value ?? 0),
      documents: docs,
    };
  }

  list(auth: AuthContext) {
    return this.prisma.client.openingBalance.findMany({ where: { business_id: auth.businessId }, orderBy: { created_at: "desc" } });
  }

  async get(auth: AuthContext, id: string) {
    assertCan(auth, "accounting.opening_balances");
    const ob = await this.prisma.client.openingBalance.findFirst({ where: { id, business_id: auth.businessId } });
    if (!ob) throw notFound("Opening balance");
    const lines = ob.journal_entry_id ? await this.prisma.client.journalLine.findMany({ where: { journal_entry_id: ob.journal_entry_id }, orderBy: { line_no: "asc" } }) : [];
    const ids = (k: "account_id" | "customer_id" | "supplier_id" | "financial_account_id") => [...new Set(lines.map((l) => l[k]).filter(Boolean) as string[])];
    const [accounts, customers, suppliers] = await Promise.all([
      this.prisma.client.account.findMany({ where: { id: { in: ids("account_id") } }, select: { id: true, code: true, name: true } }),
      this.prisma.client.customer.findMany({ where: { id: { in: ids("customer_id") } }, select: { id: true, name: true } }),
      this.prisma.client.supplier.findMany({ where: { id: { in: ids("supplier_id") } }, select: { id: true, name: true } }),
    ]);
    return {
      ...ob,
      lines: lines.map((l) => ({ ...l, account: accounts.find((a) => a.id === l.account_id), customer_name: customers.find((c) => c.id === l.customer_id)?.name ?? null, supplier_name: suppliers.find((s) => s.id === l.supplier_id)?.name ?? null })),
    };
  }

  async create(auth: AuthContext, input: OpeningBalanceInput) {
    assertCan(auth, "accounting.opening_balances");
    const b = await this.settings.business(auth.businessId);
    const dec = b.currency_decimals;
    const db = this.prisma.client;
    const today = businessDate(new Date(), b.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.as_of_date ?? "")) throw invalid("DATE_REQUIRED", "Enter the date of the opening balances (YYYY-MM-DD)");
    if (input.as_of_date > today) throw invalid("FUTURE_DATE", "Opening balances cannot be dated in the future");
    const amt = (v: Amount | undefined, label: string, allowNegative = false) => {
      if (v == null || v === "") return ZERO;
      const d = money(v, dec);
      if (d.isNaN?.() || (!allowNegative && d.lt(0))) throw invalid("INVALID_AMOUNT", `${label}: enter an amount of zero or more`);
      return d;
    };
    const lines: PostingLine[] = [];
    const customerItems: { customer_id: string; amount: ReturnType<typeof money>; reference?: string; due_date: string }[] = [];
    const supplierItems: { supplier_id: string; amount: ReturnType<typeof money>; reference: string; due_date: string }[] = [];

    // cash, bank, wallets
    const seenFa = new Set<string>();
    for (const a of input.accounts ?? []) {
      const v = amt(a.amount, "Account balance", true);
      if (v.equals(0)) continue;
      if (seenFa.has(a.financial_account_id)) throw invalid("DUPLICATE_LINE", "Each cash/bank account can appear only once");
      seenFa.add(a.financial_account_id);
      const fa = await db.financialAccount.findFirst({ where: { id: a.financial_account_id, business_id: auth.businessId, active: true } });
      if (!fa) throw notFound("Financial account");
      if (fa.kind === "TILL") throw invalid("TILL_NOT_ALLOWED", "Tills start empty — put opening cash in the safe and issue floats from there");
      lines.push({ accountId: fa.gl_account_id, financialAccountId: fa.id, branchId: fa.branch_id, ...(v.gt(0) ? { debit: v } : { credit: v.neg() }), memo: `Opening balance — ${fa.name}` });
    }
    // customers
    for (const c of input.customers ?? []) {
      const owed = amt(c.owed, "Customer balance"), credit = amt(c.store_credit, "Store credit");
      if (owed.equals(0) && credit.equals(0)) continue;
      const cust = await db.customer.findFirst({ where: { id: c.customer_id, business_id: auth.businessId } });
      if (!cust) throw notFound("Customer");
      if (owed.gt(0)) {
        const due = c.due_date || input.as_of_date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw invalid("INVALID_DATE", `${cust.name}: due date must be YYYY-MM-DD`);
        lines.push({ account: "customer_receivable", debit: owed, customerId: cust.id, memo: `Opening balance owed by ${cust.name}${c.reference ? ` (${c.reference})` : ""}` });
        customerItems.push({ customer_id: cust.id, amount: owed, reference: c.reference?.trim() || undefined, due_date: due });
      }
      if (credit.gt(0)) lines.push({ account: "customer_deposit", credit, customerId: cust.id, memo: `Opening store credit of ${cust.name}` });
    }
    // suppliers
    for (const s of input.suppliers ?? []) {
      const owed = amt(s.owed, "Supplier balance");
      if (owed.equals(0)) continue;
      const sup = await db.supplier.findFirst({ where: { id: s.supplier_id, business_id: auth.businessId } });
      if (!sup) throw notFound("Supplier");
      const due = s.due_date || input.as_of_date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw invalid("INVALID_DATE", `${sup.name}: due date must be YYYY-MM-DD`);
      lines.push({ account: "supplier_payable", credit: owed, supplierId: sup.id, memo: `Opening balance owed to ${sup.name}${s.reference ? ` (${s.reference})` : ""}` });
      supplierItems.push({ supplier_id: sup.id, amount: owed, reference: s.reference?.trim() || "", due_date: due });
    }
    // other accounts
    const eligible = new Map((await this.eligibleAccounts(auth.businessId)).map((a) => [a.id, a]));
    for (const o of input.other ?? []) {
      const dr = amt(o.debit, "Debit"), cr = amt(o.credit, "Credit");
      if (dr.equals(0) && cr.equals(0)) continue;
      if (dr.gt(0) && cr.gt(0)) throw invalid("DEBIT_AND_CREDIT", "Enter either a debit or a credit on each account line, not both");
      const acc = eligible.get(o.account_id);
      if (!acc) throw invalid("ACCOUNT_NOT_ALLOWED", "That account cannot take an opening balance here (cash/bank accounts, customers, suppliers and stock have their own sections; system accounts are posted automatically)");
      lines.push({ accountId: acc.id, ...(dr.gt(0) ? { debit: dr } : { credit: cr }), memo: o.memo?.trim() || `Opening balance — ${acc.name}` });
    }
    if (!lines.length) throw invalid("NOTHING_TO_POST", "Enter at least one opening balance");

    const totalDr = sum(lines, (l) => D(l.debit ?? 0)), totalCr = sum(lines, (l) => D(l.credit ?? 0));
    const diff = totalDr.minus(totalCr);
    if (!diff.equals(0)) lines.push({ account: "opening_equity", ...(diff.gt(0) ? { credit: diff } : { debit: diff.neg() }), memo: "Balancing figure — opening balance equity" });

    return this.prisma.tx(async (tx) => {
      const number = await this.seq.next(tx, auth.businessId, "OPENING_BALANCE", "OB-", 4);
      const ob = await tx.openingBalance.create({ data: { business_id: auth.businessId, number, as_of_date: new Date(`${input.as_of_date}T00:00:00Z`), notes: input.notes?.trim() || null, total_debit: diff.gt(0) ? totalDr : totalCr, equity_amount: diff.neg(), created_by_id: auth.userId } });
      const je = await this.posting.post(tx, {
        businessId: auth.businessId, entryDate: input.as_of_date, sourceType: "opening_balance", sourceId: ob.id, sourceNumber: number,
        description: `Opening balances ${number} as of ${input.as_of_date}`, createdById: auth.userId, currencyDecimals: dec, lines,
      });
      if (!je) throw invalid("NOTHING_TO_POST", "Enter at least one opening balance");
      await tx.openingBalance.update({ where: { id: ob.id }, data: { journal_entry_id: je.id } });
      for (const c of customerItems) {
        await tx.customerOpeningItem.create({ data: { business_id: auth.businessId, opening_balance_id: ob.id, customer_id: c.customer_id, reference: c.reference ?? number, item_date: new Date(`${input.as_of_date}T00:00:00Z`), due_date: new Date(`${c.due_date}T00:00:00Z`), amount: c.amount } });
      }
      for (const s of supplierItems) {
        let ref = s.reference || `OPENING ${number}`;
        for (let n = 2; await tx.supplierInvoice.findFirst({ where: { supplier_id: s.supplier_id, supplier_invoice_no: ref } }); n++) ref = `${s.reference || `OPENING ${number}`} (${n})`;
        const invNo = await this.seq.next(tx, auth.businessId, "SINV", "SINV-");
        await tx.supplierInvoice.create({ data: {
          business_id: auth.businessId, branch_id: (await tx.branch.findFirstOrThrow({ where: { business_id: auth.businessId }, orderBy: { created_at: "asc" } })).id,
          supplier_id: s.supplier_id, number: invNo, supplier_invoice_no: ref, invoice_date: new Date(`${input.as_of_date}T00:00:00Z`), due_date: new Date(`${s.due_date}T00:00:00Z`),
          status: "POSTED", subtotal: s.amount, total: s.amount, notes: `Opening balance carried over (${number})`, journal_entry_id: je.id, opening_balance_id: ob.id,
          posted_at: new Date(), posted_by_id: auth.userId, created_by_id: auth.userId,
        } });
      }
      await this.audit.record(auth, { action: "opening_balance.posted", entityType: "opening_balance", entityId: ob.id, summary: `${number}: opening balances as of ${input.as_of_date} (${lines.length} lines, equity ${diff.neg()})` }, tx);
      return tx.openingBalance.findUniqueOrThrow({ where: { id: ob.id } });
    }, { timeout: 60_000 });
  }

  /** Reverses an opening-balance document, provided none of its customer or supplier amounts has been paid yet. */
  async void(auth: AuthContext, id: string, reason: string) {
    assertCan(auth, "accounting.opening_balances");
    if (!reason?.trim()) throw invalid("REASON_REQUIRED", "Enter the reason");
    const b = await this.settings.business(auth.businessId);
    return this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM opening_balances WHERE id = ${id}::uuid FOR UPDATE`;
      const ob = await tx.openingBalance.findFirst({ where: { id, business_id: auth.businessId } });
      if (!ob) throw notFound("Opening balance");
      if (ob.status !== "POSTED") throw invalid("ALREADY_VOIDED", `${ob.number} is already reversed`);
      const paidCustomers = await tx.customerOpeningItem.count({ where: { opening_balance_id: id, settled: { gt: 0 } } });
      const paidSuppliers = await tx.supplierInvoice.count({ where: { opening_balance_id: id, amount_paid: { gt: 0 } } });
      if (paidCustomers || paidSuppliers) throw invalid("OPENING_BALANCE_IN_USE", "Some of these customer or supplier balances have already been paid — void those payments first, or enter a correcting opening balance instead");
      if (ob.journal_entry_id) await this.posting.reverse(tx, ob.journal_entry_id, { date: businessDate(new Date(), b.timezone), reason: `Reverse ${ob.number}: ${reason.trim()}`, userId: auth.userId, currencyDecimals: b.currency_decimals });
      await tx.customerOpeningItem.updateMany({ where: { opening_balance_id: id }, data: { voided: true } });
      await tx.supplierInvoice.updateMany({ where: { opening_balance_id: id }, data: { status: "REVERSED" } });
      await tx.openingBalance.update({ where: { id }, data: { status: "REVERSED", voided_at: new Date(), voided_by_id: auth.userId, void_reason: reason.trim() } });
      await this.audit.record(auth, { action: "opening_balance.reversed", entityType: "opening_balance", entityId: id, summary: `${ob.number} reversed: ${reason.trim()}` }, tx);
      return { id, reversed: true };
    });
  }
}
