import { Injectable } from "@nestjs/common";
import type { ProductType } from "@retail/db";
import { AuthContext, assertBranch, assertCan } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { invalid, notFound } from "../../common/errors";
import { D } from "../../common/money";
import { PrismaService } from "../../common/prisma.service";
import { SequenceService } from "../../common/sequence.service";
import { CatalogueService } from "../catalogue/catalogue.service";
import { InventoryService } from "../inventory/inventory.service";

/**
 * Spreadsheet imports (products, opening stock, customers).
 *
 * The browser parses the file (CSV or Excel) into rows of strings and posts
 * them here. Every import is validated in full first — `dry_run: true` returns
 * the per-row plan (create / update / errors / warnings) without saving. A real
 * import is refused if any row has an error, and then runs in one transaction,
 * so a file is either imported completely or not at all.
 */
export type Row = Record<string, string | number | boolean | null | undefined>;
export interface RowResult { row: number; action: "create" | "update" | "skip"; label: string; errors: string[]; warnings: string[] }
export interface ImportResult { dry_run: boolean; ok: boolean; created: number; updated: number; skipped: number; errors: number; rows: RowResult[]; opening_stock?: { number: string; lines: number; total: string } | null }

const MAX_ROWS = 5000;

/** Header aliases (English and French) → canonical field. Headers are matched without case, accents or punctuation. */
const ALIASES: Record<string, string[]> = {
  name: ["name", "product", "product_name", "nom", "produit", "designation", "libelle", "article", "customer", "client", "customer_name", "nom_client"],
  category: ["category", "categorie", "category_path", "famille", "rayon"],
  sku: ["sku", "code", "product_code", "reference", "ref", "code_article"],
  barcode: ["barcode", "code_barre", "code_barres", "ean", "gtin", "upc"],
  unit: ["unit", "unite", "uom", "unit_of_measure", "unite_de_mesure"],
  type: ["type", "product_type", "type_produit"],
  retail_price: ["retail_price", "price", "selling_price", "prix", "prix_de_vente", "prix_vente", "pv", "asking_price"],
  min_price: ["min_price", "minimum_price", "lowest_price", "prix_minimum", "prix_min", "prix_plancher"],
  wholesale_price: ["wholesale_price", "prix_de_gros", "prix_gros"],
  bargain: ["bargain", "negotiable", "negotiable_price", "marchandage", "negociable", "prix_negociable"],
  reorder_point: ["reorder_point", "reorder_level", "min_stock", "seuil", "seuil_reappro", "stock_minimum", "stock_min"],
  brand: ["brand", "marque"],
  description: ["description", "details"],
  quantity: ["quantity", "qty", "stock", "quantite", "qte", "opening_stock", "stock_initial", "on_hand"],
  unit_cost: ["unit_cost", "cost", "cost_price", "purchase_price", "cout", "cout_unitaire", "prix_achat", "prix_d_achat", "pa"],
  batch: ["batch", "batch_number", "lot", "numero_de_lot"],
  expiry: ["expiry", "expiry_date", "expiration", "date_expiration", "peremption", "date_de_peremption", "dlc"],
  phone: ["phone", "telephone", "tel", "mobile", "phone_number", "numero", "numero_de_telephone"],
  email: ["email", "e_mail", "mail", "courriel"],
  address: ["address", "adresse", "location", "quartier", "ville"],
  group: ["group", "customer_group", "groupe", "groupe_client"],
  credit_limit: ["credit_limit", "plafond", "plafond_credit", "plafond_de_credit", "limite_credit"],
  payment_terms_days: ["payment_terms_days", "payment_terms", "terms", "delai", "delai_de_paiement", "jours"],
};
const norm = (h: string) => h.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const FIELD_OF = new Map<string, string>(Object.entries(ALIASES).flatMap(([f, as]) => as.map((a) => [norm(a), f] as [string, string])));

/** Maps a raw row (any header spelling) to canonical fields with trimmed string values. */
export function canonical(row: Row): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const f = FIELD_OF.get(norm(k));
    if (!f || v == null) continue;
    const s = String(v).trim();
    if (s && !out[f]) out[f] = s;
  }
  return out;
}

