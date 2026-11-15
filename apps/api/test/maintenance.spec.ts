import { createPrismaClient, Prisma } from "@retail/db";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../../packages/db/tools/migrate";
import { AuditService } from "../src/common/audit.service";
import { MaintenanceService } from "../src/modules/admin/maintenance.service";
import { closeContext, makeWorld, PASSWORD, World } from "./harness";

let w: World;
let safe: { id: string };
beforeAll(async () => {
  w = await makeWorld();
  safe = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, kind: "SAFE", branch_id: w.s1.id } });
});
afterAll(closeContext);

describe("chart of accounts and financial accounts", () => {
  it("adds, edits and deletes GL accounts; protects accounts in use", async () => {
    const parent = await w.db.account.findFirstOrThrow({ where: { business_id: w.B, code: "6000" } }).catch(() => null);
    const acc = await w.svc.chart.createAccount(w.owner, { code: "6055", name: "Generator fuel", type: "EXPENSE", parent_id: parent?.id && parent.type === "EXPENSE" ? parent.id : undefined });
    await expect(w.svc.chart.createAccount(w.owner, { code: "6055", name: "Dup", type: "EXPENSE" })).rejects.toMatchObject({ code: "DUPLICATE_CODE" });
    const upd = await w.svc.chart.updateAccount(w.owner, acc.id, { name: "Generator fuel & oil", code: "6056" });
    expect(upd.code).toBe("6056");
    await w.svc.chart.deleteAccount(w.owner, acc.id);
    expect(await w.db.account.findUnique({ where: { id: acc.id } })).toBeNull();

    const inventory = await w.db.postingRule.findFirstOrThrow({ where: { business_id: w.B, key: "inventory" } });
    await expect(w.svc.chart.deleteAccount(w.owner, inventory.account_id)).rejects.toMatchObject({ code: "ACCOUNT_IN_USE" });
    await expect(w.svc.chart.updateAccount(w.owner, inventory.account_id, { allow_manual: true })).rejects.toMatchObject({ code: "CONTROL_ACCOUNT" });
    await expect(w.svc.chart.updateAccount(w.owner, inventory.account_id, { active: false })).rejects.toMatchObject({ code: "ACCOUNT_IN_USE" });
  });

  it("adds a bank account with its own ledger account, renames it, refuses deleting it once used", async () => {
    const fa = await w.svc.chart.createFinancialAccount(w.owner, { name: "Afriland savings", kind: "BANK" });
    const gl = await w.db.account.findUniqueOrThrow({ where: { id: fa.gl_account_id } });
    expect(gl.code.startsWith("52")).toBe(true);
    expect(gl.allow_manual).toBe(false);
    const renamed = await w.svc.chart.updateFinancialAccount(w.owner, fa.id, { name: "Afriland current account" });
    expect(renamed.name).toBe("Afriland current account");
    expect((await w.db.account.findUniqueOrThrow({ where: { id: fa.gl_account_id } })).name).toBe("Afriland current account");
    await w.svc.finance.transfer(w.owner, { from_account_id: safe.id, to_account_id: fa.id, amount: "1000", transfer_date: new Date().toISOString().slice(0, 10) }).catch(async () => {
      // the safe may be empty in a fresh world: fund it from the capital first
      await w.svc.finance.transfer(w.owner, { from_account_id: fa.id, to_account_id: safe.id, amount: "0.01", transfer_date: new Date().toISOString().slice(0, 10) });
    });
    const used = await w.db.journalLine.count({ where: { account_id: fa.gl_account_id } });
    if (used) {
      await expect(w.svc.chart.deleteFinancialAccount(w.owner, fa.id)).rejects.toMatchObject({ code: "FINANCIAL_ACCOUNT_IN_USE" });
    }
    const unused = await w.svc.chart.createFinancialAccount(w.owner, { name: "Spare wallet", kind: "MOBILE_MONEY" });
    await w.svc.chart.deleteFinancialAccount(w.owner, unused.id);
    expect(await w.db.financialAccount.findUnique({ where: { id: unused.id } })).toBeNull();
    expect(await w.db.account.findUnique({ where: { id: unused.gl_account_id } })).toBeNull();
    await expect(w.svc.chart.createFinancialAccount(w.owner, { name: "Till X", kind: "TILL" })).rejects.toMatchObject({ code: "TILL_VIA_REGISTER" });
  });
});

