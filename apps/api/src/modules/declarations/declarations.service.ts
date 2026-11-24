import { Injectable } from "@nestjs/common";
import { assertBranch, assertCan, AuthContext } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { conflict, invalid, notFound } from "../../common/errors";
import { D } from "../../common/money";
import { PrismaService } from "../../common/prisma.service";
import { addDays, businessDate, SettingsService } from "../../common/settings.service";

export type DeclarationKind = "OPENING" | "CLOSING";
/** Roles that must declare opening and closing balances every business day (default; editable in settings). */
export const DEFAULT_DECLARATION_ROLES = ["CASHIER", "STOREKEEPER", "STORE_MANAGER", "SALES_PERSON"];
const MONEY_KINDS = ["TILL", "SAFE", "PETTY_CASH", "MOBILE_MONEY", "BANK"] as const;

/**
 * Daily balance declarations. Each person in a required role declares, blind, the money they hold
 * (till, safe, petty cash, mobile money wallets, bank) when starting and when finishing the day.
 * The ledger balance at that moment is stored next to each amount for the managers' variance report.
 */
@Injectable()
export class DeclarationsService {
  constructor(private prisma: PrismaService, private settings: SettingsService, private audit: AuditService) {}

  async requiredRoles(businessId: string): Promise<string[]> {
    const b = await this.settings.business(businessId);
    const r = (b.settings as any)?.declaration_roles;
    return Array.isArray(r) ? r : DEFAULT_DECLARATION_ROLES;
  }

  async setRequiredRoles(auth: AuthContext, roles: string[]) {
    assertCan(auth, "admin.settings");
    const known = new Set((await this.prisma.client.role.findMany({ where: { business_id: auth.businessId }, select: { code: true } })).map((r) => r.code));
    const bad = roles.filter((r) => !known.has(r));
    if (bad.length) throw invalid("UNKNOWN_ROLE", `Unknown role: ${bad.join(", ")}`);
    const b = await this.settings.business(auth.businessId);
    const before = await this.requiredRoles(auth.businessId);
    await this.prisma.client.business.update({ where: { id: b.id }, data: { settings: { ...((b.settings as object) ?? {}), declaration_roles: [...new Set(roles)] } } });
    await this.audit.record(auth, { action: "declarations.settings_changed", entityType: "business", entityId: b.id, summary: `Daily declarations required for: ${roles.join(", ") || "nobody"}`, data: { before, after: roles } });
    return { roles };
  }

  private async isRequired(auth: AuthContext) {
    const roles = await this.requiredRoles(auth.businessId);
    return auth.roles.some((r) => roles.includes(r));
  }

  /** Money accounts a person can declare at a branch: the branch's tills, safe and petty cash, plus wallets and banks. */
  private accounts(businessId: string, branchId: string) {
    return this.prisma.client.financialAccount.findMany({
      where: { business_id: businessId, active: true, kind: { in: [...MONEY_KINDS] }, OR: [{ branch_id: branchId }, { branch_id: null }] },
      orderBy: [{ kind: "asc" }, { name: "asc" }], select: { id: true, code: true, name: true, kind: true, branch_id: true, gl_account_id: true },
    });
  }

  private async today(businessId: string) {
    const b = await this.settings.business(businessId);
    return businessDate(new Date(), b.timezone);
  }

  private summary(d: { kind: string; created_at: Date; total_declared: any; branch_id: string } | null | undefined) {
    return d ? { kind: d.kind, declared_at: d.created_at, total: String(d.total_declared), branch_id: d.branch_id } : null;
  }

  /** What the signed-in person has to do today (no system balances: declarations are blind). */
  async status(auth: AuthContext, branchId: string) {
    assertBranch(auth, branchId);
    const date = await this.today(auth.businessId);
    const mine = await this.prisma.client.dailyDeclaration.findMany({ where: { business_id: auth.businessId, user_id: auth.userId, business_date: { in: [new Date(date), new Date(addDays(date, -1))] } } });
    const at = (d: string, k: DeclarationKind) => mine.find((m) => m.business_date.toISOString().slice(0, 10) === d && m.kind === k);
    const accounts = (await this.accounts(auth.businessId, branchId)).map(({ gl_account_id: _g, ...a }) => a);
    return {
      required: await this.isRequired(auth),
      business_date: date,
      opening: this.summary(at(date, "OPENING")),
      closing: this.summary(at(date, "CLOSING")),
      missed_closing_yesterday: !!at(addDays(date, -1), "OPENING") && !at(addDays(date, -1), "CLOSING"),
      accounts,
    };
  }