/** Parses "1 500", "1,500", "1.500,50", "1500.5" etc. Returns null for blank, NaN for unreadable. */
export function parseNumber(s: string | undefined): number | null {
  if (s == null) return null;
  let t = s.replace(/[\s\u00a0\u202f]/g, "").replace(/(fcfa|xaf|cfa|f)$/i, "");
  if (!t) return null;
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (t.includes(",")) t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}
const yes = (s?: string) => !!s && /^(y|yes|oui|o|true|vrai|1|x)$/i.test(s.trim());
const no = (s?: string) => !!s && /^(n|no|non|false|faux|0)$/i.test(s.trim());
const codeFrom = (s: string, max: number) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, max) || "X";
/** Excel serial dates (e.g. 45678) or ISO / dd/mm/yyyy text → yyyy-mm-dd. */
function parseDate(s?: string): string | null | undefined {
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000).toISOString().slice(0, 10);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return undefined;
}
const digits = (s?: string | null) => (s ?? "").replace(/\D+/g, "").replace(/^(00)?237/, "");

function summarise(dry: boolean, rows: RowResult[], extra: Partial<ImportResult> = {}): ImportResult {
  const errors = rows.filter((r) => r.errors.length).length;
  return { dry_run: dry, ok: errors === 0, errors, created: rows.filter((r) => r.action === "create" && !r.errors.length).length, updated: rows.filter((r) => r.action === "update" && !r.errors.length).length, skipped: rows.filter((r) => r.action === "skip").length, rows, ...extra };
}

@Injectable()
export class ImportService {
  constructor(private prisma: PrismaService, private audit: AuditService, private seq: SequenceService, private catalogue: CatalogueService, private inventory: InventoryService) {}

  // ---------------------------------------------------------------- exports
  /** Current catalogue in the import template's columns — edit in a spreadsheet and import back (matched by SKU). */
  async exportProducts(auth: AuthContext) {
    const db = this.prisma.client, b = auth.businessId;
    const [variants, categories, barcodes, units, brands] = await Promise.all([
      db.productVariant.findMany({ where: { business_id: b, status: "ACTIVE", product: { status: "ACTIVE" } }, include: { product: true }, orderBy: { sku: "asc" } }),
      db.category.findMany({ where: { business_id: b } }),
      db.barcode.findMany({ where: { business_id: b, unit_id: null } }),
      db.unit.findMany({ where: { business_id: b } }),
      db.brand.findMany({ where: { business_id: b } }),
    ]);
    const path = (id: string | null): string => { const c = categories.find((x) => x.id === id); return c ? (c.parent_id ? `${path(c.parent_id)} > ${c.name}` : c.name) : ""; };
    return variants.map((v) => ({
      SKU: v.sku, Name: v.product.product_type === "VARIANT" ? v.name : v.product.name, Category: path(v.product.category_id), Brand: brands.find((x) => x.id === v.product.brand_id)?.name ?? "",
      Unit: units.find((u) => u.id === v.product.base_unit_id)?.code ?? "", Type: v.product.product_type === "BULK" ? "bulk" : v.product.product_type === "NON_STOCK" ? "service" : "standard",
      "Selling price": String(v.retail_price), "Minimum price": v.min_price != null ? String(v.min_price) : "", "Wholesale price": v.wholesale_price != null ? String(v.wholesale_price) : "",
      Bargain: v.product.negotiable_price ? "yes" : "no", Barcode: barcodes.find((x) => x.variant_id === v.id)?.code ?? "", "Reorder point": String(v.reorder_point),
    }));
  }

  async exportCustomers(auth: AuthContext) {
    const db = this.prisma.client;
    const [rows, groups] = await Promise.all([db.customer.findMany({ where: { business_id: auth.businessId }, orderBy: { name: "asc" } }), db.customerGroup.findMany({ where: { business_id: auth.businessId } })]);
    const credit = auth.permissions.has("customers.credit") || auth.permissions.has("customers.view");
    return rows.map((c) => ({
      Code: c.code, Name: c.name, Phone: c.phone ?? "", Email: c.email ?? "", Address: c.address ?? "", Group: groups.find((g) => g.id === c.customer_group_id)?.name ?? "",
      ...(credit ? { "Credit limit": String(c.credit_limit), "Payment terms (days)": String(c.payment_terms_days) } : {}), Active: c.active ? "yes" : "no",
    }));
  }

