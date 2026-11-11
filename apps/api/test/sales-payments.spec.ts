import { randomUUID } from "node:crypto";
import { D } from "../src/common/money";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(closeContext);

const checkout = (who: any, reg: string, lines: any[], payments: any[], extra: any = {}) =>
  w.svc.sales.checkout(who, { branch_id: w.s1.id, register_id: reg, lines, payments, ...extra }, randomUUID());

describe("pricing precedence and backend totals", () => {
  it("branch list > business list > variant price, honouring effective dates", async () => {
    const v = await w.product({ retail: "1000" });
    const retail = await w.db.priceList.findFirstOrThrow({ where: { business_id: w.B, code: "RETAIL" } });
    const branchList = await w.db.priceList.create({ data: { business_id: w.B, code: `S1-${v.sku}`, name: "S1", kind: "RETAIL", branch_id: w.s1.id } });
    const past = new Date(Date.now() - 86400_000), future = new Date(Date.now() + 86400_000);
    const r = (branchId = w.s1.id) => w.svc.pricing.resolve(w.db as any, { businessId: w.B, branchId, variantId: v.id, kind: "RETAIL" });
    expect((await r()).unitPrice.toString()).toBe("1000");
    await w.db.priceListItem.create({ data: { price_list_id: retail.id, variant_id: v.id, price: D(950), effective_from: past } });
    expect((await r()).unitPrice.toString()).toBe("950");
    await w.db.priceListItem.create({ data: { price_list_id: branchList.id, variant_id: v.id, price: D(900), effective_from: future } });
    expect((await r()).unitPrice.toString()).toBe("950"); // not yet effective
    await w.db.priceListItem.create({ data: { price_list_id: branchList.id, variant_id: v.id, price: D(920), effective_from: past } });
    expect((await r()).unitPrice.toString()).toBe("920");
    expect((await r(w.s2.id)).unitPrice.toString()).toBe("950"); // other branch uses business list
  });
  it("ignores client-supplied prices: the backend computes totals with tax", async () => {
    const v = await w.product({ retail: "1000", taxPercent: "10" });
    await w.stock(w.s1.id, v.id, "5", "500");
    await w.session(w.cashier, w.regs.r1.id);
    await expect(checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "2" }], [{ method: "CASH", amount: "2000" }])).rejects.toMatchObject({ code: "PAYMENT_MISMATCH" });
    const s = await checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "2" }], [{ method: "CASH", amount: "2200", amount_tendered: "5000" }]);
    expect([s.net_amount.toString(), s.tax_total.toString(), s.total.toString(), s.change_given.toString()]).toEqual(["2000", "200", "2200", "2800"]);
    const cash = s.payments[0];
    expect([cash.amount_tendered!.toString(), cash.change_given.toString(), cash.amount.toString()]).toEqual(["5000", "2800", "2200"]); // tendered / change / retained
  });
});

describe("discount and minimum price controls", () => {
  it("discounts above the policy need approval; below-minimum prices need price-override approval; approvals are single-use", async () => {
    const v = await w.product({ retail: "1000", min: "800" });
    await w.stock(w.s1.id, v.id, "10", "500");
    await w.session(w.cashier, w.regs.r1.id);
    await expect(checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "1", discount_amount: "50" }], [{ method: "CASH", amount: "950" }])).rejects.toMatchObject({ code: "DISCOUNT_REASON_REQUIRED" });
    const ok = await checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "1", discount_amount: "50", discount_reason: "dent" }], [{ method: "CASH", amount: "950" }]);
    expect(ok.discount_total.toString()).toBe("50");
    await expect(checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "1", discount_amount: "150", discount_reason: "x" }], [{ method: "CASH", amount: "850" }])).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", details: { approval_type: "DISCOUNT" } });
    await expect(checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "1", discount_amount: "250", discount_reason: "x" }], [{ method: "CASH", amount: "750" }])).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", details: { approval_type: "PRICE_OVERRIDE" } });
    const req = await w.svc.approvals.request(w.cashier, { type: "PRICE_OVERRIDE", reason: "Display model", amount: "250", branchId: w.s1.id });
    await expect(w.svc.approvals.decide(w.cashier, req.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await w.svc.approvals.decide(w.manager, req.id, "APPROVE");
    await checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "1", discount_amount: "250", discount_reason: "Display model", approval_request_id: req.id }], [{ method: "CASH", amount: "750" }]);
    await expect(checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "1", discount_amount: "250", discount_reason: "again", approval_request_id: req.id }], [{ method: "CASH", amount: "750" }])).rejects.toMatchObject({ code: "APPROVAL_NOT_APPROVED" });
  });
});