  async declare(auth: AuthContext, input: { kind: DeclarationKind; branch_id: string; lines: { financial_account_id: string; amount: string }[]; note?: string }) {
    assertBranch(auth, input.branch_id);
    const date = await this.today(auth.businessId);
    const lines = input.lines.filter((l) => l.amount != null && String(l.amount).trim() !== "");
    if (!lines.length) throw invalid("NOTHING_DECLARED", "Enter the balance of at least one account you hold (0 if empty)");
    const accounts = await this.accounts(auth.businessId, input.branch_id);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const seen = new Set<string>();
    for (const l of lines) {
      if (!byId.has(l.financial_account_id)) throw invalid("INVALID_ACCOUNT", "Declare only the money accounts of this branch");
      if (seen.has(l.financial_account_id)) throw invalid("DUPLICATE_ACCOUNT", "Each account once");
      seen.add(l.financial_account_id);
      if (D(l.amount).lt(0)) throw invalid("NEGATIVE_AMOUNT", "Balances cannot be negative");
    }
    const sums = await this.prisma.client.journalLine.groupBy({ by: ["account_id"], where: { account_id: { in: lines.map((l) => byId.get(l.financial_account_id)!.gl_account_id) } }, _sum: { debit: true, credit: true } });
    const sys = (glId: string) => { const s = sums.find((x) => x.account_id === glId); return D(s?._sum.debit ?? 0).minus(D(s?._sum.credit ?? 0)); };
    return this.prisma.tx(async (tx) => {
      const existing = await tx.dailyDeclaration.findMany({ where: { business_id: auth.businessId, user_id: auth.userId, business_date: new Date(date) } });
      if (existing.some((e) => e.kind === input.kind)) throw conflict("ALREADY_DECLARED", `Your ${input.kind.toLowerCase()} balances for ${date} are already declared`);
      if (input.kind === "CLOSING" && !existing.some((e) => e.kind === "OPENING")) throw invalid("OPENING_FIRST", "Declare your opening balances first");
      const total = lines.reduce((s, l) => s.plus(D(l.amount)), D(0));
      const d = await tx.dailyDeclaration.create({
        data: {
          business_id: auth.businessId, branch_id: input.branch_id, user_id: auth.userId, business_date: new Date(date), kind: input.kind, total_declared: total, note: input.note?.trim() || null,
          lines: { create: lines.map((l) => ({ financial_account_id: l.financial_account_id, declared_amount: D(l.amount), system_balance: sys(byId.get(l.financial_account_id)!.gl_account_id) })) },
        },
      });
      await this.audit.record(auth, { action: `declaration.${input.kind.toLowerCase()}`, entityType: "daily_declaration", entityId: d.id, summary: `${input.kind === "OPENING" ? "Opening" : "Closing"} balances declared for ${date}: ${total.toString()} across ${lines.length} account(s)`, branchId: input.branch_id }, tx);
      return { id: d.id, kind: d.kind, business_date: date, total: total.toString() };
    });
  }

  /** Managers' view: who declared what on a day, with the system balance and variance per account, and who has not declared. */
  async report(auth: AuthContext, q: { date?: string; branch_id?: string }) {
    assertCan(auth, "declarations.view");
    if (q.branch_id) assertBranch(auth, q.branch_id);
    const date = q.date ?? (await this.today(auth.businessId));
    const roles = await this.requiredRoles(auth.businessId);
    const decls = await this.prisma.client.dailyDeclaration.findMany({
      where: { business_id: auth.businessId, business_date: new Date(date), ...(q.branch_id ? { branch_id: q.branch_id } : auth.allBranches ? {} : { branch_id: { in: auth.branchIds } }) },
      include: { lines: true }, orderBy: { created_at: "asc" },
    });
    const required = await this.prisma.client.user.findMany({
      where: {
        business_id: auth.businessId, status: "ACTIVE", roles: { some: { role: { code: { in: roles } } } },
        ...(q.branch_id ? { OR: [{ all_branches: true }, { branch_access: { some: { branch_id: q.branch_id } } }] } : {}),
      },
      select: { id: true, full_name: true, roles: { select: { role: { select: { code: true, name: true } } } } },
    });
    const userIds = [...new Set([...required.map((u) => u.id), ...decls.map((d) => d.user_id)])];
    const users = await this.prisma.client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, full_name: true, roles: { select: { role: { select: { code: true, name: true } } } } } });
    const fas = await this.prisma.client.financialAccount.findMany({ where: { id: { in: decls.flatMap((d) => d.lines.map((l) => l.financial_account_id)) } }, select: { id: true, name: true, kind: true } });
    const branches = await this.prisma.client.branch.findMany({ where: { business_id: auth.businessId }, select: { id: true, code: true, name: true } });
    const fmt = (d?: (typeof decls)[number]) => d ? {
      declared_at: d.created_at, branch: branches.find((b) => b.id === d.branch_id)?.code ?? null, note: d.note, total: String(d.total_declared),
      system_total: d.lines.reduce((s, l) => s.plus(D(l.system_balance)), D(0)).toString(),
      variance: d.lines.reduce((s, l) => s.plus(D(l.declared_amount).minus(D(l.system_balance))), D(0)).toString(),
      lines: d.lines.map((l) => ({ account: fas.find((f) => f.id === l.financial_account_id)?.name ?? "?", kind: fas.find((f) => f.id === l.financial_account_id)?.kind ?? null, declared: String(l.declared_amount), system: String(l.system_balance), variance: D(l.declared_amount).minus(D(l.system_balance)).toString() })),
    } : null;
    const rows = users.map((u) => {
      const o = decls.find((d) => d.user_id === u.id && d.kind === "OPENING");
      const c = decls.find((d) => d.user_id === u.id && d.kind === "CLOSING");
      return { user_id: u.id, name: u.full_name, roles: u.roles.map((r) => r.role.name), required: required.some((r) => r.id === u.id), opening: fmt(o), closing: fmt(c) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return {
      date, required_roles: roles, rows,
      summary: { people: rows.filter((r) => r.required).length, opened: rows.filter((r) => r.opening).length, closed: rows.filter((r) => r.closing).length, missing_opening: rows.filter((r) => r.required && !r.opening).length, missing_closing: rows.filter((r) => r.required && !r.closing).length },
    };
  }

  async declaration(auth: AuthContext, id: string) {
    const d = await this.prisma.client.dailyDeclaration.findFirst({ where: { id, business_id: auth.businessId } });
    if (!d) throw notFound("Declaration");
    return d;
  }
}