  // ---------------------------------------------------------------- products
  async products(auth: AuthContext, input: { rows: Row[]; dry_run?: boolean; branch_id?: string; location_id?: string }) {
    assertCan(auth, "data.import"); assertCan(auth, "products.manage");
    if (input.rows.length > MAX_ROWS) throw invalid("TOO_MANY_ROWS", `Import at most ${MAX_ROWS} rows at a time`);
    const dry = input.dry_run !== false;
    const b = auth.businessId, db = this.prisma.client;
    const canPrice = auth.permissions.has("prices.manage");
    if (input.branch_id) { assertBranch(auth, input.branch_id); assertCan(auth, "inventory.opening", "Importing opening stock requires inventory.opening"); }

    const [variants, products, categories, units, brands, barcodes] = await Promise.all([
      db.productVariant.findMany({ where: { business_id: b }, include: { product: true } }),
      db.product.findMany({ where: { business_id: b }, include: { variants: true } }),
      db.category.findMany({ where: { business_id: b } }),
      db.unit.findMany({ where: { business_id: b } }),
      db.brand.findMany({ where: { business_id: b } }),
      db.barcode.findMany({ where: { business_id: b } }),
    ]);
    const lc = (s: string) => s.trim().toLowerCase();
    const bySku = new Map(variants.map((v) => [lc(v.sku), v]));
    const byBarcode = new Map(barcodes.map((x) => [x.code, x]));
    const byName = new Map<string, typeof products>();
    for (const p of products) byName.set(lc(p.name), [...(byName.get(lc(p.name)) ?? []), p]);
    const unitFor = (s: string) => units.find((u) => lc(u.code) === lc(s) || lc(u.name) === lc(s));
    const pcs = units.find((u) => u.code === "PCS") ?? units[0];

    type Plan = { r: RowResult; c: Record<string, string>; existing?: (typeof variants)[number]; productType: ProductType; categoryPath: string[]; unitName?: string; retail: number; min: number | null; wholesale: number | null; reorder: number | null; bargain: boolean | null; qty: number | null; cost: number | null; batch?: string; expiry?: string | null; sku: string };
    const plans: Plan[] = [];
    const seenSku = new Set<string>(), seenBarcode = new Set<string>();
    input.rows.forEach((raw, i) => {
      const c = canonical(raw);
      const r: RowResult = { row: i + 2, action: "create", label: c.name ?? c.sku ?? "", errors: [], warnings: [] };
      if (!Object.keys(c).length) { r.action = "skip"; r.warnings.push("Empty row"); plans.push({ r, c } as Plan); return; }
      const existing = (c.sku && bySku.get(lc(c.sku))) || (c.barcode && byBarcode.get(c.barcode) && variants.find((v) => v.id === byBarcode.get(c.barcode!)!.variant_id)) ||
        (!c.sku && c.name && byName.get(lc(c.name))?.length === 1 && byName.get(lc(c.name))![0].variants.length === 1 ? variants.find((v) => v.id === byName.get(lc(c.name!))![0].variants[0].id) : undefined) || undefined;
      if (existing) { r.action = "update"; r.label = `${existing.sku} — ${c.name ?? existing.product.name}`; }
      if (!existing && !c.name) r.errors.push("Name is required for a new product");
      const typeRaw = lc(c.type ?? "");
      const productType: ProductType = !typeRaw ? (existing?.product.product_type ?? "STANDARD") : /^(bulk|vrac|loose|en_vrac|en vrac)/.test(typeRaw) ? "BULK" : /^(service|non.?stock)/.test(typeRaw) ? "NON_STOCK" : /^(standard|normal|article)?$/.test(typeRaw) ? "STANDARD" : (r.errors.push(`Unknown type "${c.type}" (use standard, bulk or service)`), "STANDARD");
      if (existing && c.type && productType !== existing.product.product_type) r.warnings.push("Type cannot be changed by import; kept as it is");
      const num = (f: string, label: string, opts: { min?: number; int?: boolean } = {}) => {
        const n = parseNumber(c[f]);
        if (n == null) return null;
        if (Number.isNaN(n)) { r.errors.push(`${label}: "${c[f]}" is not a number`); return null; }
        if (opts.min != null && n < opts.min) { r.errors.push(`${label} cannot be below ${opts.min}`); return null; }
        return n;
      };
      const retail = num("retail_price", "Selling price", { min: 0 });
      const min = num("min_price", "Minimum price", { min: 0 });
      const wholesale = num("wholesale_price", "Wholesale price", { min: 0 });
      const reorder = num("reorder_point", "Reorder point", { min: 0 });
      const qty = num("quantity", "Quantity", { min: 0 });
      const cost = num("unit_cost", "Unit cost", { min: 0 });
      const bargain = yes(c.bargain) ? true : no(c.bargain) ? false : c.bargain ? (r.errors.push(`Bargain: use yes or no, not "${c.bargain}"`), null) : null;
      if ((min != null || bargain != null) && !canPrice) r.errors.push("Setting minimum prices or bargaining requires the prices.manage permission");
      const effRetail = retail ?? (existing ? Number(existing.retail_price) : 0);
      const effMin = min ?? (existing?.min_price != null ? Number(existing.min_price) : null);
      const effBargain = bargain ?? existing?.product.negotiable_price ?? false;
      if (effMin != null && effMin > effRetail && effRetail > 0) r.errors.push("Minimum price is higher than the selling price");
      if (effBargain && !(effMin && effMin > 0)) r.errors.push("Bargaining needs a minimum price");
      if (!existing && !retail) r.warnings.push("No selling price — the product cannot be sold until a price is set");
      if (qty != null && qty > 0) {
        if (!input.branch_id) r.warnings.push("Quantity ignored — choose a branch to import opening stock");
        else if (productType === "NON_STOCK") r.errors.push("Services cannot have stock");
        else if (cost == null) r.errors.push("Unit cost is required with a quantity (it values the opening stock)");
      }
      const unitName = c.unit;
      if (existing && unitName && unitFor(unitName)?.id !== existing.product.base_unit_id) r.warnings.push("Unit cannot be changed by import; kept as it is");
      const sku = existing?.sku ?? (c.sku ? c.sku.toUpperCase().slice(0, 48) : codeFrom(c.name ?? "ITEM", 40));
      if (!existing) {
        if (seenSku.has(lc(sku))) r.errors.push(`SKU ${sku} appears twice in the file${c.sku ? "" : " (two products with the same name — give each a SKU)"}`);
        if (!c.sku && bySku.has(lc(sku))) r.errors.push(`A product with SKU ${sku} already exists under another name — give this row its own SKU`);
      }
      seenSku.add(lc(sku));
      if (c.barcode) {
        if (seenBarcode.has(c.barcode)) r.errors.push(`Barcode ${c.barcode} appears twice in the file`);
        const owner = byBarcode.get(c.barcode);
        if (owner && owner.variant_id !== existing?.id) r.errors.push(`Barcode ${c.barcode} already belongs to another product`);
        seenBarcode.add(c.barcode);
      }
      let expiry: string | null | undefined = null;
      if (c.expiry) { expiry = parseDate(c.expiry); if (expiry === undefined) r.errors.push(`Expiry "${c.expiry}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)`); }
      const target = existing?.product;
      if (target?.track_batches && qty && input.branch_id && !c.batch) r.errors.push("This product tracks batches — give a batch number for its stock");
      if (target?.track_serials && qty && input.branch_id) r.errors.push("Serial-numbered products cannot be imported with stock — receive them through purchasing");
      const categoryPath = (c.category ?? "").split(/\s*[>/›|]\s*/).map((x) => x.trim()).filter(Boolean);
      plans.push({ r, c, existing, productType, categoryPath, unitName, retail: retail ?? -1, min, wholesale, reorder, bargain, qty, cost, batch: c.batch, expiry, sku });
    });
    const rows = plans.map((p) => p.r);
    const opening = plans.filter((p) => p.r.action !== "skip" && p.qty && p.qty > 0 && input.branch_id);
    let location: { id: string } | null = null;
    if (opening.length && input.branch_id) {
      location = input.location_id
        ? await db.location.findFirst({ where: { id: input.location_id, branch_id: input.branch_id } })
        : await db.location.findFirst({ where: { branch_id: input.branch_id, kind: "SALES_FLOOR", active: true }, orderBy: { created_at: "asc" } });
      if (!location) throw notFound("Sellable location for the branch");
    }
    if (dry || rows.some((r) => r.errors.length)) return summarise(true, rows);

    // ------------------------------------------------------------ commit
    const variantIdOf = new Map<Plan, string>();
    await this.prisma.tx(async (tx) => {
      const catCache = new Map<string, string>();
      const catId = async (path: string[]): Promise<string | null> => {
        let parent: string | null = null;
        for (let d = 0; d < path.length; d++) {
          const key = path.slice(0, d + 1).map(lc).join(">");
          if (catCache.has(key)) { parent = catCache.get(key)!; continue; }
          const found = categories.find((x) => lc(x.name) === lc(path[d]) && (x.parent_id ?? null) === parent);
          let id: string;
          if (found) id = found.id;
          else {
            let code = codeFrom(path[d], 24);
            for (let n = 2; await tx.category.findFirst({ where: { business_id: b, code } }); n++) code = `${codeFrom(path[d], 20)}-${n}`;
            const made = await tx.category.create({ data: { business_id: b, code, name: path[d], parent_id: parent } });
            categories.push(made); id = made.id;
          }
          catCache.set(key, id); parent = id;
        }
        return parent;
      };
      const unitId = async (name?: string) => {
        if (!name) return pcs.id;
        const u = unitFor(name);
        if (u) return u.id;
        let code = codeFrom(name, 16);
        for (let n = 2; await tx.unit.findFirst({ where: { business_id: b, code } }); n++) code = `${codeFrom(name, 12)}-${n}`;
        const created = await tx.unit.create({ data: { business_id: b, code, name } });
        units.push(created);
        return created.id;
      };
      const brandId = async (name?: string) => {
        if (!name) return undefined;
        const found = brands.find((x) => lc(x.name) === lc(name));
        if (found) return found.id;
        const created = await tx.brand.create({ data: { business_id: b, name } });
        brands.push(created);
        return created.id;
      };
      let productNo = await tx.product.count({ where: { business_id: b } });
      for (const p of plans) {
        if (p.r.action === "skip") continue;
        const category_id = p.categoryPath.length ? await catId(p.categoryPath) : undefined;
        const brand_id = await brandId(p.c.brand);
        if (p.existing) {
          const v = p.existing;
          await tx.product.update({ where: { id: v.product_id }, data: { name: p.c.name ?? undefined, description: p.c.description ?? undefined, category_id, brand_id, negotiable_price: p.bargain ?? undefined } });
          const priceChange = (p.retail >= 0 && !D(v.retail_price).equals(p.retail)) || (p.min != null && !D(v.min_price ?? -1).equals(p.min)) || (p.wholesale != null && !D(v.wholesale_price ?? -1).equals(p.wholesale));
          await tx.productVariant.update({ where: { id: v.id }, data: {
            name: p.c.name && v.product.product_type !== "VARIANT" ? p.c.name : undefined,
            retail_price: p.retail >= 0 ? String(p.retail) : undefined, min_price: p.min != null ? String(p.min) : undefined,
            wholesale_price: p.wholesale != null ? String(p.wholesale) : undefined, reorder_point: p.reorder != null ? String(p.reorder) : undefined,
          } });
          if (p.c.barcode && !byBarcode.has(p.c.barcode)) await tx.barcode.create({ data: { business_id: b, variant_id: v.id, code: p.c.barcode } });
          if (priceChange) await this.audit.record(auth, { action: "variant.price_changed", entityType: "product_variant", entityId: v.id, summary: `${v.sku} prices updated by import`, data: { before: { retail: v.retail_price, min: v.min_price, wholesale: v.wholesale_price }, after: { retail: p.retail >= 0 ? p.retail : undefined, min: p.min, wholesale: p.wholesale } } }, tx);
          variantIdOf.set(p, v.id);
        } else {
          let code = `P-${p.sku}`.slice(0, 32);
          for (let n = 2; await tx.product.findFirst({ where: { business_id: b, code } }); n++) code = `P-${++productNo}`;
          const created = await this.catalogue.createProduct(auth, {
            code, name: p.c.name!, description: p.c.description ?? null, product_type: p.productType, category_id: category_id ?? null, brand_id: brand_id ?? null,
            base_unit_id: await unitId(p.unitName), negotiable_price: !!p.bargain,
            variants: [{ sku: p.sku, name: p.c.name!, retail_price: String(Math.max(p.retail, 0)), min_price: p.min != null ? String(p.min) : null, wholesale_price: p.wholesale != null ? String(p.wholesale) : null, reorder_point: p.reorder != null ? String(p.reorder) : undefined, barcodes: p.c.barcode ? [{ code: p.c.barcode }] : [] }],
          }, tx);
          variantIdOf.set(p, (await tx.productVariant.findFirstOrThrow({ where: { product_id: created.id } })).id);
        }
      }
      await this.audit.record(auth, { action: "import.products", entityType: "import", entityId: auth.userId, summary: `Product import: ${rows.filter((r) => r.action === "create").length} created, ${rows.filter((r) => r.action === "update").length} updated` }, tx);
    }, { timeout: 300_000 });

    let openingResult: ImportResult["opening_stock"] = null;
    if (opening.length && location) {
      const doc = await this.inventory.postOpening(auth, { branch_id: input.branch_id!, location_id: location.id, lines: opening.map((p) => ({ variant_id: variantIdOf.get(p)!, quantity: String(p.qty), unit_cost: String(p.cost), batch_number: p.batch, expiry_date: p.expiry ?? undefined })) });
      openingResult = { number: doc.number, lines: opening.length, total: String(doc.total) };
    }
    return summarise(false, rows, { opening_stock: openingResult });
  }

