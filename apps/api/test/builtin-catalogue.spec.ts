import { BuiltinCatalogueService } from "../src/modules/catalogue/builtin-catalogue.service";
import { BUILTIN_ITEMS } from "../src/seed/builtin-catalogue.data";
import { D } from "../src/common/money";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
let builtin: BuiltinCatalogueService;
beforeAll(async () => { w = await makeWorld(); builtin = w.app.get(BuiltinCatalogueService); }, 120_000);
afterAll(closeContext);

describe("built-in catalogue, starting stock and category deactivation", () => {
  it("installs the 599 built-in products in 13 categories once, without duplicating", async () => {
    expect(BUILTIN_ITEMS).toHaveLength(599);
    const r = await builtin.install(w.owner, "startup");
    expect(r.created + r.skipped).toBe(599);
    expect(r.created).toBe(599);
    expect(r.categories_created).toBe(13);
    const sita = await w.db.productVariant.findFirstOrThrow({ where: { business_id: w.B, sku: "HOME-019" }, include: { product: true } });
    expect(sita).toMatchObject({ name: "Sita - Pack" });
    expect((await w.db.category.findUniqueOrThrow({ where: { id: sita.product.category_id! } })).name).toBe("Household / Home");
    expect(D(sita.retail_price).equals(0)).toBe(true); // price not set yet
    expect((await w.db.business.findUniqueOrThrow({ where: { id: w.B } })).settings).toMatchObject({ builtin_catalogue: { version: 1 } });
    for (const code of ["ROLL", "BTL", "TIN", "CUP", "REAM"]) expect(await w.db.unit.count({ where: { business_id: w.B, code } })).toBe(1);

    // a deleted item comes back only through "re-add missing"; nothing else is duplicated
    const mop = await w.db.product.findFirstOrThrow({ where: { business_id: w.B, code: "HOME-051" } });
    await w.svc.catalogue.deleteProduct(w.owner, mop.id);
    const again = await builtin.install(w.owner, "manual");
    expect(again).toMatchObject({ created: 1, skipped: 598, categories_created: 0 });
    expect((await builtin.status(w.B)).missing).toBe(0);
  }, 180_000);

  it("posts starting stock with buying prices and sets selling prices", async () => {
    const rows = await builtin.startingStock(w.owner, w.s1.id);
    const fans = rows.find((r) => r.sku === "HOME-001")!;
    expect(fans.suggested_qty).toBe("9");
    expect(rows.find((r) => r.sku === "HOME-051")!.suggested_qty).toBe("0"); // restock item
    const sita = rows.find((r) => r.sku === "HOME-019")!;
    expect(sita.suggested_qty).toBe("3.5");

    await expect(builtin.saveStartingStock(w.owner, { branch_id: w.s1.id, lines: [{ variant_id: fans.variant_id, quantity: "9" }] })).rejects.toMatchObject({ code: "STARTING_STOCK_INVALID" });
    const res = await builtin.saveStartingStock(w.owner, { branch_id: w.s1.id, lines: [
      { variant_id: fans.variant_id, quantity: "9", unit_cost: "500", retail_price: "1000" },
      { variant_id: sita.variant_id, quantity: "3.5", unit_cost: "2000", retail_price: "3000" },
    ] });
    expect(res.opening_stock).toMatchObject({ lines: 2, total: "11500" });
    expect(res.prices_set).toBe(2);
    expect((await w.onHand(fans.variant_id)).onHand.toString()).toBe("9");
    expect(D((await w.db.productVariant.findUniqueOrThrow({ where: { id: fans.variant_id } })).retail_price).toString()).toBe("1000");
    // stocked products leave the list; the suggestion disappears at other branches too
    expect((await builtin.startingStock(w.owner, w.s1.id)).some((r) => r.sku === "HOME-001")).toBe(false);
    expect((await builtin.startingStock(w.owner, w.s2.id)).find((r) => r.sku === "HOME-001")!.suggested_qty).toBeNull();
  });

  it("hides products of a deactivated category from the till and refuses to sell them", async () => {
    const cat = await w.db.category.findFirstOrThrow({ where: { business_id: w.B, name: "Household / Home" } });
    const fans = await w.db.productVariant.findFirstOrThrow({ where: { business_id: w.B, sku: "HOME-001" } });
    expect((await w.svc.catalogue.sellables(w.cashier, { branchId: w.s1.id, search: "Hand Fans" })).length).toBe(1);
    await w.db.category.update({ where: { id: cat.id }, data: { active: false } });
    expect((await w.svc.catalogue.sellables(w.cashier, { branchId: w.s1.id, search: "Hand Fans" })).length).toBe(0);
    await expect(w.svc.catalogue.lookup(w.cashier, "HOME-001", w.s1.id)).rejects.toMatchObject({ code: "CATEGORY_INACTIVE" });
    await expect(w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: fans.id, quantity: "1" }])).rejects.toMatchObject({ code: "CATEGORY_INACTIVE" });
    await w.db.category.update({ where: { id: cat.id }, data: { active: true } });
    const sale = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: fans.id, quantity: "1" }]);
    expect(sale.status).toBe("COMPLETED");
  });

  it("only the Owner and System Administrator manage products and categories", async () => {
    expect(w.owner.permissions.has("products.manage")).toBe(true);
    expect(w.sysadmin.permissions.has("products.manage")).toBe(true);
    expect(w.sysadmin.permissions.has("inventory.opening")).toBe(true);
    for (const who of [w.manager, w.cashier, w.keeper, w.accountant]) expect(who.permissions.has("products.manage")).toBe(false);
  });
});
