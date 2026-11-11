import { randomUUID } from "node:crypto";
import { D } from "../src/common/money";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(closeContext);

describe("packaging conversion", () => {
  it("buying 2 cartons of 24 increases stock by 48 base units and costs per piece", async () => {
    const v = await w.product({ carton: "24", retail: "1200" });
    const grn = await w.stock(w.s1.id, v.id, "2", "19200", { unit: "CTN" });
    expect(grn.lines[0].accepted_base.toString()).toBe("48");
    expect(grn.lines[0].base_unit_cost.toString()).toBe("800");
    expect((await w.onHand(v.id)).onHand.toString()).toBe("48");
    const pool = await w.db.inventoryCostPool.findFirstOrThrow({ where: { variant_id: v.id } });
    expect(pool.value.toString()).toBe("38400");
  });
  it("a carton barcode/unit sells 24 base units", async () => {
    const v = await w.product({ carton: "24", retail: "100" });
    await w.stock(w.s1.id, v.id, "1", "1200", { unit: "CTN" });
    const sale = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "1", unit_id: w.units.CTN }]);
    expect(sale.lines[0].quantity_base.toString()).toBe("24");
    expect(sale.total.toString()).toBe("2400");
    expect((await w.onHand(v.id)).onHand.toString()).toBe("0");
  });
});

describe("weighted-average costing", () => {
  it("averages receipts and issues at average; the last unit takes the exact residue", async () => {
    const v = await w.product({ retail: "500" });
    await w.stock(w.s1.id, v.id, "10", "100");
    await w.stock(w.s1.id, v.id, "10", "130");
    let pool = await w.db.inventoryCostPool.findFirstOrThrow({ where: { variant_id: v.id } });
    expect(pool.average_cost.toString()).toBe("115");
    const s = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "5" }]);
    expect(s.lines[0].cost_amount).toBeUndefined(); // cashiers never see cost
    const line1 = await w.db.saleLine.findFirstOrThrow({ where: { sale_id: s.id } });
    expect(line1.cost_amount.toString()).toBe("575");
    // three more receipts at awkward costs → rounding residue must still clear to exactly 0
    await w.stock(w.s1.id, v.id, "3", "33.333333");
    const remaining = (await w.onHand(v.id)).onHand.toString();
    const s2 = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: remaining }]);
    pool = await w.db.inventoryCostPool.findFirstOrThrow({ where: { variant_id: v.id } });
    expect(pool.quantity.toString()).toBe("0");
    expect(pool.value.toString()).toBe("0");
    const totalIn = D(1000 + 1300 + 100); // 3 × 33.333333 = 100 (rounded receipt value)
    const line2 = await w.db.saleLine.findFirstOrThrow({ where: { sale_id: s2.id } });
    expect(D(line1.cost_amount).plus(line2.cost_amount).toString()).toBe(totalIn.toString());
  });
  it("costing is per branch: a second branch keeps its own average", async () => {
    const v = await w.product();
    await w.stock(w.s1.id, v.id, "1", "100");
    await w.stock(w.s2.id, v.id, "1", "300");
    const pools = await w.db.inventoryCostPool.findMany({ where: { variant_id: v.id } });
    expect(pools.map((p) => p.average_cost.toString()).sort()).toEqual(["100", "300"]);
  });
});

describe("concurrency", () => {
  it("two cashiers cannot both sell the last available unit", async () => {
    const v = await w.product({ retail: "1000" });
    await w.stock(w.s1.id, v.id, "1", "500");
    await w.session(w.cashier, w.regs.r1.id);
    await w.session(w.cashier2, w.regs.r2.id);
    const attempt = (who: any, reg: string) => w.svc.sales.checkout(who, { branch_id: w.s1.id, register_id: reg, lines: [{ variant_id: v.id, quantity: "1" }], payments: [{ method: "CASH", amount: "1000" }] }, randomUUID());
    const results = await Promise.allSettled([attempt(w.cashier, w.regs.r1.id), attempt(w.cashier2, w.regs.r2.id)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.code).toBe("INSUFFICIENT_STOCK");
    expect((await w.onHand(v.id)).onHand.toString()).toBe("0");
  });
  it("prevents negative stock at the database level even if a service bug bypassed checks", async () => {
    const v = await w.product();
    await w.stock(w.s1.id, v.id, "1", "10");
    await expect(w.db.$executeRaw`UPDATE stock_balances SET qty_on_hand = qty_on_hand - 5 WHERE variant_id = ${v.id}::uuid`).rejects.toThrow();
  });
});

describe("batches, expiry and quarantine", () => {
  it("picks first-expiry-first-out and never sells expired batches", async () => {
    const v = await w.product({ batches: true, retail: "100" });
    const today = new Date();
    const ymd = (d: number) => new Date(today.getTime() + d * 86400_000).toISOString().slice(0, 10);
    await w.stock(w.s1.id, v.id, "2", "50", { batch: "LATE", expiry: ymd(200) });
    await w.stock(w.s1.id, v.id, "2", "50", { batch: "SOON", expiry: ymd(10) });
    await w.stock(w.s1.id, v.id, "5", "50", { batch: "EXPIRED", expiry: ymd(-1) });
    const sale = await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "3" }]);
    const moves = await w.db.stockMovement.findMany({ where: { source_id: sale.id } });
    const batches = await w.db.batch.findMany({ where: { id: { in: moves.map((m) => m.batch_id!) } } });
    const byBatch = Object.fromEntries(moves.map((m) => [batches.find((b) => b.id === m.batch_id)!.batch_number, m.quantity.toString()]));
    expect(byBatch).toEqual({ SOON: "-2", LATE: "-1" });
    await expect(w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "2" }])).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });
  it("quarantined stock is not available for sale", async () => {
    const v = await w.product({ retail: "100" });
    await w.stock(w.s1.id, v.id, "2", "40");
    const floor = await w.loc(w.s1.id, "FLOOR"), quar = await w.loc(w.s1.id, "QUAR");
    await w.svc.inventory.relocate(w.keeper, { branch_id: w.s1.id, variant_id: v.id, from_location_id: floor.id, to_location_id: quar.id, quantity: "2", reason: "Suspected tampering" });
    const [item] = await w.svc.catalogue.sellables(w.cashier, { branchId: w.s1.id, variantIds: [v.id] });
    expect(item.available).toBe("0.000");
    await expect(w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "1" }])).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  });
});

describe("serial-tracked items", () => {
  it("requires and consumes the named serial; a sold serial cannot be sold again", async () => {
    const v = await w.product({ serials: true, retail: "20000" });
    await w.stock(w.s1.id, v.id, "2", "12000", { serials: ["SN-A", "SN-B"] });
    const sn = await w.db.serialNumber.findFirstOrThrow({ where: { variant_id: v.id, serial: "SN-A" } });
    await expect(w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "1" }])).rejects.toMatchObject({ code: "SERIAL_REQUIRED" });
    await w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "1", serial_number_id: sn.id }]);
    expect((await w.db.serialNumber.findUniqueOrThrow({ where: { id: sn.id } })).status).toBe("SOLD");
    await expect(w.cashSale(w.cashier, w.s1.id, w.regs.r1.id, [{ variant_id: v.id, quantity: "1", serial_number_id: sn.id }])).rejects.toMatchObject({ code: "SERIAL_UNAVAILABLE" });
  });
});