  // ---------------------------------------------------------------- opening stock
  async stock(auth: AuthContext, input: { rows: Row[]; dry_run?: boolean; branch_id: string; location_id?: string }) {
    assertCan(auth, "data.import"); assertCan(auth, "inventory.opening");
    assertBranch(auth, input.branch_id);
    if (input.rows.length > MAX_ROWS) throw invalid("TOO_MANY_ROWS", `Import at most ${MAX_ROWS} rows at a time`);
    const dry = input.dry_run !== false;
    const b = auth.businessId, db = this.prisma.client;
    const location = input.location_id
      ? await db.location.findFirst({ where: { id: input.location_id, branch_id: input.branch_id } })
      : await db.location.findFirst({ where: { branch_id: input.branch_id, kind: "SALES_FLOOR", active: true }, orderBy: { created_at: "asc" } });
    if (!location) throw notFound("Location");
    const [variants, barcodes, balances] = await Promise.all([
      db.productVariant.findMany({ where: { business_id: b }, include: { product: true } }),
      db.barcode.findMany({ where: { business_id: b } }),
      db.stockBalance.findMany({ where: { branch_id: input.branch_id } }),
    ]);
    const lc = (s: string) => s.trim().toLowerCase();
    const lines: { variant_id: string; quantity: string; unit_cost: string; batch_number?: string; expiry_date?: string }[] = [];
    const rows: RowResult[] = input.rows.map((raw, i) => {
      const c = canonical(raw);
      const r: RowResult = { row: i + 2, action: "create", label: c.sku ?? c.barcode ?? c.name ?? "", errors: [], warnings: [] };
      if (!Object.keys(c).length) { r.action = "skip"; return r; }
      const byName = c.name ? variants.filter((v) => lc(v.name) === lc(c.name!) || lc(v.product.name) === lc(c.name!)) : [];
      const v = (c.sku && variants.find((x) => lc(x.sku) === lc(c.sku!))) || (c.barcode && variants.find((x) => x.id === barcodes.find((bc) => bc.code === c.barcode)?.variant_id)) || (byName.length === 1 ? byName[0] : undefined);
      if (!v) { r.errors.push(byName.length > 1 ? `"${c.name}" matches several products — use the SKU` : "Product not found (give its SKU, barcode or exact name)"); return r; }
      r.label = `${v.sku} — ${v.name}`;
      const q = parseNumber(c.quantity), cost = parseNumber(c.unit_cost);
      if (q == null || Number.isNaN(q) || q <= 0) r.errors.push("Quantity must be a number above zero");
      if (cost == null || Number.isNaN(cost) || cost < 0) r.errors.push("Unit cost is required (zero or more)");
      if (v.product.product_type === "NON_STOCK") r.errors.push("Services have no stock");
      if (v.product.track_serials) r.errors.push("Serial-numbered products must be received through purchasing");
      if (v.product.track_batches && !c.batch) r.errors.push("This product tracks batches — give a batch number");
      let expiry: string | null | undefined = null;
      if (c.expiry) { expiry = parseDate(c.expiry); if (expiry === undefined) r.errors.push(`Expiry "${c.expiry}" is not a date`); }
      const onHand = balances.filter((x) => x.variant_id === v.id).reduce((s, x) => s.plus(x.qty_on_hand), D(0));
      if (onHand.gt(0)) r.warnings.push(`Already ${onHand} in stock at this branch — the quantity is added to it`);
      if (!r.errors.length) lines.push({ variant_id: v.id, quantity: String(q), unit_cost: String(cost), batch_number: c.batch, expiry_date: expiry ?? undefined });
      return r;
    });
    if (dry || rows.some((r) => r.errors.length) || !lines.length) return summarise(true, rows);
    const doc = await this.inventory.postOpening(auth, { branch_id: input.branch_id, location_id: location.id, lines });
    return summarise(false, rows, { opening_stock: { number: doc.number, lines: lines.length, total: String(doc.total) } });
  }

