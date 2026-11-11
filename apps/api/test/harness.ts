import "reflect-metadata";
import { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import type { AuthContext } from "../src/common/auth-context";
import { loadAuthContext } from "../src/common/guards";
import { D } from "../src/common/money";
import { PrismaService } from "../src/common/prisma.service";
import { AccountingService } from "../src/modules/accounting/accounting.service";
import { PostingService } from "../src/modules/accounting/posting.service";
import { ApprovalsService } from "../src/modules/approvals/approvals.service";
import { CatalogueService } from "../src/modules/catalogue/catalogue.service";
import { PricingService } from "../src/modules/catalogue/pricing.service";
import { CustomersService } from "../src/modules/customers/customers.service";
import { FinanceService } from "../src/modules/finance/finance.service";
import { InventoryService } from "../src/modules/inventory/inventory.service";
import { PurchasingService } from "../src/modules/purchasing/purchasing.service";
import { SalesService } from "../src/modules/sales/sales.service";
import { createBranchWithDefaults, createRegister, createUser, setupBusiness } from "../src/seed/business-setup";

let ctx: INestApplicationContext | null = null;
export async function appContext() {
  if (!ctx) ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
  return ctx;
}
export async function closeContext() {
  if (ctx) await ctx.close();
  ctx = null;
}

export const PASSWORD = "Test@123456";

/** An isolated business with two stores, registers, users and services. */
export async function makeWorld(opts: { pricesIncludeTax?: boolean } = {}) {
  const app = await appContext();
  const prisma = app.get(PrismaService);
  const db = prisma.client;
  const tag = randomUUID().slice(0, 8);
  const business = await setupBusiness(db, { name: `Test ${tag}`, isDemo: true });
  if (opts.pricesIncludeTax) await db.business.update({ where: { id: business.id }, data: { prices_include_tax: true } });
  const B = business.id;
  const { s1, s2 } = await db.$transaction(async (tx) => ({
    s1: await createBranchWithDefaults(tx, B, { code: "S1", name: "Store 1", kind: "STORE" }),
    s2: await createBranchWithDefaults(tx, B, { code: "S2", name: "Store 2", kind: "STORE" }),
  }));
  const regs = await db.$transaction(async (tx) => ({ r1: await createRegister(tx, B, s1.id, "R1", "Till 1"), r2: await createRegister(tx, B, s1.id, "R2", "Till 2"), r3: await createRegister(tx, B, s2.id, "R1", "Till 1") }));
  const mk = async (key: string, roles: string[], branchIds: string[], all = false) => {
    await db.$transaction((tx) => createUser(tx, B, { email: `${key}.${tag}@test.local`, name: key, password: PASSWORD, roles, branchIds, allBranches: all }));
    return actor(`${key}.${tag}@test.local`);
  };
  const actor = async (email: string): Promise<AuthContext> => {
    const u = await db.user.findFirstOrThrow({ where: { email } });
    const s = await db.userSession.create({ data: { user_id: u.id, refresh_token_hash: "test", expires_at: new Date(Date.now() + 3600_000) } });
    return loadAuthContext(prisma, u.id, s.id);
  };
  const owner = await mk("owner", ["OWNER"], [], true);
  const manager = await mk("manager", ["STORE_MANAGER"], [s1.id]);
  const cashier = await mk("cashier", ["CASHIER"], [s1.id]);
  const cashier2 = await mk("cashier2", ["CASHIER"], [s1.id]);
  const cashierS2 = await mk("cashiers2", ["CASHIER"], [s2.id]);
  const keeper = await mk("keeper", ["STOREKEEPER"], [s1.id, s2.id]);
  const accountant = await mk("accountant", ["ACCOUNTANT"], [], true);
  const units = Object.fromEntries((await db.unit.findMany({ where: { business_id: B } })).map((u) => [u.code, u.id]));
  const supplier = await db.supplier.create({ data: { business_id: B, code: "SUP", name: "Supplier" } });
  const svc = {
    catalogue: app.get(CatalogueService), purchasing: app.get(PurchasingService), inventory: app.get(InventoryService), sales: app.get(SalesService),
    finance: app.get(FinanceService), customers: app.get(CustomersService), accounting: app.get(AccountingService), approvals: app.get(ApprovalsService),
    pricing: app.get(PricingService), posting: app.get(PostingService),
  };
  const loc = async (branchId: string, code: string) => db.location.findFirstOrThrow({ where: { branch_id: branchId, code } });

  let skuSeq = 0;
  /** Creates a single-SKU product; returns the variant. */
  const product = async (p: { retail?: string; min?: string; type?: any; taxPercent?: string; batches?: boolean; serials?: boolean; carton?: string } = {}) => {
    let taxId: string | undefined;
    if (p.taxPercent) taxId = (await db.taxRate.create({ data: { business_id: B, code: `T${++skuSeq}`, name: "test tax", rate_percent: D(p.taxPercent) } })).id;
    const sku = `SKU-${tag}-${++skuSeq}`;
    const prod = await svc.catalogue.createProduct(owner, {
      code: `P-${sku}`, name: `Product ${sku}`, product_type: p.type ?? "STANDARD", base_unit_id: units.PCS, tax_rate_id: taxId, track_batches: p.batches, track_expiry: p.batches, track_serials: p.serials,
      variants: [{ sku, name: `Variant ${sku}`, retail_price: p.retail ?? "1000", min_price: p.min, conversions: p.carton ? [{ unit_id: units.CTN, factor: p.carton, is_purchase_default: true, is_sellable: true }] : undefined }],
    });
    return db.productVariant.findFirstOrThrow({ where: { product_id: prod.id } });
  };

  /** Raises, approves and fully receives a PO at the branch. */
  const stock = async (branchId: string, variantId: string, qty: string, unitCost: string, extra: { unit?: string; batch?: string; expiry?: string; serials?: string[] } = {}) => {
    const po = await svc.purchasing.createPO(owner, { branch_id: branchId, supplier_id: supplier.id, lines: [{ variant_id: variantId, unit_id: extra.unit ? units[extra.unit] : undefined, quantity: qty, unit_cost: unitCost }] });
    const sub = await svc.purchasing.submitPO(owner, po.id);
    if (sub!.status === "SUBMITTED") await svc.approvals.decide(accountantApprover, sub!.approval_request_id!, "APPROVE");
    const full = await svc.purchasing.getPO(owner, po.id);
    return svc.purchasing.receive(keeper, { branch_id: branchId, purchase_order_id: po.id, lines: full.lines.map((l) => ({ purchase_order_line_id: l.id, variant_id: l.variant_id, qty_accepted: l.quantity.toString(), batch_number: extra.batch, expiry_date: extra.expiry, serial_numbers: extra.serials })) });
  };
  const accountantApprover = manager; // manager holds approve.purchase for S1
  const openSessions: Record<string, string> = {};
  const session = async (who: AuthContext, registerId: string, float = "0") => {
    if (!openSessions[who.userId]) openSessions[who.userId] = (await svc.finance.openSession(who, { register_id: registerId, opening_float: float })).id;
    return openSessions[who.userId];
  };
  const cashSale = async (who: AuthContext, branchId: string, registerId: string, lines: any[], key?: string) => {
    await session(who, registerId);
    const q = await svc.sales.quote(who, { branch_id: branchId, register_id: registerId, lines });
    return svc.sales.checkout(who, { branch_id: branchId, register_id: registerId, lines, payments: [{ method: "CASH", amount: q.total.toString() }] }, key ?? randomUUID());
  };
  const glBalance = async (key: any) => {
    const id = await svc.posting.accountIdFor(db as any, B, key);
    const s = await db.journalLine.aggregate({ where: { account_id: id }, _sum: { debit: true, credit: true } });
    return D(s._sum.debit ?? 0).minus(D(s._sum.credit ?? 0));
  };
  const onHand = async (variantId: string, locationId?: string) => {
    const s = await db.stockBalance.aggregate({ where: { variant_id: variantId, ...(locationId ? { location_id: locationId } : {}) }, _sum: { qty_on_hand: true, qty_reserved: true } });
    return { onHand: D(s._sum.qty_on_hand ?? 0), reserved: D(s._sum.qty_reserved ?? 0) };
  };
  return { app, prisma, db, business, B, s1, s2, regs, owner, manager, cashier, cashier2, cashierS2, keeper, accountant, units, supplier, svc, loc, product, stock, session, cashSale, glBalance, onHand, actor };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;
