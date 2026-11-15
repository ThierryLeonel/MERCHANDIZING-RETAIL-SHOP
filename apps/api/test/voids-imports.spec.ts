import { randomUUID } from "node:crypto";
import { D } from "../src/common/money";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
let safe: { id: string };
beforeAll(async () => {
  w = await makeWorld();
  safe = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, kind: "SAFE", branch_id: w.s1.id } });
});
afterAll(closeContext);

describe("voiding transactions (records kept, reversals posted)", () => {
  it("an administrator voids a cash sale: stock comes back, cash is refunded from the safe, the sale stays on record", async () => {
    const v = await w.product({ retail: "2000" });
    await w.stock(w.s1.id, v.id, "10", "1200");
    const invBefore = await w.glBalance("inventory");
    const safeBefore = (await w.svc.finance.accountBalances(w.owner)).find((a: any) => a.id === safe.id)!.balance;
    const sale = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "3" }]);
    expect((await w.onHand(v.id)).onHand.toString()).toBe("7");

    await expect(w.svc.sales.voidSale(w.manager, sale.id, { reason: "rung up twice", refund_method: "CASH", financial_account_id: safe.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const voided = await w.svc.sales.voidSale(w.owner, sale.id, { reason: "rung up twice", refund_method: "CASH", financial_account_id: safe.id });
    expect(voided.voided_at).toBeTruthy();
    expect(voided.void_reason).toBe("rung up twice");
    expect(voided.status).toBe("COMPLETED"); // the sale is kept; the void is a recorded reversal
    expect((await w.onHand(v.id)).onHand.toString()).toBe("10");
    expect((await w.glBalance("inventory")).toString()).toBe(invBefore.toString());
    const safeAfter = (await w.svc.finance.accountBalances(w.owner)).find((a: any) => a.id === safe.id)!.balance;
    expect(D(safeBefore).minus(safeAfter).toString()).toBe("6000");

    await expect(w.svc.sales.voidSale(w.owner, sale.id, { reason: "again", refund_method: "CASH", financial_account_id: safe.id })).rejects.toMatchObject({ code: "ALREADY_VOIDED" });
    await w.session(w.manager, w.regs.r2.id);
    await expect(w.svc.sales.returnSale(w.manager, { sale_id: sale.id, register_id: w.regs.r2.id, reason: "x", refund_method: "CASH", lines: [{ sale_line_id: sale.lines[0].id, quantity: "1", condition: "SELLABLE" }] })).rejects.toMatchObject({ code: "SALE_VOIDED" });
  });

  it("voids an expense with a mirror-image reversal", async () => {
    const cat = await w.db.expenseCategory.findFirstOrThrow({ where: { business_id: w.B } });
    const e = await w.svc.finance.createExpense(w.owner, { branch_id: w.s1.id, expense_date: new Date().toISOString().slice(0, 10), payee: "Electricity", financial_account_id: safe.id, lines: [{ expense_category_id: cat.id, description: "bill", amount: "15000" }] });
    const expAcct = await w.db.journalLine.aggregate({ where: { account_id: cat.account_id }, _sum: { debit: true, credit: true } });
    const voided = await w.svc.finance.voidExpense(w.owner, e.id, "entered on the wrong branch");
    expect(voided.status).toBe("REVERSED");
    const after = await w.db.journalLine.aggregate({ where: { account_id: cat.account_id }, _sum: { debit: true, credit: true } });
    expect(D(after._sum.debit!).minus(after._sum.credit!).toString()).toBe(D(expAcct._sum.debit!).minus(expAcct._sum.credit!).minus(15000).toString());
    await expect(w.svc.finance.voidExpense(w.owner, e.id, "again")).rejects.toMatchObject({ code: "ALREADY_VOIDED" });
  });

  it("voids a customer account payment and a supplier payment", async () => {
    const c = await w.svc.customers.create(w.owner, { name: "Void Test Customer", phone: "677000111" });
    const pay = await w.svc.customers.receivePayment(w.owner, c.id, { branch_id: w.s1.id, financial_account_id: safe.id, amount: "5000" });
    expect((await w.svc.customers.balances(w.db as any, w.B, c.id)).deposits.toString()).toBe("5000");
    await w.svc.customers.voidPayment(w.owner, pay.payment_id, "wrong customer");
    expect((await w.svc.customers.balances(w.db as any, w.B, c.id)).deposits.toString()).toBe("0");
    await expect(w.svc.customers.voidPayment(w.owner, pay.payment_id, "again")).rejects.toMatchObject({ code: "ALREADY_VOIDED" });

    const advBefore = await w.glBalance("supplier_advance");
    const sp = await w.svc.purchasing.paySupplier(w.owner, { branch_id: w.s1.id, supplier_id: w.supplier.id, payment_date: new Date().toISOString().slice(0, 10), financial_account_id: safe.id, amount: "8000" });
    expect((await w.glBalance("supplier_advance")).minus(advBefore).toString()).toBe("8000");
    const vsp = await w.svc.purchasing.voidSupplierPayment(w.owner, sp.id, "duplicate");
    expect(vsp.status).toBe("REVERSED");
    expect((await w.glBalance("supplier_advance")).toString()).toBe(advBefore.toString());
  });
});

