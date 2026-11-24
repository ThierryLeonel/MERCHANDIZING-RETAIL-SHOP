import { randomUUID } from "node:crypto";
import { DeclarationsService } from "../src/modules/declarations/declarations.service";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
let decl: DeclarationsService;
let variantId: string;
beforeAll(async () => {
  w = await makeWorld(); decl = w.app.get(DeclarationsService);
  const v = await w.product({ retail: "1000" });
  variantId = v.id;
  await w.stock(w.s1.id, v.id, "20", "500");
});
afterAll(closeContext);

describe("daily balance declarations", () => {
  it("cashier, storekeeper and manager must declare; the owner does not; declarations are blind and in order", async () => {
    const st = await decl.status(w.cashier, w.s1.id);
    expect(st.required).toBe(true);
    expect(st.opening).toBeNull();
    expect((await decl.status(w.keeper, w.s1.id)).required).toBe(true);
    expect((await decl.status(w.manager, w.s1.id)).required).toBe(true);
    expect((await decl.status(w.owner, w.s1.id)).required).toBe(false);
    // the accounts offered carry no balance (blind declaration)
    expect(st.accounts.length).toBeGreaterThan(0);
    expect(st.accounts.some((a: any) => "balance" in a || "gl_account_id" in a)).toBe(false);
    const kinds = st.accounts.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["TILL", "SAFE", "MOBILE_MONEY", "BANK"]));
    expect(st.accounts.some((a) => a.name === "Orange Money wallet")).toBe(true);

    const till = st.accounts.find((a) => a.kind === "TILL")!;
    const momo = st.accounts.find((a) => a.kind === "MOBILE_MONEY")!;
    await expect(decl.declare(w.cashier, { kind: "CLOSING", branch_id: w.s1.id, lines: [{ financial_account_id: till.id, amount: "0" }] })).rejects.toMatchObject({ code: "OPENING_FIRST" });
    await expect(decl.declare(w.cashier, { kind: "OPENING", branch_id: w.s1.id, lines: [{ financial_account_id: till.id, amount: "" }] })).rejects.toMatchObject({ code: "NOTHING_DECLARED" });
    const open = await decl.declare(w.cashier, { kind: "OPENING", branch_id: w.s1.id, lines: [{ financial_account_id: till.id, amount: "0" }, { financial_account_id: momo.id, amount: "15000" }] });
    expect(open.total).toBe("15000");
    await expect(decl.declare(w.cashier, { kind: "OPENING", branch_id: w.s1.id, lines: [{ financial_account_id: till.id, amount: "0" }] })).rejects.toMatchObject({ code: "ALREADY_DECLARED" });
    expect((await decl.status(w.cashier, w.s1.id)).opening).toMatchObject({ total: "15000" });

    // a sale in between moves the till's system balance; the closing declaration is compared to it
    const sale = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: variantId, quantity: "1" }]);
    const close = await decl.declare(w.cashier, { kind: "CLOSING", branch_id: w.s1.id, lines: [{ financial_account_id: till.id, amount: String(sale.total) }], note: "all good" });
    expect(close.kind).toBe("CLOSING");

    const rep = await decl.report(w.manager, { branch_id: w.s1.id });
    const me = rep.rows.find((r) => r.user_id === w.cashier.userId)!;
    expect(me.opening!.lines.find((l) => l.kind === "MOBILE_MONEY")).toMatchObject({ declared: "15000", system: "0", variance: "15000" });
    expect(me.closing).toMatchObject({ note: "all good" });
    expect(me.closing!.lines[0].declared).toBe(me.closing!.lines[0].system); // till declared = ledger
    const keeper = rep.rows.find((r) => r.user_id === w.keeper.userId)!;
    expect(keeper).toMatchObject({ required: true, opening: null, closing: null });
    expect(rep.summary.missing_opening).toBeGreaterThanOrEqual(1);
    await expect(decl.report(w.cashier, {})).rejects.toBeTruthy(); // cashiers cannot see others' declarations

    // append-only
    const d = await w.db.dailyDeclaration.findFirstOrThrow({ where: { user_id: w.cashier.userId } });
    await expect(w.db.dailyDeclaration.update({ where: { id: d.id }, data: { note: "changed" } })).rejects.toThrow(/append-only/);
  });

  it("the owner can change which roles must declare", async () => {
    await decl.setRequiredRoles(w.owner, ["CASHIER"]);
    expect((await decl.status(w.keeper, w.s1.id)).required).toBe(false);
    expect((await decl.status(w.cashier, w.s1.id)).required).toBe(true);
    await expect(decl.setRequiredRoles(w.owner, ["NOPE"])).rejects.toMatchObject({ code: "UNKNOWN_ROLE" });
    await decl.setRequiredRoles(w.owner, ["CASHIER", "STOREKEEPER", "STORE_MANAGER", "SALES_PERSON"]);
  });
});

describe("electronic payments without reference or phone", () => {
  it("a cashier completes a mobile money (Orange) sale marked received, with no reference or phone", async () => {
    await w.session(w.cashier, w.regs.r1.id);
    const lines = [{ variant_id: variantId, quantity: "1" }];
    const q = await w.svc.sales.quote(w.cashier, { branch_id: w.s1.id, register_id: w.regs.r1.id, lines });
    const orange = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, name: "Orange Money wallet" } });
    const sale = await w.svc.sales.checkout(w.cashier, { branch_id: w.s1.id, register_id: w.regs.r1.id, lines, payments: [{ method: "MOBILE_MONEY", amount: q.total.toString(), financial_account_id: orange.id, received: true }] }, randomUUID());
    expect(sale.status).toBe("COMPLETED");
    const pay = await w.db.payment.findFirstOrThrow({ where: { sale_id: sale.id } });
    expect(pay).toMatchObject({ status: "CONFIRMED", provider_reference: null, payer_phone: null, financial_account_id: orange.id, confirmed_by_id: w.cashier.userId });

    // a bank transfer marked received also completes; a till account cannot be used as a collection account
    const bank = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, kind: "BANK" } });
    const s2 = await w.svc.sales.checkout(w.cashier, { branch_id: w.s1.id, register_id: w.regs.r1.id, lines, payments: [{ method: "BANK_TRANSFER", amount: q.total.toString(), financial_account_id: bank.id, received: true }] }, randomUUID());
    expect(s2.status).toBe("COMPLETED");
    const tillFa = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, kind: "TILL" } });
    await expect(w.svc.sales.checkout(w.cashier, { branch_id: w.s1.id, register_id: w.regs.r1.id, lines, payments: [{ method: "MOBILE_MONEY", amount: q.total.toString(), financial_account_id: tillFa.id, received: true }] }, randomUUID())).rejects.toMatchObject({ code: "INVALID_COLLECTION_ACCOUNT" });

    // not marked received: waits as before; then a manager confirms it without a reference
    const pending = await w.svc.sales.checkout(w.cashier, { branch_id: w.s1.id, register_id: w.regs.r1.id, lines, payments: [{ method: "BANK_TRANSFER", amount: q.total.toString() }] }, randomUUID());
    expect(pending.status).toBe("PENDING_PAYMENT");
    const pp = await w.db.payment.findFirstOrThrow({ where: { sale_id: pending.id } });
    await w.svc.sales.confirmPayment(w.manager, pp.id, null);
    expect((await w.db.sale.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("COMPLETED");
  });
});