describe("split payments and the payment state machine", () => {
  it("split cash + mobile money: sale stays pending (stock reserved) until the electronic part is confirmed", async () => {
    const v = await w.product({ retail: "5000" });
    await w.stock(w.s1.id, v.id, "2", "3000");
    await w.session(w.cashier, w.regs.r1.id);
    const sale = await checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "2" }], [{ method: "CASH", amount: "4000" }, { method: "MOBILE_MONEY", amount: "6000", payer_phone: "+237600000000" }]);
    expect(sale.status).toBe("PENDING_PAYMENT");
    expect((await w.onHand(v.id)).reserved.toString()).toBe("2");
    expect(sale.payments.find((p: any) => p.method === "MOBILE_MONEY").status).toBe("PENDING"); // never "successful" just because it was selected
    await expect(w.svc.sales.confirmPayment(w.cashier, sale.payments[1].id, "REF")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await w.svc.sales.confirmPayment(w.manager, sale.payments.find((p: any) => p.method === "MOBILE_MONEY").id, "MOMO-123");
    const done = await w.db.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(done.status).toBe("COMPLETED");
    expect((await w.onHand(v.id)).onHand.toString()).toBe("0");
    expect((await w.onHand(v.id)).reserved.toString()).toBe("0");
    const audit = await w.db.auditEvent.findFirst({ where: { action: "payment.manually_confirmed", entity_id: sale.payments[1].id } });
    expect(audit?.actor_id).toBe(w.manager.userId);
  });

  it("duplicate provider callbacks are ignored and stock/accounting are recorded once", async () => {
    const v = await w.product({ retail: "3000" });
    await w.stock(w.s1.id, v.id, "3", "1000");
    await w.session(w.cashier, w.regs.r1.id);
    const sale = await checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "1" }], [{ method: "MOBILE_MONEY", amount: "3000" }]);
    const attempt = await w.db.paymentAttempt.findFirstOrThrow({ where: { payment_id: sale.payments[0].id } });
    const evt = { event_id: `evt-${randomUUID()}`, request_reference: attempt.request_reference, status: "SUCCESSFUL" as const, external_reference: "X1" };
    const results = await Promise.all([w.svc.sales.handleProviderEvent("SIMULATOR", evt, evt), w.svc.sales.handleProviderEvent("SIMULATOR", evt, evt)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["confirmed", "duplicate"]);
    const late = await w.svc.sales.handleProviderEvent("SIMULATOR", { ...evt, event_id: `evt-${randomUUID()}`, status: "FAILED" }, {});
    expect(late.outcome).toMatch(/ignored_final_state/);
    expect((await w.db.journalEntry.count({ where: { source_type: "sale", source_id: sale.id } }))).toBe(1);
    expect((await w.onHand(v.id)).onHand.toString()).toBe("2");
  });

  it("timeout recovery: expired attempts fail; the cashier can switch to cash, or cancel and release the reservation", async () => {
    const v = await w.product({ retail: "2000" });
    await w.stock(w.s1.id, v.id, "2", "1000");
    await w.session(w.cashier, w.regs.r1.id);
    const sale = await checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "1" }], [{ method: "MOBILE_MONEY", amount: "2000" }]);
    await w.db.paymentAttempt.updateMany({ where: { payment_id: sale.payments[0].id }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect(await w.svc.sales.expireStaleAttempts()).toBeGreaterThanOrEqual(1);
    expect((await w.db.payment.findUniqueOrThrow({ where: { id: sale.payments[0].id } })).status).toBe("FAILED");
    expect((await w.db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("PENDING_PAYMENT");
    const done = await w.svc.sales.addPayment(w.cashier, sale.id, { method: "CASH", amount: "2000", amount_tendered: "2000" });
    expect(done.status).toBe("COMPLETED");

    const sale2 = await checkout(w.cashier, w.regs.r1.id, [{ variant_id: v.id, quantity: "1" }], [{ method: "MOBILE_MONEY", amount: "2000" }]);
    expect((await w.onHand(v.id)).reserved.toString()).toBe("1");
    await w.svc.sales.cancelPending(w.cashier, sale2.id, "Customer left");
    expect((await w.onHand(v.id)).reserved.toString()).toBe("0");
    expect((await w.db.sale.findUniqueOrThrow({ where: { id: sale2.id } })).status).toBe("CANCELLED");
  });

  it("held carts do not reserve stock", async () => {
    const v = await w.product();
    await w.stock(w.s1.id, v.id, "1", "100");
    await w.svc.sales.holdCart(w.cashier, { branch_id: w.s1.id, label: "Mrs A", payload: { lines: [{ variant_id: v.id, quantity: "1" }] } });
    expect((await w.onHand(v.id)).reserved.toString()).toBe("0");
  });

  it("idempotent checkout: replaying the same key returns the same sale", async () => {
    const v = await w.product({ retail: "100" });
    await w.stock(w.s1.id, v.id, "5", "50");
    await w.session(w.cashier, w.regs.r1.id);
    const key = randomUUID();
    const input = { branch_id: w.s1.id, register_id: w.regs.r1.id, lines: [{ variant_id: v.id, quantity: "1" }], payments: [{ method: "CASH" as const, amount: "100" }] };
    const a = await w.svc.sales.checkout(w.cashier, input, key);
    const b = await w.svc.sales.checkout(w.cashier, input, key);
    expect(a.id).toBe(b.id);
    expect((await w.onHand(v.id)).onHand.toString()).toBe("4");
  });
});

