import { randomUUID } from "node:crypto";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(closeContext);
const today = () => new Date().toISOString().slice(0, 10);

describe("double-entry integrity", () => {
  it("the posting service rejects unbalanced journals", async () => {
    await expect(w.prisma.tx((tx) => w.svc.posting.post(tx, { businessId: w.B, entryDate: today(), sourceType: "test", description: "bad", createdById: w.owner.userId, currencyDecimals: 0, lines: [{ account: "inventory", debit: 100 }, { account: "grni", credit: 90 }] }))).rejects.toMatchObject({ code: "UNBALANCED_JOURNAL" });
  });
  it("the database rejects unbalanced lines even if application checks are bypassed", async () => {
    const period = await w.svc.posting.periodFor(w.db as any, w.B, today());
    const acc = await w.db.account.findFirstOrThrow({ where: { business_id: w.B, code: "6590" } });
    await expect(w.db.$transaction(async (tx) => {
      const je = await tx.journalEntry.create({ data: { business_id: w.B, number: `X-${randomUUID().slice(0, 6)}`, entry_date: new Date(`${today()}T00:00:00Z`), fiscal_period_id: period.id, source_type: "raw", description: "raw", total_debit: 100, total_credit: 100, created_by_id: w.owner.userId } });
      await tx.journalLine.create({ data: { journal_entry_id: je.id, line_no: 1, account_id: acc.id, debit: 100 } });
    })).rejects.toThrow(/unbalanced|do not match/);
  });
  it("posted journals and stock movements are immutable; corrections are reversals", async () => {
    const v = await w.product();
    await w.stock(w.s1.id, v.id, "1", "100");
    const je = await w.db.journalEntry.findFirstOrThrow({ where: { business_id: w.B, source_type: "goods_receipt" } });
    await expect(w.db.journalEntry.update({ where: { id: je.id }, data: { description: "edited" } })).rejects.toThrow(/immutable/);
    await expect(w.db.journalEntry.delete({ where: { id: je.id } })).rejects.toThrow();
    const mv = await w.db.stockMovement.findFirstOrThrow({ where: { business_id: w.B } });
    await expect(w.db.stockMovement.update({ where: { id: mv.id }, data: { quantity: 99 } })).rejects.toThrow(/append-only/);
  });
  it("manual journals post only after approval by someone else, and can be reversed", async () => {
    const rent = await w.db.account.findFirstOrThrow({ where: { business_id: w.B, code: "6220" } });
    const cap = await w.db.account.findFirstOrThrow({ where: { business_id: w.B, code: "1010" } });
    const inv = await w.db.account.findFirstOrThrow({ where: { business_id: w.B, code: "3110" } });
    await expect(w.svc.accounting.requestManualJournal(w.accountant, { entry_date: today(), description: "Into control account", lines: [{ account_id: inv.id, debit: "10" }, { account_id: cap.id, credit: "10" }] })).rejects.toMatchObject({ code: "ACCOUNT_CONTROL" });
    const req = await w.svc.accounting.requestManualJournal(w.accountant, { entry_date: today(), description: "Rent paid by owner personally", lines: [{ account_id: rent.id, debit: "50000" }, { account_id: cap.id, credit: "50000" }] });
    expect(await w.db.journalEntry.count({ where: { approval_request_id: req.id } })).toBe(0);
    await expect(w.svc.approvals.decide(w.accountant, req.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await w.svc.approvals.decide(w.owner, req.id, "APPROVE");
    const je = await w.db.journalEntry.findFirstOrThrow({ where: { approval_request_id: req.id } });
    const rev = await w.svc.accounting.reverseManual(w.accountant, je.id, "Booked in error");
    expect(rev.total_debit.toString()).toBe("50000");
    expect((await w.db.journalEntry.findUniqueOrThrow({ where: { id: je.id } })).status).toBe("REVERSED");
  });
  it("trial balance balances and the balance sheet equation holds", async () => {
    const tb = await w.svc.accounting.trialBalance(w.owner, today());
    expect(tb.balanced).toBe(true);
    const bs = await w.svc.accounting.balanceSheet(w.owner, today());
    expect(bs.balanced).toBe(true);
  });
});

describe("period locks", () => {
  it("closed periods reject postings until reopened through approval", async () => {
    const period = await w.svc.posting.periodFor(w.db as any, w.B, today());
    await w.svc.accounting.closePeriod(w.accountant, period.id);
    const v = await w.product();
    await expect(w.stock(w.s1.id, v.id, "1", "100")).rejects.toMatchObject({ code: "PERIOD_CLOSED" });
    expect((await w.onHand(v.id)).onHand.toString()).toBe("0"); // whole document rolled back, no orphan stock
    const req = await w.svc.accounting.requestReopen(w.accountant, period.id, "Late supplier delivery");
    await w.svc.approvals.decide(w.owner, req.id, "APPROVE");
    await w.stock(w.s1.id, v.id, "1", "100");
    expect((await w.onHand(v.id)).onHand.toString()).toBe("1");
  });
});

describe("cashier sessions", () => {
  it("computes expected cash and requires a reason and approval for large variances (no self-approval)", async () => {
    const v = await w.product({ retail: "10000" });
    await w.stock(w.s1.id, v.id, "5", "5000");
    const sid = await w.session(w.cashier, w.regs.r1.id, "20000");
    await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "2" }]);
    await w.svc.finance.cashMovement(w.cashier, sid, { kind: "CASH_DROP", amount: "15000", reason: "Drop" });
    const sum = await w.svc.finance.getSession(w.cashier, sid);
    expect(sum.expected_cash.toString()).toBe("25000"); // 20000 float + 20000 sales − 15000 drop
    await expect(w.svc.finance.closeSession(w.cashier, sid, { counted_cash: "22000" })).rejects.toMatchObject({ code: "VARIANCE_REASON_REQUIRED" });
    await expect(w.svc.finance.closeSession(w.cashier, sid, { counted_cash: "22000", variance_reason: "Unknown" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const req = await w.svc.approvals.request(w.cashier, { type: "CASH_VARIANCE", reason: "Short 3000", amount: "3000", branchId: w.s1.id });
    await expect(w.svc.approvals.decide(w.cashier, req.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await w.svc.approvals.decide(w.manager, req.id, "APPROVE");
    const shortBefore = await w.glBalance("cash_short");
    const closed = await w.svc.finance.closeSession(w.cashier, sid, { counted_cash: "22000", variance_reason: "Unknown", approval_request_id: req.id });
    expect(closed.variance!.toString()).toBe("-3000");
    expect((await w.glBalance("cash_short")).minus(shortBefore).toString()).toBe("3000");
    const till = await w.db.financialAccount.findUniqueOrThrow({ where: { id: w.regs.r1.till_account_id } });
    const tillBal = await w.db.journalLine.aggregate({ where: { account_id: till.gl_account_id }, _sum: { debit: true, credit: true } });
    expect(tillBal._sum.debit!.minus(tillBal._sum.credit!).toString()).toBe("0"); // till emptied to safe
  });
});

describe("stock-to-ledger reconciliation", () => {
  it("all control accounts reconcile after a mixed scenario", async () => {
    const v = await w.product({ retail: "700", taxPercent: "10" });
    await w.stock(w.s1.id, v.id, "9", "333.33");
    await w.session(w.cashier2, w.regs.r2.id);
    for (let i = 0; i < 3; i++) await w.cashSale(w.cashier2, w.s1.id, w.regs.r2.id, [{ variant_id: v.id, quantity: "2" }]);
    const dmg = await w.loc(w.s1.id, "DMG");
    const floor = await w.loc(w.s1.id, "FLOOR");
    await w.svc.inventory.relocate(w.keeper, { branch_id: w.s1.id, variant_id: v.id, from_location_id: floor.id, to_location_id: dmg.id, quantity: "1", reason: "Broken" });
    await w.svc.inventory.adjust(w.keeper, { branch_id: w.s1.id, reason_code: "DAMAGE", reason: "Broken", lines: [{ variant_id: v.id, location_id: dmg.id, quantity: "-1" }] });
    const r = await w.svc.accounting.reconciliation(w.owner);
    for (const c of r.checks) expect({ name: c.name, ok: c.ok, diff: c.difference.toString() }).toEqual({ name: c.name, ok: true, diff: "0" });
  });
});
