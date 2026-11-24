import { Injectable, Logger } from "@nestjs/common";
import { assertBranch, AuthContext } from "../../common/auth-context";
import { invalid, notFound } from "../../common/errors";
import { D } from "../../common/money";
import { InventoryService } from "../inventory/inventory.service";
import { AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import { ensureDefaultRegister, ensureOrangeMoneyWallet } from "../../seed/business-setup";
import { BUILTIN_CATEGORIES, BUILTIN_ITEMS, BUILTIN_UNITS, BUILTIN_VERSION, builtinSku } from "../../seed/builtin-catalogue.data";
import { CatalogueService } from "./catalogue.service";

export interface BuiltinInstallResult { categories_created: number; units_created: number; created: number; skipped: number }

/**
 * Installs the shop's built-in catalogue (seed/builtin-catalogue.data.ts).
 * Idempotent: an item is skipped when its SKU, or a product with the same name, already exists,
 * so it never duplicates or overwrites what the shop has edited.
 */
@Injectable()
export class BuiltinCatalogueService {
  private readonly log = new Logger("BuiltinCatalogue");
  constructor(private prisma: PrismaService, private catalogue: CatalogueService, private audit: AuditService, private inventory: InventoryService) {}

  /** Built-in items with what exists now (for the Starting stock screen and the catalogue page). */
  quantities(): Map<string, number> {
    return new Map(BUILTIN_ITEMS.map(([no, cat, , , qty]) => [builtinSku(no, cat), qty]));
  }

  async status(businessId: string) {
    const skus = BUILTIN_ITEMS.map(([no, cat]) => builtinSku(no, cat));
    const present = await this.prisma.client.productVariant.count({ where: { business_id: businessId, sku: { in: skus } } });
    const b = await this.prisma.client.business.findUniqueOrThrow({ where: { id: businessId } });
    return { total: BUILTIN_ITEMS.length, categories: BUILTIN_CATEGORIES.length, present, missing: BUILTIN_ITEMS.length - present, installed_version: (b.settings as any)?.builtin_catalogue?.version ?? null };
  }

  async install(auth: AuthContext, reason: "startup" | "manual"): Promise<BuiltinInstallResult> {
    const db = this.prisma.client;
    const b = auth.businessId;
    const res: BuiltinInstallResult = { categories_created: 0, units_created: 0, created: 0, skipped: 0 };

    const unitIds = new Map<string, string>();
    for (const [code, name] of BUILTIN_UNITS) {
      let u = await db.unit.findFirst({ where: { business_id: b, code } });
      if (!u) { u = await db.unit.create({ data: { business_id: b, code, name } }); res.units_created++; }
      unitIds.set(code, u.id);
    }
    const tax = await db.taxRate.findFirst({ where: { business_id: b, code: "NONE" } });
    const existingNames = new Set((await db.productVariant.findMany({ where: { business_id: b }, select: { name: true } })).map((v) => v.name.trim().toLowerCase()));
    const existingSkus = new Set((await db.productVariant.findMany({ where: { business_id: b }, select: { sku: true } })).map((v) => v.sku));
    const existingCodes = new Set((await db.product.findMany({ where: { business_id: b }, select: { code: true } })).map((p) => p.code));

    for (let ci = 0; ci < BUILTIN_CATEGORIES.length; ci++) {
      const items = BUILTIN_ITEMS.filter(([, c]) => c === ci);
      const todo = items.filter(([no, , name]) => {
        const sku = builtinSku(no, ci);
        const skip = existingSkus.has(sku) || existingCodes.has(sku) || existingNames.has(name.toLowerCase());
        if (skip) res.skipped++;
        return !skip;
      });
      if (!todo.length) continue;
      // one transaction per category keeps each short; a re-run picks up where an interrupted one stopped
      await this.prisma.tx(async (tx) => {
        const name = BUILTIN_CATEGORIES[ci].name;
        let cat = await tx.category.findFirst({ where: { business_id: b, parent_id: null, name: { equals: name, mode: "insensitive" } } });
        if (!cat) {
          const base = BUILTIN_CATEGORIES[ci].prefix;
          let code = base;
          for (let i = 2; await tx.category.findFirst({ where: { business_id: b, code } }); i++) code = `${base}-${i}`;
          cat = await tx.category.create({ data: { business_id: b, code, name } });
          res.categories_created++;
        }
        for (const [no, , itemName, unit] of todo) {
          const sku = builtinSku(no, ci);
          await this.catalogue.createProduct(auth, {
            code: sku, name: itemName, product_type: "STANDARD", category_id: cat.id, base_unit_id: unitIds.get(unit)!, tax_rate_id: tax?.id ?? null,
            variants: [{ sku, name: itemName, retail_price: "0", reorder_point: "1" }],
          } as any, tx);
          existingNames.add(itemName.toLowerCase()); existingSkus.add(sku);
          res.created++;
        }
      }, { timeout: 120_000 });
    }

    const biz = await db.business.findUniqueOrThrow({ where: { id: b } });
    await db.business.update({ where: { id: b }, data: { settings: { ...((biz.settings as object) ?? {}), builtin_catalogue: { version: BUILTIN_VERSION, installed_at: new Date().toISOString() } } } });
    await this.audit.record(auth, {
      action: "catalogue.builtin_installed", entityType: "business", entityId: b,
      summary: `Built-in catalogue ${reason === "startup" ? "installed" : "missing items re-added"}: ${res.created} products added, ${res.skipped} already present`,
      data: { ...res, reason, version: BUILTIN_VERSION },
    });
    return res;
  }

  /**
   * At start-up, once per branch: every active shop branch of a real business that has no register
   * gets "Till 1". Branches that already got one are remembered, so a till the owner deletes is not recreated.
   */
  async ensureDefaultRegisters(where: { id?: string; is_demo?: boolean } = { is_demo: false }) {
    const businesses = await this.prisma.client.business.findMany({ where });
    for (const biz of businesses) {
      const done: string[] = (biz.settings as any)?.default_register_branches ?? [];
      const branches = await this.prisma.client.branch.findMany({ where: { business_id: biz.id, kind: "STORE", active: true, id: { notIn: done } } });
      if (!branches.length) continue;
      const owner = await this.prisma.client.user.findFirst({ where: { business_id: biz.id, status: "ACTIVE", roles: { some: { role: { code: "OWNER" } } } }, orderBy: { created_at: "asc" } });
      for (const br of branches) {
        await this.prisma.tx(async (tx) => {
          const reg = await ensureDefaultRegister(tx, biz.id, br.id);
          const fresh = await tx.business.findUniqueOrThrow({ where: { id: biz.id } });
          const st = (fresh.settings as any) ?? {};
          await tx.business.update({ where: { id: biz.id }, data: { settings: { ...st, default_register_branches: [...(st.default_register_branches ?? []), br.id] } } });
          if (reg && owner) {
            const auth: AuthContext = { userId: owner.id, sessionId: "system", businessId: biz.id, fullName: "System", email: owner.email, permissions: new Set(), roles: ["OWNER"], allBranches: true, branchIds: [], defaultBranchId: null };
            await this.audit.record(auth, { action: "register.created", entityType: "cash_register", entityId: reg.id, summary: `Register ${reg.code} “${reg.name}” created automatically at ${br.code} (the branch had none)`, branchId: br.id }, tx);
          }
          if (reg) this.log.log(`${biz.name}: register ${reg.code} “${reg.name}” created at ${br.code}`);
        });
      }
    }
  }

  /** At start-up: install once for every real (non-demo) business that has not had it yet. BUILTIN_CATALOGUE=off disables. */
  /** Once per real business: an Orange Money wallet to collect into (skipped if one exists; a deleted one is not recreated). */
  async ensureOrangeWallets(where: { id?: string; is_demo?: boolean } = { is_demo: false }) {
    for (const biz of await this.prisma.client.business.findMany({ where })) {
      if ((biz.settings as any)?.orange_wallet_checked) continue;
      await this.prisma.tx(async (tx) => {
        const fa = await ensureOrangeMoneyWallet(tx, biz.id);
        const fresh = await tx.business.findUniqueOrThrow({ where: { id: biz.id } });
        await tx.business.update({ where: { id: biz.id }, data: { settings: { ...((fresh.settings as object) ?? {}), orange_wallet_checked: true } } });
        if (fa) this.log.log(`${biz.name}: financial account ${fa.code} “${fa.name}” added`);
      });
    }
  }

  async installPending() {
    await this.ensureOrangeWallets().catch((e) => this.log.error(`Orange Money wallet: ${e?.message ?? e}`));
    await this.ensureDefaultRegisters().catch((e) => this.log.error(`Default registers: ${e?.message ?? e}`));
    if (process.env.BUILTIN_CATALOGUE === "off") return;
    const businesses = await this.prisma.client.business.findMany({ where: { is_demo: false } });
    for (const biz of businesses) {
      if ((biz.settings as any)?.builtin_catalogue?.version) continue;
      const owner = await this.prisma.client.user.findFirst({ where: { business_id: biz.id, status: "ACTIVE", roles: { some: { role: { code: "OWNER" } } } }, orderBy: { created_at: "asc" } });
      if (!owner) continue; // business not set up yet; next start-up will install
      const auth: AuthContext = { userId: owner.id, sessionId: "system", businessId: biz.id, fullName: "System", email: owner.email, permissions: new Set(["products.manage"]), roles: ["OWNER"], allBranches: true, branchIds: [], defaultBranchId: null };
      try {
        const r = await this.install(auth, "startup");
        this.log.log(`${biz.name}: built-in catalogue installed (${r.created} added, ${r.skipped} already present)`);
      } catch (e: any) {
        this.log.error(`${biz.name}: built-in catalogue install failed: ${e?.message ?? e}`);
      }
    }
  }

  // ------------------------------------------------------------ starting stock
  /**
   * Products not yet stocked at a branch (no stock movement there), with the built-in counted
   * quantity suggested while the product has no stock history anywhere.
   */
  async startingStock(auth: AuthContext, branchId: string) {
    assertBranch(auth, branchId);
    const rows = await this.prisma.client.$queryRaw<{ variant_id: string; sku: string; name: string; retail_price: string; min_price: string | null; category: string | null; category_active: boolean | null; unit: string; product_type: string; stocked_elsewhere: boolean }[]>`
      SELECT v.id AS variant_id, v.sku, v.name, v.retail_price::text AS retail_price, v.min_price::text AS min_price,
             c.name AS category, c.active AS category_active, u.code AS unit, p.product_type::text AS product_type,
             EXISTS (SELECT 1 FROM stock_movements m WHERE m.variant_id = v.id) AS stocked_elsewhere
        FROM product_variants v
        JOIN products p ON p.id = v.product_id
        JOIN units u ON u.id = p.base_unit_id
        LEFT JOIN categories c ON c.id = p.category_id
       WHERE v.business_id = ${auth.businessId}::uuid AND v.status = 'ACTIVE' AND p.status = 'ACTIVE'
         AND p.product_type::text <> 'NON_STOCK' AND NOT p.track_batches AND NOT p.track_serials
         AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.variant_id = v.id AND m.branch_id = ${branchId}::uuid)
       ORDER BY c.name NULLS LAST, v.name`;
    const q = this.quantities();
    return rows.map((r) => ({ ...r, suggested_qty: !r.stocked_elsewhere && q.has(r.sku) ? String(q.get(r.sku)) : null }));
  }

  /** Sets selling prices and posts the counted quantities as opening stock at the branch's default sellable location. */
  async saveStartingStock(auth: AuthContext, input: { branch_id: string; lines: { variant_id: string; quantity?: string | null; unit_cost?: string | null; retail_price?: string | null }[] }) {
    assertBranch(auth, input.branch_id);
    const loc = await this.prisma.client.location.findFirst({ where: { branch_id: input.branch_id, is_sellable: true, active: true }, orderBy: [{ is_default: "desc" }, { code: "asc" }] });
    if (!loc) throw notFound("Sellable location");
    const opening: { variant_id: string; quantity: string; unit_cost: string }[] = [];
    const prices: { variant_id: string; retail_price: string }[] = [];
    const errors: string[] = [];
    for (const l of input.lines) {
      const v = await this.prisma.client.productVariant.findFirst({ where: { id: l.variant_id, business_id: auth.businessId } });
      if (!v) throw notFound("Product");
      const qty = l.quantity != null && l.quantity !== "" ? D(l.quantity) : null;
      if (qty && qty.gt(0)) {
        if (l.unit_cost == null || l.unit_cost === "" || D(l.unit_cost).lt(0)) errors.push(`${v.name}: enter the buying price (it values the stock)`);
        else opening.push({ variant_id: v.id, quantity: qty.toString(), unit_cost: D(l.unit_cost).toString() });
      } else if (qty && qty.lt(0)) errors.push(`${v.name}: quantity cannot be negative`);
      if (l.retail_price != null && l.retail_price !== "") {
        if (D(l.retail_price).lt(0)) errors.push(`${v.name}: selling price cannot be negative`);
        else if (!D(l.retail_price).equals(v.retail_price)) prices.push({ variant_id: v.id, retail_price: D(l.retail_price).toString() });
      }
    }
    if (errors.length) throw invalid("STARTING_STOCK_INVALID", errors.slice(0, 5).join("; ") + (errors.length > 5 ? ` (and ${errors.length - 5} more)` : ""));
    if (!opening.length && !prices.length) throw invalid("NOTHING_TO_SAVE", "Enter a quantity with its buying price, or a selling price, for at least one product");
    // prices are checked (permission, minimum price) before any stock is posted
    if (prices.length && !auth.permissions.has("prices.manage")) throw invalid("FORBIDDEN_PRICE", "Setting selling prices requires prices.manage");
    const doc = opening.length ? await this.inventory.postOpening(auth, { branch_id: input.branch_id, location_id: loc.id, lines: opening }) : null;
    for (const p of prices) await this.catalogue.updateVariant(auth, p.variant_id, { retail_price: p.retail_price });
    return { opening_stock: doc ? { number: doc.number, lines: opening.length, total: String(doc.total) } : null, prices_set: prices.length, location: loc.code };
  }
}