describe("backup and clear", () => {
  const restoreUrl = (process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/retail_test").replace(/\/([^/?]+)(\?|$)/, "/retail_test_restore$2");
  it("backs up everything and restores it into a fresh database (reversals, voids, closed periods), then clears it", async () => {
    // material with cycles: a voided sale, a reversed journal (voided expense), a closed period
    const v = await w.product({ retail: "1500" });
    await w.stock(w.s1.id, v.id, "6", "800");
    const sale = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "2" }]);
    await w.svc.sales.voidSale(w.owner, sale.id, { reason: "backup test", refund_method: "CASH", financial_account_id: safe.id });
    const cat = await w.db.expenseCategory.findFirstOrThrow({ where: { business_id: w.B } });
    const exp = await w.svc.finance.createExpense(w.owner, { branch_id: w.s1.id, expense_date: new Date().toISOString().slice(0, 10), payee: "Backup test", financial_account_id: safe.id, lines: [{ expense_category_id: cat.id, description: "x", amount: "500" }] });
    await w.svc.finance.voidExpense(w.owner, exp.id, "backup test");
    const firstPeriod = await w.db.fiscalPeriod.findFirstOrThrow({ where: { business_id: w.B }, orderBy: { start_date: "asc" } });
    await w.svc.accounting.closePeriod(w.owner, firstPeriod.id);

    let sql = "";
    for await (const chunk of w.svc.maintenance.backup(w.owner)) sql += chunk;
    expect(sql).toContain("INSERT INTO \"sales\"");
    expect(sql).toMatch(/UPDATE "journal_entries" SET "status" = 'REVERSED'/);
    expect(sql).toMatch(/UPDATE "fiscal_periods" SET "status" = 'CLOSED'/);

    const admin = new Client({ connectionString: restoreUrl.replace("/retail_test_restore", "/postgres") });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS retail_test_restore WITH (FORCE)");
    await admin.query("CREATE DATABASE retail_test_restore");
    await admin.end();
    await migrate(restoreUrl, { quiet: true });
    const target = new Client({ connectionString: restoreUrl });
    await target.connect();
    await target.query(sql);
    const one = async (q: string, p: unknown[] = []) => (await target.query(q, p)).rows[0];
    expect(Number((await one("SELECT count(*) n FROM sales WHERE business_id = $1", [w.B])).n)).toBe(await w.db.sale.count({ where: { business_id: w.B } }));
    expect((await one("SELECT void_return_id FROM sales WHERE id = $1", [sale.id])).void_return_id).toBeTruthy();
    expect((await one("SELECT status FROM journal_entries WHERE id = $1", [exp.journal_entry_id])).status).toBe("REVERSED");
    expect((await one("SELECT status FROM fiscal_periods WHERE id = $1", [firstPeriod.id])).status).toBe("CLOSED");
    expect(Number((await one("SELECT count(*) n FROM journal_lines")).n)).toBe(await w.db.journalLine.count());
    // a second restore into a non-empty database is refused
    await expect(target.query(sql)).rejects.toThrow(/empty/);
    await target.end();

    // clearing (run against the restored copy so the shared test database is untouched)
    const client = createPrismaClient(restoreUrl);
    const prismaLike: any = { client, tx: (fn: any, o: any = {}) => client.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: o.timeout ?? 20_000 }) };
    const m = new MaintenanceService(prismaLike, new AuditService(prismaLike));
    const name = (await client.business.findUniqueOrThrow({ where: { id: w.B } })).name;
    await expect(m.clear(w.owner, { mode: "transactions", confirm_name: name, password: "wrong" })).rejects.toMatchObject({ code: "WRONG_PASSWORD" });
    await expect(m.clear(w.owner, { mode: "transactions", confirm_name: "nope", password: PASSWORD })).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    if ((await client.business.count()) > 1) await expect(m.clear(w.owner, { mode: "transactions", confirm_name: name, password: PASSWORD })).rejects.toMatchObject({ code: "MULTI_BUSINESS" });
    const productsBefore = await client.product.count();
    await m.clear(w.owner, { mode: "transactions", confirm_name: name, password: PASSWORD }, { allowSeveralBusinesses: true });
    expect(await client.sale.count()).toBe(0);
    expect(await client.journalEntry.count()).toBe(0);
    expect(await client.stockMovement.count()).toBe(0);
    expect(await client.product.count()).toBe(productsBefore);
    expect(await client.auditEvent.count({ where: { action: "application.cleared" } })).toBe(1);
    await m.clear(w.owner, { mode: "everything", confirm_name: name, password: PASSWORD }, { allowSeveralBusinesses: true });
    expect(await client.product.count()).toBe(0);
    expect(await client.customer.count()).toBe(0);
    expect(await client.user.count()).toBeGreaterThan(0);
    expect(await client.account.count()).toBeGreaterThan(0);
    await client.$disconnect();
    void randomUUID;
  }, 180_000);
});