describe("customer credit", () => {
  it("enforces credit limits with approval for exceptions; deposits are not revenue", async () => {
    const v = await w.product({ retail: "10000" });
    await w.stock(w.s1.id, v.id, "5", "5000");
    const cust = await w.svc.customers.create(w.owner, { name: "Hotel", credit_status: "ACTIVE", credit_limit: "15000", payment_terms_days: 30 });
    await w.session(w.manager, w.regs.r2.id);
    const credit = (amt: string, approval?: string) => checkout(w.manager, w.regs.r2.id, [{ variant_id: v.id, quantity: String(Number(amt) / 10000) }], [{ method: "CUSTOMER_CREDIT", amount: amt, approval_request_id: approval }], { customer_id: cust.id });
    await credit("10000");
    await expect(credit("10000")).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", details: { approval_type: "CUSTOMER_CREDIT" } });
    const req = await w.svc.approvals.request(w.manager, { type: "CUSTOMER_CREDIT", reason: "Event booking", amount: "5000", branchId: w.s1.id });
    await w.svc.approvals.decide(w.owner, req.id, "APPROVE");
    await credit("10000", req.id);
    const det = await w.svc.customers.get(w.owner, cust.id);
    expect(det.receivable.toString()).toBe("20000");
    const bank = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, code: "BANK-MAIN" } });
    const revenueBefore = await w.glBalance("sales_revenue");
    await w.svc.customers.receivePayment(w.owner, cust.id, { branch_id: w.s1.id, financial_account_id: bank.id, amount: "25000", allocations: det.open_invoices.map((i: any) => ({ sale_id: i.id, amount: i.outstanding.toString() })) });
    const after = await w.svc.customers.get(w.owner, cust.id);
    expect(after.receivable.toString()).toBe("0");
    expect(after.deposits.toString()).toBe("5000");
    expect((await w.glBalance("sales_revenue")).equals(revenueBefore)).toBe(true);
  });
});