describe("deleting records that were never used", () => {
  it("deletes an unused product and customer, refuses ones with history", async () => {
    const unused = await w.product();
    await w.svc.catalogue.deleteProduct(w.owner, unused.product_id);
    expect(await w.db.product.findUnique({ where: { id: unused.product_id } })).toBeNull();
    const used = await w.product();
    await w.stock(w.s1.id, used.id, "2", "100");
    await expect(w.svc.catalogue.deleteProduct(w.owner, used.product_id)).rejects.toMatchObject({ code: "PRODUCT_IN_USE" });

    const fresh = await w.svc.customers.create(w.owner, { name: "Never Bought" });
    await w.svc.customers.remove(w.owner, fresh.id);
    expect(await w.db.customer.findUnique({ where: { id: fresh.id } })).toBeNull();
    const payer = await w.svc.customers.create(w.owner, { name: "Has Payments" });
    await w.svc.customers.receivePayment(w.owner, payer.id, { branch_id: w.s1.id, financial_account_id: safe.id, amount: "100" });
    await expect(w.svc.customers.remove(w.owner, payer.id)).rejects.toMatchObject({ code: "CUSTOMER_IN_USE" });
  });
});

describe("spreadsheet imports", () => {
  const tag = randomUUID().slice(0, 6).toUpperCase();
  it("validates the whole product file first and saves nothing if any row is wrong", async () => {
    const res = await w.svc.imports.products(w.owner, { dry_run: false, rows: [
      { Nom: `Riz parfumé ${tag}`, Catégorie: "Alimentation > Riz", "Prix de vente": "1 500", Unité: "kg" },
      { Nom: `Bad price ${tag}`, "Prix de vente": "abc" },
      { name: `Dup ${tag}`, sku: `DUP-${tag}`, price: "100" },
      { name: `Dup2 ${tag}`, sku: `DUP-${tag}`, price: "100" },
    ] });
    expect(res.ok).toBe(false);
    expect(res.dry_run).toBe(true);
    expect(res.rows[1].errors[0]).toMatch(/not a number/);
    expect(res.rows[3].errors[0]).toMatch(/appears twice/);
    expect(await w.db.product.count({ where: { business_id: w.B, name: `Riz parfumé ${tag}` } })).toBe(0);
  });

  it("creates products with category paths and units (French headers), then updates them on re-import; unpriced items cannot be sold", async () => {
    const rows = [
      { Nom: `Riz parfumé 5kg ${tag}`, Catégorie: "Alimentation > Riz", "Prix de vente": "4 500", "Code-barres": `600${Date.now() % 1e9}` },
      { Nom: `Huile végétale 1L ${tag}`, Catégorie: "Alimentation > Huiles", SKU: `OIL-${tag}` },
      { Nom: `Arachides ${tag}`, Catégorie: "Vrac", Type: "vrac", Unité: "Kilogram", "Prix de vente": "1200", "Prix minimum": "1000", Marchandage: "oui" },
    ];
    const plan = await w.svc.imports.products(w.owner, { rows });
    expect(plan.ok).toBe(true);
    expect(plan.dry_run).toBe(true);
    expect(plan.rows[1].warnings[0]).toMatch(/No selling price/);
    const done = await w.svc.imports.products(w.owner, { rows, dry_run: false });
    expect(done.created).toBe(3);
    const rice = await w.db.product.findFirstOrThrow({ where: { business_id: w.B, name: `Riz parfumé 5kg ${tag}` }, include: { variants: true } });
    const cat = await w.db.category.findFirstOrThrow({ where: { id: rice.category_id! } });
    expect(cat.name).toBe("Riz");
    expect((await w.db.category.findUniqueOrThrow({ where: { id: cat.parent_id! } })).name).toBe("Alimentation");
    const nuts = await w.db.product.findFirstOrThrow({ where: { business_id: w.B, name: `Arachides ${tag}` } });
    expect(nuts.product_type).toBe("BULK");
    expect(nuts.negotiable_price).toBe(true);
    expect((await w.db.unit.findUniqueOrThrow({ where: { id: nuts.base_unit_id } })).code).toBe("KG");

    // unpriced product cannot be sold
    const oil = await w.db.productVariant.findFirstOrThrow({ where: { business_id: w.B, sku: `OIL-${tag}` } });
    await w.stock(w.s1.id, oil.id, "5", "900");
    await w.session(w.cashier, w.regs.r1.id);
    await expect(w.svc.sales.quote(w.cashier, { branch_id: w.s1.id, register_id: w.regs.r1.id, lines: [{ variant_id: oil.id, quantity: "1" }] })).rejects.toMatchObject({ code: "PRICE_NOT_SET" });

    // re-import sets the price (matched by SKU)
    const upd = await w.svc.imports.products(w.owner, { rows: [{ sku: `OIL-${tag}`, price: "1300" }], dry_run: false });
    expect(upd.updated).toBe(1);
    const q = await w.svc.sales.quote(w.cashier, { branch_id: w.s1.id, register_id: w.regs.r1.id, lines: [{ variant_id: oil.id, quantity: "1" }] });
    expect(q.lines[0].unit_price.toString()).toBe("1300");
  });

  it("imports products with opening stock in one file, and stock on its own", async () => {
    const res = await w.svc.imports.products(w.owner, { branch_id: w.s1.id, dry_run: false, rows: [{ name: `Sucre 1kg ${tag}`, sku: `SUG-${tag}`, price: "900", quantity: "40", cost: "700" }] });
    expect(res.ok).toBe(true);
    expect(res.opening_stock?.lines).toBe(1);
    const sugar = await w.db.productVariant.findFirstOrThrow({ where: { business_id: w.B, sku: `SUG-${tag}` } });
    expect((await w.onHand(sugar.id)).onHand.toString()).toBe("40");

    const missingCost = await w.svc.imports.stock(w.owner, { branch_id: w.s1.id, rows: [{ sku: `SUG-${tag}`, quantity: "10" }] });
    expect(missingCost.ok).toBe(false);
    const plan = await w.svc.imports.stock(w.owner, { branch_id: w.s1.id, rows: [{ "Code article": `SUG-${tag}`, Quantité: "10", "Coût unitaire": "700" }] });
    expect(plan.rows[0].warnings[0]).toMatch(/added to it/);
    const done = await w.svc.imports.stock(w.owner, { branch_id: w.s1.id, dry_run: false, rows: [{ sku: `SUG-${tag}`, quantity: "10", cost: "700" }] });
    expect(done.opening_stock?.total).toBe("7000");
    expect((await w.onHand(sugar.id)).onHand.toString()).toBe("50");
    await expect(w.svc.imports.stock(w.keeper, { branch_id: w.s1.id, rows: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("imports customers, updating existing ones matched by phone", async () => {
    await w.svc.customers.create(w.owner, { name: "Old Name", phone: "+237 690 11 22 33" });
    const rows = [
      { Nom: "New Name", Téléphone: "690112233", Adresse: "Akwa" },
      { Nom: "Marie Ngo", Téléphone: "699 00 00 01", "Plafond de crédit": "50 000", Délai: "30" },
      { Nom: "", Téléphone: "" },
    ];
    const done = await w.svc.imports.customers(w.owner, { rows, dry_run: false });
    expect(done.updated).toBe(1);
    expect(done.created).toBe(1);
    expect(done.skipped).toBe(1);
    const marie = await w.db.customer.findFirstOrThrow({ where: { business_id: w.B, name: "Marie Ngo" } });
    expect(marie.credit_limit.toString()).toBe("50000");
    expect(marie.credit_status).toBe("ACTIVE");
    expect(marie.code).toMatch(/^C-/);
    expect(await w.db.customer.count({ where: { business_id: w.B, name: "Old Name" } })).toBe(0);
    expect((await w.db.customer.findFirstOrThrow({ where: { business_id: w.B, name: "New Name" } })).address).toBe("Akwa");
  });
});
