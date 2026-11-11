import { D } from "../src/common/money";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(closeContext);

async function approvedPO(qty: string, cost: string, variantId: string) {
  const po = await w.svc.purchasing.createPO(w.owner, { branch_id: w.s1.id, supplier_id: w.supplier.id, lines: [{ variant_id: variantId, quantity: qty, unit_cost: cost }] });
  const sub = await w.svc.purchasing.submitPO(w.owner, po.id);
  if (sub!.status === "SUBMITTED") await w.svc.approvals.decide(w.manager, sub!.approval_request_id!, "APPROVE");
  return w.svc.purchasing.getPO(w.owner, po.id);
}

describe("purchase order lifecycle and approvals", () => {
  it("high-value POs need approval; the creator cannot approve their own PO", async () => {
    const v = await w.product();
    const po = await w.svc.purchasing.createPO(w.manager, { branch_id: w.s1.id, supplier_id: w.supplier.id, lines: [{ variant_id: v.id, quantity: "100", unit_cost: "10000" }] });
    const sub = await w.svc.purchasing.submitPO(w.manager, po.id);
    expect(sub!.status).toBe("SUBMITTED");
    await expect(w.svc.approvals.decide(w.manager, sub!.approval_request_id!, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await w.svc.approvals.decide(w.owner, sub!.approval_request_id!, "APPROVE");
    expect((await w.db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("APPROVED");
  });
  it("technical administration does not confer approval authority", async () => {
    const admin = await (async () => {
      const { createUser } = await import("../src/seed/business-setup");
      await w.db.$transaction((tx) => createUser(tx, w.B, { email: `sysadmin.${w.B.slice(0, 6)}@t.local`, name: "Admin", password: "Test@123456", roles: ["SYSTEM_ADMIN"], branchIds: [], allBranches: true }));
      return w.actor(`sysadmin.${w.B.slice(0, 6)}@t.local`);
    })();
    const v = await w.product();
    const po = await w.svc.purchasing.createPO(w.owner, { branch_id: w.s1.id, supplier_id: w.supplier.id, lines: [{ variant_id: v.id, quantity: "100", unit_cost: "10000" }] });
    const sub = await w.svc.purchasing.submitPO(w.owner, po.id);
    await expect(w.svc.approvals.decide(admin, sub!.approval_request_id!, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("partial receiving, invoice matching and no double counting", () => {
  it("tracks partial receipts, blocks over-receipt, and the invoice clears GRNI without touching inventory", async () => {
    const v = await w.product();
    const po = await approvedPO("10", "100", v.id);
    const line = po.lines[0];
    const invBefore = await w.glBalance("inventory");
    const r1 = await w.svc.purchasing.receive(w.keeper, { branch_id: w.s1.id, purchase_order_id: po.id, lines: [{ purchase_order_line_id: line.id, variant_id: v.id, qty_accepted: "4", qty_damaged: "1", qty_rejected: "2" }] });
    let poNow = await w.db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(poNow.status).toBe("PARTIALLY_RECEIVED");
    expect(r1.total_value.toString()).toBe("500"); // accepted 4 + damaged 1 (rejected not stocked)
    const dmg = await w.loc(w.s1.id, "DMG");
    expect((await w.onHand(v.id, dmg.id)).onHand.toString()).toBe("1");
    await expect(w.svc.purchasing.receive(w.keeper, { branch_id: w.s1.id, purchase_order_id: po.id, lines: [{ purchase_order_line_id: line.id, variant_id: v.id, qty_accepted: "6" }] })).rejects.toMatchObject({ code: "OVER_RECEIPT" });
    const r2 = await w.svc.purchasing.receive(w.keeper, { branch_id: w.s1.id, purchase_order_id: po.id, lines: [{ purchase_order_line_id: line.id, variant_id: v.id, qty_accepted: "5" }] });
    poNow = await w.db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(poNow.receipt_status).toBe("FULLY_RECEIVED");
    expect((await w.glBalance("inventory")).minus(invBefore).toString()).toBe("1000");

    // Invoice at a higher price: inventory unchanged, GRNI cleared, variance to PPV
    const grniBefore = await w.glBalance("grni");
    const invAfterReceipts = await w.glBalance("inventory");
    const inv = await w.svc.purchasing.postInvoice(w.owner, {
      branch_id: w.s1.id, supplier_id: w.supplier.id, supplier_invoice_no: `INV-${Date.now()}`, invoice_date: new Date().toISOString().slice(0, 10),
      lines: [...r1.lines, ...r2.lines].map((l) => ({ goods_receipt_line_id: l.id, base_unit_cost: "110" })),
    });
    expect(inv.total.toString()).toBe("1100");
    expect((await w.glBalance("inventory")).equals(invAfterReceipts)).toBe(true);
    expect((await w.glBalance("grni")).minus(grniBefore).toString()).toBe("1000");
    expect((await w.glBalance("purchase_price_variance")).toString()).toBe("100");
    expect((await w.db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).invoice_status).toBe("FULLY_INVOICED");
    // invoicing the same receipt again is rejected
    await expect(w.svc.purchasing.postInvoice(w.owner, { branch_id: w.s1.id, supplier_id: w.supplier.id, supplier_invoice_no: `INV2-${Date.now()}`, invoice_date: new Date().toISOString().slice(0, 10), lines: [{ goods_receipt_line_id: r2.lines[0].id, quantity_base: "1" }] })).rejects.toMatchObject({ code: "INVOICE_EXCEEDS_RECEIPT" });

    // pay part; balance reflects allocation, over-allocation rejected
    const bank = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, code: "BANK-MAIN" } });
    await expect(w.svc.purchasing.paySupplier(w.owner, { branch_id: w.s1.id, supplier_id: w.supplier.id, financial_account_id: bank.id, amount: "2000", payment_date: new Date().toISOString().slice(0, 10), allocations: [{ supplier_invoice_id: inv.id, amount: "1500" }] })).rejects.toMatchObject({ code: "OVER_ALLOCATION" });
    await w.svc.purchasing.paySupplier(w.owner, { branch_id: w.s1.id, supplier_id: w.supplier.id, financial_account_id: bank.id, amount: "1500", payment_date: new Date().toISOString().slice(0, 10), allocations: [{ supplier_invoice_id: inv.id, amount: "1100" }] });
    const bal = await w.svc.purchasing.supplierBalance(w.owner, w.supplier.id);
    expect(bal.advances.toString()).toBe("400");
  });
  it("receipts are idempotent per business key (duplicate submissions do not double stock)", async () => {
    // HTTP-level idempotency is covered in http-security.spec; here we confirm the PO limit prevents duplicate recognition.
    const v = await w.product();
    const po = await approvedPO("3", "50", v.id);
    await w.svc.purchasing.receive(w.keeper, { branch_id: w.s1.id, purchase_order_id: po.id, lines: [{ purchase_order_line_id: po.lines[0].id, variant_id: v.id, qty_accepted: "3" }] });
    await expect(w.svc.purchasing.receive(w.keeper, { branch_id: w.s1.id, purchase_order_id: po.id, lines: [{ purchase_order_line_id: po.lines[0].id, variant_id: v.id, qty_accepted: "3" }] })).rejects.toMatchObject({ code: "PO_NOT_RECEIVABLE" });
    expect((await w.onHand(v.id)).onHand.toString()).toBe("3");
  });
});
