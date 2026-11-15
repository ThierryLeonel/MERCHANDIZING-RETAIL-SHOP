import { Injectable } from "@nestjs/common";
import type { AccountType, FinancialAccountKind } from "@retail/db";
import { AuthContext, assertBranch } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { invalid, notFound } from "../../common/errors";
import { D } from "../../common/money";
import { PrismaService } from "../../common/prisma.service";

const isFk = (e: any) => e?.code === "P2003" || /foreign key/i.test(String(e?.message));

/**
 * Editing the chart of accounts and the financial accounts (safes, banks,
 * mobile-money wallets…). Anything that already carries journal lines keeps its
 * code and type; anything in use cannot be deleted — deactivate it instead.
 */
@Injectable()
export class ChartService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  // ------------------------------------------------------------ GL accounts
  private async usage(id: string) {
    const db = this.prisma.client;
    const [lines, children, rules, fas, cats, taxes, invLines, cashMoves] = await Promise.all([
      db.journalLine.count({ where: { account_id: id } }), db.account.count({ where: { parent_id: id } }),
      db.postingRule.findMany({ where: { account_id: id }, select: { key: true } }), db.financialAccount.findMany({ where: { gl_account_id: id }, select: { name: true } }),
      db.expenseCategory.findMany({ where: { account_id: id }, select: { name: true } }),
      db.taxRate.findMany({ where: { OR: [{ input_account_id: id }, { output_account_id: id }] }, select: { name: true } }),
      db.supplierInvoiceLine.count({ where: { expense_account_id: id } }), db.cashMovement.count({ where: { expense_account_id: id } }),
    ]);
    return { lines, children, rules, fas, cats, taxes, other: invLines + cashMoves };
  }

  async createAccount(auth: AuthContext, input: { code: string; name: string; type?: AccountType; parent_id?: string | null; subtype?: string | null; allow_manual?: boolean; is_postable?: boolean }) {
    const db = this.prisma.client, b = auth.businessId;
    const code = input.code.trim().toUpperCase();
    if (!/^[0-9A-Z][0-9A-Z.-]{0,15}$/.test(code)) throw invalid("INVALID_CODE", "Account codes use digits/letters (up to 16), e.g. 6055");
    if (await db.account.findFirst({ where: { business_id: b, code } })) throw invalid("DUPLICATE_CODE", `Account ${code} already exists`);
    const parent = input.parent_id ? await db.account.findFirst({ where: { id: input.parent_id, business_id: b } }) : null;
    if (input.parent_id && !parent) throw notFound("Parent account");
    const type = input.type ?? parent?.type;
    if (!type) throw invalid("TYPE_REQUIRED", "Choose the account type (asset, liability, equity, revenue or expense)");
    if (parent && parent.type !== type) throw invalid("TYPE_MISMATCH", `A ${type.toLowerCase()} account cannot sit under ${parent.code} ${parent.name} (${parent.type.toLowerCase()})`);
    const acc = await db.account.create({ data: { business_id: b, code, name: input.name.trim(), type, parent_id: parent?.id ?? null, subtype: input.subtype ?? parent?.subtype ?? null, allow_manual: input.allow_manual ?? true, is_postable: input.is_postable ?? true } });
    await this.audit.record(auth, { action: "account.created", entityType: "account", entityId: acc.id, summary: `Account ${acc.code} ${acc.name} created` });
    return acc;
  }

  async updateAccount(auth: AuthContext, id: string, input: { code?: string; name?: string; type?: AccountType; parent_id?: string | null; allow_manual?: boolean; is_postable?: boolean; active?: boolean }) {
    const db = this.prisma.client, b = auth.businessId;
    const acc = await db.account.findFirst({ where: { id, business_id: b } });
    if (!acc) throw notFound("Account");
    const u = await this.usage(id);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) { if (input.name.trim().length < 2) throw invalid("NAME_REQUIRED", "Enter a name"); data.name = input.name.trim(); }
    if (input.code !== undefined && input.code.trim().toUpperCase() !== acc.code) {
      if (u.lines) throw invalid("ACCOUNT_IN_USE", `${acc.code} already has entries — its code cannot change (rename it instead)`);
      const code = input.code.trim().toUpperCase();
      if (!/^[0-9A-Z][0-9A-Z.-]{0,15}$/.test(code)) throw invalid("INVALID_CODE", "Account codes use digits/letters (up to 16)");
      if (await db.account.findFirst({ where: { business_id: b, code, id: { not: id } } })) throw invalid("DUPLICATE_CODE", `Account ${code} already exists`);
      data.code = code;
    }
    if (input.type !== undefined && input.type !== acc.type) {
      if (u.lines || u.children || u.rules.length || u.fas.length) throw invalid("ACCOUNT_IN_USE", `${acc.code} is in use — its type cannot change`);
      data.type = input.type;
    }
    if (input.parent_id !== undefined && input.parent_id !== acc.parent_id) {
      if (input.parent_id) {
        const parent = await db.account.findFirst({ where: { id: input.parent_id, business_id: b } });
        if (!parent) throw notFound("Parent account");
        if (parent.type !== (input.type ?? acc.type)) throw invalid("TYPE_MISMATCH", "The parent account must be of the same type");
        // no cycles
        let cur: string | null = parent.id;
        while (cur) { if (cur === id) throw invalid("ACCOUNT_CYCLE", "An account cannot sit under itself or one of its sub-accounts"); cur = (await db.account.findUnique({ where: { id: cur }, select: { parent_id: true } }))?.parent_id ?? null; }
      }
      data.parent_id = input.parent_id;
    }
    if (input.allow_manual !== undefined && input.allow_manual !== acc.allow_manual) {
      if (input.allow_manual && (acc.is_control || u.rules.length || u.fas.length)) throw invalid("CONTROL_ACCOUNT", `${acc.code} is posted by the system (control account) — manual journals stay disabled`);
      data.allow_manual = input.allow_manual;
    }
    if (input.is_postable !== undefined && input.is_postable !== acc.is_postable) {
      if (!input.is_postable && (u.lines || u.rules.length || u.fas.length || u.cats.length || u.taxes.length)) throw invalid("ACCOUNT_IN_USE", `${acc.code} is in use — it cannot become a header account`);
      if (input.is_postable && u.children) throw invalid("HAS_CHILDREN", `${acc.code} has sub-accounts — header accounts with sub-accounts cannot take entries`);
      data.is_postable = input.is_postable;
    }
    if (input.active === false && acc.active) {
      const why = [...u.rules.map((r) => `posting rule ${r.key}`), ...u.fas.map((f) => `financial account ${f.name}`), ...u.cats.map((c) => `expense category ${c.name}`), ...u.taxes.map((t) => `tax rate ${t.name}`)];
      if (why.length) throw invalid("ACCOUNT_IN_USE", `${acc.code} is used by ${why.slice(0, 3).join(", ")}${why.length > 3 ? "…" : ""} — change those first`);
      const s = await db.journalLine.aggregate({ where: { account_id: id }, _sum: { debit: true, credit: true } });
      if (!D(s._sum.debit ?? 0).equals(D(s._sum.credit ?? 0))) throw invalid("NONZERO_BALANCE", `${acc.code} still has a balance — clear it with a journal before deactivating`);
      data.active = false;
    } else if (input.active === true) data.active = true;
    const updated = await db.account.update({ where: { id }, data });
    await this.audit.record(auth, { action: "account.updated", entityType: "account", entityId: id, summary: `Account ${acc.code} updated`, data: { before: { code: acc.code, name: acc.name, type: acc.type, parent_id: acc.parent_id, allow_manual: acc.allow_manual, active: acc.active }, after: data } });
    return updated;
  }

  async deleteAccount(auth: AuthContext, id: string) {
    const acc = await this.prisma.client.account.findFirst({ where: { id, business_id: auth.businessId } });
    if (!acc) throw notFound("Account");
    const u = await this.usage(id);
    const why = [u.lines && "it has journal entries", u.children && "it has sub-accounts", u.rules.length && "a posting rule uses it", u.fas.length && "a financial account uses it", u.cats.length && "an expense category uses it", u.taxes.length && "a tax rate uses it", u.other && "documents refer to it"].filter(Boolean);
    if (why.length) throw invalid("ACCOUNT_IN_USE", `${acc.code} cannot be deleted: ${why.join(", ")}. Deactivate it instead.`);
    try { await this.prisma.client.account.delete({ where: { id } }); } catch (e) { if (isFk(e)) throw invalid("ACCOUNT_IN_USE", `${acc.code} is referenced elsewhere — deactivate it instead`); throw e; }
    await this.audit.record(auth, { action: "account.deleted", entityType: "account", entityId: id, summary: `Account ${acc.code} ${acc.name} deleted` });
    return { id, deleted: true };
  }

  // ------------------------------------------------------- financial accounts
  private static PARENT: Partial<Record<FinancialAccountKind, string>> = { BANK: "5200", MOBILE_MONEY: "5500", SAFE: "5700", PETTY_CASH: "5700", CLEARING: "5800" };

  async createFinancialAccount(auth: AuthContext, input: { name: string; kind: FinancialAccountKind; code?: string; branch_id?: string | null; provider?: string | null; gl_account_id?: string | null }) {
    if (input.kind === "TILL") throw invalid("TILL_VIA_REGISTER", "Tills are created with their cash register (Administration → Registers)");
    if (input.branch_id) assertBranch(auth, input.branch_id);
    const b = auth.businessId;
    return this.prisma.tx(async (tx) => {
      const name = input.name.trim();
      if (name.length < 2) throw invalid("NAME_REQUIRED", "Enter a name");
      let code = (input.code?.trim() || `${input.kind}-${name}`).toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
      if (await tx.financialAccount.findFirst({ where: { business_id: b, code } })) {
        if (input.code) throw invalid("DUPLICATE_CODE", `Financial account code ${code} already exists`);
        for (let n = 2; await tx.financialAccount.findFirst({ where: { business_id: b, code } }); n++) code = `${code.slice(0, 20)}-${n}`;
      }
      let glId: string;
      if (input.gl_account_id) {
        const gl = await tx.account.findFirst({ where: { id: input.gl_account_id, business_id: b } });
        if (!gl) throw notFound("GL account");
        if (gl.type !== "ASSET" || !gl.is_postable) throw invalid("INVALID_GL", "Link a postable asset account");
        if (await tx.financialAccount.findFirst({ where: { gl_account_id: gl.id } })) throw invalid("GL_TAKEN", `${gl.code} already belongs to another financial account`);
        glId = gl.id;
      } else {
        // Own ledger account under the matching header (e.g. 5200 Banks → 5211, 5212…)
        const parentCode = ChartService.PARENT[input.kind] ?? "5700";
        let parent = await tx.account.findFirst({ where: { business_id: b, code: parentCode } });
        if (!parent) parent = await tx.account.create({ data: { business_id: b, code: parentCode, name: input.kind === "CLEARING" ? "Clearing accounts" : "Cash and banks", type: "ASSET", subtype: input.kind.toLowerCase(), is_postable: false, allow_manual: false } });
        let glCode = "";
        for (let i = 11; i < 100; i++) { const c = `${parentCode.slice(0, 2)}${i}`; if (!(await tx.account.findFirst({ where: { business_id: b, code: c } }))) { glCode = c; break; } }
        if (!glCode) throw invalid("NO_FREE_CODE", `No free account code under ${parentCode}`);
        glId = (await tx.account.create({ data: { business_id: b, code: glCode, name, type: "ASSET", subtype: input.kind.toLowerCase(), parent_id: parent.id, allow_manual: false } })).id;
      }
      const fa = await tx.financialAccount.create({ data: { business_id: b, code, name, kind: input.kind, branch_id: input.branch_id ?? null, provider: input.provider ?? null, gl_account_id: glId } });
      await this.audit.record(auth, { action: "financial_account.created", entityType: "financial_account", entityId: fa.id, summary: `Financial account ${fa.code} ${fa.name} created`, branchId: fa.branch_id ?? undefined }, tx);
      return fa;
    });
  }

  private async faBalance(glId: string) {
    const s = await this.prisma.client.journalLine.aggregate({ where: { account_id: glId }, _sum: { debit: true, credit: true } });
    return D(s._sum.debit ?? 0).minus(D(s._sum.credit ?? 0));
  }

  async updateFinancialAccount(auth: AuthContext, id: string, input: { name?: string; branch_id?: string | null; provider?: string | null; active?: boolean }) {
    const db = this.prisma.client;
    const fa = await db.financialAccount.findFirst({ where: { id, business_id: auth.businessId } });
    if (!fa) throw notFound("Financial account");
    if (input.branch_id) assertBranch(auth, input.branch_id);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) { if (input.name.trim().length < 2) throw invalid("NAME_REQUIRED", "Enter a name"); data.name = input.name.trim(); }
    if (input.branch_id !== undefined) { if (fa.kind === "TILL") throw invalid("TILL_BRANCH", "A till stays with its register's branch"); data.branch_id = input.branch_id; }
    if (input.provider !== undefined) data.provider = input.provider;
    if (input.active === false && fa.active) {
      if (fa.kind === "TILL" && (await db.cashRegister.count({ where: { till_account_id: id, active: true } }))) throw invalid("TILL_IN_USE", "Deactivate the cash register first");
      if (!(await this.faBalance(fa.gl_account_id)).equals(0)) throw invalid("NONZERO_BALANCE", `${fa.name} still holds money — transfer the balance out before deactivating`);
      data.active = false;
    } else if (input.active === true) data.active = true;
    const updated = await this.prisma.tx(async (tx) => {
      const r = await tx.financialAccount.update({ where: { id }, data });
      // keep the ledger account's name in step when it is this account's own ledger account
      if (data.name && (await tx.financialAccount.count({ where: { gl_account_id: fa.gl_account_id } })) === 1 && !(await tx.postingRule.count({ where: { account_id: fa.gl_account_id } }))) {
        await tx.account.update({ where: { id: fa.gl_account_id }, data: { name: data.name as string } });
      }
      await this.audit.record(auth, { action: "financial_account.updated", entityType: "financial_account", entityId: id, summary: `Financial account ${fa.code} updated`, data: { before: { name: fa.name, branch_id: fa.branch_id, active: fa.active }, after: data } }, tx);
      return r;
    });
    return updated;
  }

  async deleteFinancialAccount(auth: AuthContext, id: string) {
    const db = this.prisma.client;
    const fa = await db.financialAccount.findFirst({ where: { id, business_id: auth.businessId } });
    if (!fa) throw notFound("Financial account");
    const [lines, registers, payments, expenses, others] = await Promise.all([
      db.journalLine.count({ where: { OR: [{ financial_account_id: id }, { account_id: fa.gl_account_id }] } }), db.cashRegister.count({ where: { till_account_id: id } }),
      db.payment.count({ where: { financial_account_id: id } }), db.expense.count({ where: { financial_account_id: id } }),
      db.supplierPayment.count({ where: { financial_account_id: id } }),
    ]);
    if (lines + registers + payments + expenses + others > 0) throw invalid("FINANCIAL_ACCOUNT_IN_USE", `${fa.name} has transactions${registers ? " or a cash register" : ""} and cannot be deleted — deactivate it instead`);
    try {
      await this.prisma.tx(async (tx) => {
        await tx.financialAccount.delete({ where: { id } });
        // remove its own ledger account too when nothing else uses it
        const glUsed = (await tx.financialAccount.count({ where: { gl_account_id: fa.gl_account_id } })) + (await tx.postingRule.count({ where: { account_id: fa.gl_account_id } })) + (await tx.account.count({ where: { parent_id: fa.gl_account_id } }));
        if (!glUsed) await tx.account.delete({ where: { id: fa.gl_account_id } });
        await this.audit.record(auth, { action: "financial_account.deleted", entityType: "financial_account", entityId: id, summary: `Financial account ${fa.code} ${fa.name} deleted` }, tx);
      });
    } catch (e) { if (isFk(e)) throw invalid("FINANCIAL_ACCOUNT_IN_USE", `${fa.name} is referenced by other records — deactivate it instead`); throw e; }
    return { id, deleted: true };
  }
}
