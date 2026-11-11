import { closeContext, makeWorld, World } from "./harness";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(closeContext);

describe("returns", () => {
  it("partial returns refund original amounts, restock at original cost, and cannot exceed the sold quantity", async () => {
    const v = await w.product({ retail: "1000", taxPercent: "10" });
    await w.stock(w.s1.id, v.id, "3", "400");
    await w.session(w.manager, w.regs.r2.id);
    await w.session(w.cashier, w.regs.r1.id, "5000");
    const sale = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "3", discount_amount: "300", discount_reason: "bulk" }]);
    // price changes after the sale must not affect the refund
    await w.db.productVariant.update({ where: { id: v.id }, data: { retail_price: "5000" } });
    await w.stock(w.s1.id, v.id, "1", "1000"); // average cost moves; restock must use original line cost
    const line = sale.lines[0];
    const r1 = await w.svc.sales.returnSale(w.manager, { sale_id: sale.id, register_id: w.regs.r2.id, reason: "Changed mind", refund_method: "CUSTOMER_CREDIT", lines: [{ sale_line_id: line.id, quantity: "1", condition: "SELLABLE" }] }).catch(() => null);
    expect(r1).toBeNull(); // no customer on the sale → account refund not possible
    const ret = await w.svc.sales.returnSale(w.manager, { sale_id: sale.id, register_id: w.regs.r1.id, reason: "Changed mind", refund_method: "CASH", lines: [{ sale_line_id: line.id, quantity: "1", condition: "SELLABLE" }] }).catch((e) => e);
    expect(ret.code).toBe("FORBIDDEN"); // manager cannot refund from the cashier's till
    const ok = await w.svc.sales.returnSale(w.manager, { sale_id: sale.id, register_id: w.regs.r2.id, reason: "Changed mind", refund_method: "BANK_TRANSFER", financial_account_id: (await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, code: "BANK-MAIN" } })).id, reference: "RF-1", lines: [{ sale_line_id: line.id, quantity: "1", condition: "SELLABLE" }] });
    expect(ok.refund_total.toString()).toBe("990"); // (3000 − 300) / 3 = 900 net + 90 tax
    expect(ok.lines[0].cost_amount.toString()).toBe("400"); // original cost, not new average
    await expect(w.svc.sales.returnSale(w.manager, { sale_id: sale.id, register_id: w.regs.r2.id, reason: "x", refund_method: "BANK_TRANSFER", financial_account_id: ok.lines[0].id, reference: "x", lines: [{ sale_line_id: line.id, quantity: "3", condition: "SELLABLE" }] })).rejects.toMatchObject({ code: "RETURN_EXCEEDS_SOLD" });
  });
  it("routes returned goods by condition; quarantined returns are not sellable and non-restockable are written off", async () => {
    const v = await w.product({ retail: "1000" });
    await w.stock(w.s1.id, v.id, "2", "600");
    const sale = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "2" }]);
    const bank = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, code: "BANK-MAIN" } });
    const quar = await w.loc(w.s1.id, "QUAR");
    const writeoffBefore = await w.glBalance("inventory_writeoff");
    await w.svc.sales.returnSale(w.manager, { sale_id: sale.id, reason: "Opened", refund_method: "BANK_TRANSFER", financial_account_id: bank.id, reference: "R2", lines: [{ sale_line_id: sale.lines[0].id, quantity: "1", condition: "QUARANTINED" }, { sale_line_id: sale.lines[0].id, quantity: "1", condition: "NON_RESTOCKABLE" }] });
    expect((await w.onHand(v.id, quar.id)).onHand.toString()).toBe("1");
    expect((await w.glBalance("inventory_writeoff")).minus(writeoffBefore).toString()).toBe("600");
    const [item] = await w.svc.catalogue.sellables(w.cashier, { branchId: w.s1.id, variantIds: [v.id] });
    expect(item.available).toBe("0.000");
  });
  it("large refunds need approval", async () => {
    const v = await w.product({ retail: "30000" });
    await w.stock(w.s1.id, v.id, "1", "20000");
    const sale = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "1" }]);
    const bank = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, code: "BANK-MAIN" } });
    const input = { sale_id: sale.id, reason: "Faulty", refund_method: "BANK_TRANSFER" as const, financial_account_id: bank.id, reference: "R3", lines: [{ sale_line_id: sale.lines[0].id, quantity: "1", condition: "DAMAGED" as const }] };
    await expect(w.svc.sales.returnSale(w.manager, input)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const req = await w.svc.approvals.request(w.manager, { type: "REFUND", reason: "Faulty", amount: "30000", branchId: w.s1.id });
    await w.svc.approvals.decide(w.owner, req.id, "APPROVE");
    const r = await w.svc.sales.returnSale(w.manager, { ...input, approval_request_id: req.id });
    expect(r.approved_by_id).toBe(w.owner.userId);
  });
});

describe("transfers", () => {
  it("in-transit stock stays visible until received; shortages are written off with a note and GL in-transit clears", async () => {
    const v = await w.product();
    await w.stock(w.s1.id, v.id, "10", "100");
    const from = await w.loc(w.s1.id, "FLOOR"), to = await w.loc(w.s2.id, "FLOOR");
    const t = await w.svc.inventory.createTransfer(w.keeper, { from_branch_id: w.s1.id, from_location_id: from.id, to_branch_id: w.s2.id, to_location_id: to.id, lines: [{ variant_id: v.id, quantity: "10" }] });
    await expect(w.svc.inventory.approveTransfer(w.keeper, t.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await w.svc.inventory.approveTransfer(w.manager, t.id);
    await w.svc.inventory.dispatchTransfer(w.keeper, t.id);
    expect((await w.glBalance("inventory_in_transit")).toString()).toBe("1000");
    const bal = await w.svc.inventory.balances(w.owner, { branch_id: w.s2.id, search: v.sku, page: 1, pageSize: 10, order: "asc" } as any);
    expect(bal.items[0].in_transit.toString()).toBe("10");
    const lineId = t.lines[0].id;
    await w.svc.inventory.receiveTransfer(w.keeper, t.id, { lines: [{ line_id: lineId, qty_received: "6" }] });
    expect((await w.db.stockTransfer.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("PARTIALLY_RECEIVED");
    await expect(w.svc.inventory.receiveTransfer(w.keeper, t.id, { lines: [{ line_id: lineId, qty_received: "3", qty_short: "1" }] })).rejects.toMatchObject({ code: "NOTE_REQUIRED" });
    await w.svc.inventory.receiveTransfer(w.keeper, t.id, { lines: [{ line_id: lineId, qty_received: "3", qty_short: "1", note: "Broken in van" }], close: true });
    expect((await w.glBalance("inventory_in_transit")).toString()).toBe("0");
    expect((await w.glBalance("inventory_loss")).toString()).toBe("100");
    expect((await w.onHand(v.id, to.id)).onHand.toString()).toBe("9");
    const pool = await w.db.inventoryCostPool.findFirstOrThrow({ where: { variant_id: v.id, branch_id: w.s2.id } });
    expect(pool.value.toString()).toBe("900");
  });
});
