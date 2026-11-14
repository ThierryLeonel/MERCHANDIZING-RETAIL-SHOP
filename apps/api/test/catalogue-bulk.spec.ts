import { randomUUID } from "node:crypto";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(closeContext);

const sell = (who: any, lines: any[], amount: string) =>
  w.svc.sales.checkout(who, { branch_id: w.s1.id, register_id: w.regs.r1.id, lines, payments: [{ method: "CASH", amount }] }, randomUUID());
const quote = (who: any, lines: any[]) => w.svc.sales.quote(who, { branch_id: w.s1.id, register_id: w.regs.r1.id, lines });

describe("bulk / loose goods and bargaining", () => {
  it("negotiable products need a minimum price on every SKU, not above retail", async () => {
    await expect(w.product({ retail: "1000", negotiable: true })).rejects.toMatchObject({ code: "MIN_PRICE_REQUIRED" });
    await expect(w.product({ retail: "1000", min: "1200" })).rejects.toMatchObject({ code: "MIN_ABOVE_RETAIL" });
    const v = await w.product({ retail: "1000", min: "800", negotiable: true });
    await expect(w.svc.catalogue.updateVariant(w.owner, v.id, { min_price: null })).rejects.toMatchObject({ code: "MIN_PRICE_REQUIRED" });
  });

  it("bulk goods sell in fractional quantities; a cashier can bargain down to the minimum but never below", async () => {
    const v = await w.product({ type: "BULK", unit: "KG", retail: "1000", min: "800", negotiable: true });
    await w.stock(w.s1.id, v.id, "50", "600"); // a 50 kg bag bought as one lot
    await w.session(w.cashier, w.regs.r1.id);

    // 2.5 kg at the agreed price of 850/kg — the cashier holds no price-override permission
    const q = await quote(w.cashier, [{ variant_id: v.id, quantity: "2.5", override_price: "850" }]);
    expect(q.total.toString()).toBe("2125");
    expect(q.lines[0].unit_price.toString()).toBe("850");
    const sale = await sell(w.cashier, [{ variant_id: v.id, quantity: "2.5", override_price: "850" }], "2125");
    expect(sale.lines[0].price_source).toBe("NEGOTIATED");
    expect((await w.onHand(v.id)).onHand.toString()).toBe("47.5");

    // exactly the minimum is allowed
    await sell(w.cashier, [{ variant_id: v.id, quantity: "1", override_price: "800" }], "800");
    // below the minimum is refused — no approval route, even for the owner
    await expect(quote(w.cashier, [{ variant_id: v.id, quantity: "1", override_price: "799" }])).rejects.toMatchObject({ code: "BELOW_MIN_PRICE" });
    await w.session(w.manager, w.regs.r2.id);
    await expect(w.svc.sales.checkout(w.manager, { branch_id: w.s1.id, register_id: w.regs.r2.id, lines: [{ variant_id: v.id, quantity: "1", override_price: "700" }], payments: [{ method: "CASH", amount: "700" }] }, randomUUID())).rejects.toMatchObject({ code: "BELOW_MIN_PRICE" });
    // a discount cannot be used to get round the floor either
    await expect(sell(w.cashier, [{ variant_id: v.id, quantity: "1", discount_amount: "250", discount_reason: "regular" }], "750")).rejects.toMatchObject({ code: "BELOW_MIN_PRICE" });
  });

  it("non-negotiable products keep the manager-approved override flow", async () => {
    const v = await w.product({ retail: "1000", min: "800" });
    await w.stock(w.s1.id, v.id, "5", "500");
    await w.session(w.cashier, w.regs.r1.id);
    await expect(quote(w.cashier, [{ variant_id: v.id, quantity: "1", override_price: "900" }])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bulk products have one SKU and no serial numbers; bargaining can be switched on later only with minimum prices", async () => {
    await expect(w.product({ type: "BULK", unit: "KG", serials: true })).rejects.toMatchObject({ code: "BULK_NO_SERIALS" });
    const v = await w.product({ type: "BULK", unit: "BALE", retail: "60000" });
    await expect(w.svc.catalogue.updateProduct(w.owner, v.product_id, { negotiable_price: true })).rejects.toMatchObject({ code: "MIN_PRICE_REQUIRED" });
    await expect(w.svc.catalogue.updateProduct(w.keeper, v.product_id, { negotiable_price: true })).rejects.toMatchObject({ code: "FORBIDDEN_PRICE" });
    await w.svc.catalogue.updateVariant(w.owner, v.id, { min_price: "50000" });
    const p = await w.svc.catalogue.updateProduct(w.owner, v.product_id, { negotiable_price: true });
    expect(p.negotiable_price).toBe(true);
  });

  it("product list filtered by a category includes its sub-categories", async () => {
    const parent = await w.db.category.create({ data: { business_id: w.B, code: `C-${randomUUID().slice(0, 6)}`, name: "Clothing" } });
    const child = await w.db.category.create({ data: { business_id: w.B, code: `C-${randomUUID().slice(0, 6)}`, name: "Second-hand bales", parent_id: parent.id } });
    const v = await w.product({ type: "BULK", unit: "BALE", retail: "60000" });
    await w.svc.catalogue.updateProduct(w.owner, v.product_id, { category_id: child.id });
    const list = await w.svc.catalogue.listProducts(w.owner, { page: 1, pageSize: 50, category_id: parent.id } as any);
    expect(list.items.map((p: any) => p.id)).toContain(v.product_id);
  });
});