  // ---------------------------------------------------------------- customers
  async customers(auth: AuthContext, input: { rows: Row[]; dry_run?: boolean }) {
    assertCan(auth, "data.import"); assertCan(auth, "customers.manage");
    if (input.rows.length > MAX_ROWS) throw invalid("TOO_MANY_ROWS", `Import at most ${MAX_ROWS} rows at a time`);
    const dry = input.dry_run !== false;
    const b = auth.businessId, db = this.prisma.client;
    const canCredit = auth.permissions.has("customers.credit");
    const [customers, groups] = await Promise.all([db.customer.findMany({ where: { business_id: b } }), db.customerGroup.findMany({ where: { business_id: b } })]);
    const lc = (s: string) => s.trim().toLowerCase();
    const seenPhone = new Set<string>();
    const plans = input.rows.map((raw, i) => {
      const c = canonical(raw);
      const r: RowResult = { row: i + 2, action: "create", label: c.name ?? c.phone ?? "", errors: [], warnings: [] };
      if (!Object.keys(c).length) { r.action = "skip"; return { r, c }; }
      const ph = digits(c.phone);
      const existing = (ph && customers.find((x) => digits(x.phone) === ph)) || (c.name && !ph ? customers.find((x) => lc(x.name) === lc(c.name!)) : undefined) || undefined;
      if (existing) { r.action = "update"; r.label = `${existing.name}${existing.phone ? ` (${existing.phone})` : ""}`; }
      if (!existing && (!c.name || c.name.length < 2)) r.errors.push("Name is required");
      if (ph) { if (seenPhone.has(ph)) r.errors.push(`Phone ${c.phone} appears twice in the file`); seenPhone.add(ph); }
      if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) r.errors.push(`Email "${c.email}" is not valid`);
      const limit = parseNumber(c.credit_limit), terms = parseNumber(c.payment_terms_days);
      if (limit != null && (Number.isNaN(limit) || limit < 0)) r.errors.push("Credit limit must be a number, zero or more");
      if (terms != null && (Number.isNaN(terms) || terms < 0 || !Number.isInteger(terms))) r.errors.push("Payment terms must be a whole number of days");
      if (limit != null && !canCredit) r.errors.push("Setting credit limits requires the customers.credit permission");
      const group = c.group ? groups.find((g) => lc(g.name) === lc(c.group!)) : undefined;
      if (c.group && !group) r.errors.push(`Customer group "${c.group}" does not exist (${groups.map((g) => g.name).join(", ") || "none defined"})`);
      return { r, c, existing, limit, terms, group };
    });
    const rows = plans.map((p) => p.r);
    if (dry || rows.some((r) => r.errors.length)) return summarise(true, rows);
    await this.prisma.tx(async (tx) => {
      for (const p of plans) {
        if (p.r.action === "skip") continue;
        const data = {
          name: p.c.name ?? undefined, phone: p.c.phone ?? undefined, email: p.c.email ?? undefined, address: p.c.address ?? undefined,
          customer_group_id: p.group?.id ?? undefined, payment_terms_days: p.terms ?? undefined,
          ...(p.limit != null ? { credit_limit: String(p.limit), credit_status: p.limit > 0 ? ("ACTIVE" as const) : undefined } : {}),
        };
        if (p.existing) await tx.customer.update({ where: { id: p.existing.id }, data });
        else await tx.customer.create({ data: { business_id: b, code: await this.seq.next(tx, b, "CUSTOMER", "C-", 5), ...data, name: p.c.name! } });
      }
      await this.audit.record(auth, { action: "import.customers", entityType: "import", entityId: auth.userId, summary: `Customer import: ${rows.filter((r) => r.action === "create").length} created, ${rows.filter((r) => r.action === "update").length} updated` }, tx);
    }, { timeout: 120_000 });
    return summarise(false, rows);
  }
}
