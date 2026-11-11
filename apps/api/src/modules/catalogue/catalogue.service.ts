import { Injectable } from "@nestjs/common";
import type { Prisma, ProductType, Tx } from "@retail/db";
import { AuthContext, can } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { invalid, notFound } from "../../common/errors";
import { D } from "../../common/money";
import { PageQuery, pageArgs, paginate, orderBy } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { PricingService } from "./pricing.service";

export interface VariantInput {
  sku: string;
  name: string;
  retail_price: string | number;
  wholesale_price?: string | number | null;
  min_price?: string | number | null;
  reorder_point?: string | number;
  reorder_qty?: string | number;
  preferred_supplier_id?: string | null;
  is_shortcut?: boolean;
  attribute_value_ids?: string[];
  barcodes?: { code: string; unit_id?: string | null; quantity?: string | number }[];
  conversions?: { unit_id: string; factor: string | number; is_purchase_default?: boolean; is_sellable?: boolean }[];
}
export interface ProductInput {
  code: string;
  name: string;
  description?: string | null;
  product_type: ProductType;
  department_id?: string | null;
  category_id?: string | null;
  brand_id?: string | null;
  base_unit_id: string;
  tax_rate_id?: string | null;
  track_batches?: boolean;
  track_expiry?: boolean;
  track_serials?: boolean;
  warranty_months?: number | null;
  variants: VariantInput[];
}

const SINGLE_VARIANT_TYPES: ProductType[] = ["STANDARD", "PREPACKED_SET", "NON_STOCK"];

@Injectable()
export class CatalogueService {
  constructor(private prisma: PrismaService, private audit: AuditService, private pricing: PricingService) {}

  async createProduct(auth: AuthContext, input: ProductInput, tx?: Tx) {
    if (input.product_type === "VIRTUAL_BUNDLE" || input.product_type === "ASSEMBLED_KIT") {
      throw invalid("NOT_YET_SUPPORTED", "Bundles and assembled kits are scheduled for Phase 3 and cannot be created yet");
    }
    if (!input.variants?.length) throw invalid("VARIANT_REQUIRED", "At least one variant (SKU) is required");
    if (SINGLE_VARIANT_TYPES.includes(input.product_type) && input.variants.length !== 1) {
      throw invalid("SINGLE_VARIANT", `${input.product_type} products have exactly one SKU; use type VARIANT for size/colour variants`);
    }
    if (input.product_type === "NON_STOCK" && (input.track_batches || input.track_serials)) {
      throw invalid("NON_STOCK_TRACKING", "Non-stock items cannot track batches or serials");
    }
    if (input.track_expiry && !input.track_batches) throw invalid("EXPIRY_NEEDS_BATCH", "Expiry tracking requires batch tracking");
    const run = async (t: Tx) => {
      const product = await t.product.create({
        data: {
          business_id: auth.businessId, code: input.code.trim().toUpperCase(), name: input.name.trim(), description: input.description ?? null,
          product_type: input.product_type, department_id: input.department_id ?? null, category_id: input.category_id ?? null,
          brand_id: input.brand_id ?? null, base_unit_id: input.base_unit_id, tax_rate_id: input.tax_rate_id ?? null,
          track_batches: !!input.track_batches, track_expiry: !!input.track_expiry, track_serials: !!input.track_serials,
          warranty_months: input.warranty_months ?? null,
        },
      });
      for (const v of input.variants) await this.createVariant(t, auth, product.id, v);
      await this.audit.record(auth, { action: "product.created", entityType: "product", entityId: product.id, summary: `Product ${product.code} ${product.name} created`, data: { variants: input.variants.map((v) => v.sku) } }, t);
      return product;
    };
    const product = await (tx ? run(tx) : this.prisma.tx(run));
    return tx ? product : this.getProduct(auth, product.id);
  }

  async createVariant(t: Tx, auth: AuthContext, productId: string, v: VariantInput) {
    const variant = await t.productVariant.create({
      data: {
        business_id: auth.businessId, product_id: productId, sku: v.sku.trim().toUpperCase(), name: v.name.trim(),
        retail_price: D(v.retail_price), wholesale_price: v.wholesale_price != null ? D(v.wholesale_price) : null,
        min_price: v.min_price != null ? D(v.min_price) : null, reorder_point: D(v.reorder_point ?? 0), reorder_qty: D(v.reorder_qty ?? 0),
        preferred_supplier_id: v.preferred_supplier_id ?? null, is_shortcut: !!v.is_shortcut,
      },
    });
    for (const avId of v.attribute_value_ids ?? []) {
      await t.variantAttributeValue.create({ data: { variant_id: variant.id, attribute_value_id: avId } });
    }
    for (const c of v.conversions ?? []) {
      if (!D(c.factor).gt(0)) throw invalid("INVALID_FACTOR", "Conversion factor must be positive");
      await t.variantUnitConversion.create({ data: { variant_id: variant.id, unit_id: c.unit_id, factor: D(c.factor), is_purchase_default: !!c.is_purchase_default, is_sellable: !!c.is_sellable } });
    }
    for (const b of v.barcodes ?? []) {
      let quantity = D(b.quantity ?? 1);
      if (b.unit_id) {
        const conv = (v.conversions ?? []).find((c) => c.unit_id === b.unit_id);
        if (conv) quantity = D(conv.factor);
      }
      await t.barcode.create({ data: { business_id: auth.businessId, variant_id: variant.id, code: b.code.trim(), unit_id: b.unit_id ?? null, quantity } });
    }
    return variant;
  }

  async listProducts(auth: AuthContext, q: PageQuery & { category_id?: string; status?: string; department_id?: string }) {
    const where: Prisma.ProductWhereInput = {
      business_id: auth.businessId,
      ...(q.category_id ? { category_id: q.category_id } : {}),
      ...(q.department_id ? { department_id: q.department_id } : {}),
      ...(q.status ? { status: q.status as any } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { code: { contains: q.search, mode: "insensitive" } }, { variants: { some: { OR: [{ sku: { contains: q.search, mode: "insensitive" } }, { barcodes: { some: { code: q.search } } }] } } }] }
        : {}),
    };
    const page = await paginate(q, this.prisma.client.product.count({ where }), this.prisma.client.product.findMany({
      where, ...pageArgs(q), orderBy: orderBy(q, ["name", "code", "created_at"], "name"),
      include: { variants: { select: { id: true, sku: true, name: true, retail_price: true, status: true } } },
    }));
    const refIds = (k: "category_id" | "brand_id" | "department_id") => [...new Set(page.items.map((p) => p[k]).filter(Boolean))] as string[];
    const [cats, brands, depts] = await Promise.all([
      this.prisma.client.category.findMany({ where: { id: { in: refIds("category_id") } } }),
      this.prisma.client.brand.findMany({ where: { id: { in: refIds("brand_id") } } }),
      this.prisma.client.department.findMany({ where: { id: { in: refIds("department_id") } } }),
    ]);
    return {
      ...page,
      items: page.items.map((p) => ({
        ...p,
        category_name: cats.find((c) => c.id === p.category_id)?.name ?? null,
        brand_name: brands.find((b) => b.id === p.brand_id)?.name ?? null,
        department_name: depts.find((d) => d.id === p.department_id)?.name ?? null,
      })),
    };
  }

  async getProduct(auth: AuthContext, id: string) {
    const p = await this.prisma.client.product.findFirst({
      where: { id, business_id: auth.businessId },
      include: { variants: { include: { barcodes: true, unit_conversions: true, attribute_values: { include: { attribute_value: { include: { attribute: true } } } } }, orderBy: { sku: "asc" } } },
    });
    if (!p) throw notFound("Product");
    const variantIds = p.variants.map((v) => v.id);
    const [balances, pools, units] = await Promise.all([
      this.prisma.client.stockBalance.groupBy({ by: ["variant_id", "branch_id"], where: { variant_id: { in: variantIds } }, _sum: { qty_on_hand: true, qty_reserved: true } }),
      can(auth, "products.view_cost") ? this.prisma.client.inventoryCostPool.findMany({ where: { variant_id: { in: variantIds } } }) : Promise.resolve([]),
      this.prisma.client.unit.findMany({ where: { business_id: auth.businessId } }),
    ]);
    const unitCode = (id: string | null) => units.find((u) => u.id === id)?.code ?? null;
    return {
      ...p,
      base_unit_code: unitCode(p.base_unit_id),
      can_view_cost: can(auth, "products.view_cost"),
      variants: p.variants.map((v) => ({
        ...v,
        unit_conversions: v.unit_conversions.map((c) => ({ ...c, unit_code: unitCode(c.unit_id) })),
        barcodes: v.barcodes.map((b) => ({ ...b, unit_code: unitCode(b.unit_id) })),
        attributes: v.attribute_values.map((a) => ({ attribute: a.attribute_value.attribute.name, value: a.attribute_value.value })),
        attribute_values: undefined,
        stock: balances.filter((b) => b.variant_id === v.id).map((b) => ({ branch_id: b.branch_id, on_hand: b._sum.qty_on_hand, reserved: b._sum.qty_reserved })),
        costs: pools.filter((c) => c.variant_id === v.id).map((c) => ({ branch_id: c.branch_id, average_cost: c.average_cost, quantity: c.quantity, value: c.value })),
      })),
    };
  }

  async updateProduct(auth: AuthContext, id: string, data: Partial<Pick<ProductInput, "name" | "description" | "category_id" | "brand_id" | "department_id" | "tax_rate_id">> & { status?: "ACTIVE" | "DISCONTINUED" }) {
    const p = await this.prisma.client.product.findFirst({ where: { id, business_id: auth.businessId } });
    if (!p) throw notFound("Product");
    await this.prisma.tx(async (t) => {
      await t.product.update({ where: { id }, data });
      if (data.status) await t.productVariant.updateMany({ where: { product_id: id }, data: { status: data.status } });
      await this.audit.record(auth, { action: "product.updated", entityType: "product", entityId: id, summary: `Product ${p.code} updated`, data }, t);
    });
    return this.getProduct(auth, id);
  }

  async updateVariant(auth: AuthContext, id: string, data: { name?: string; retail_price?: string; wholesale_price?: string | null; min_price?: string | null; reorder_point?: string; reorder_qty?: string; preferred_supplier_id?: string | null; is_shortcut?: boolean; status?: "ACTIVE" | "DISCONTINUED" }) {
    const v = await this.prisma.client.productVariant.findFirst({ where: { id, business_id: auth.businessId } });
    if (!v) throw notFound("Variant");
    const priceChange = data.retail_price !== undefined || data.wholesale_price !== undefined || data.min_price !== undefined;
    if (priceChange && !can(auth, "prices.manage")) throw invalid("FORBIDDEN_PRICE", "Changing prices requires prices.manage");
    return this.prisma.tx(async (t) => {
      const updated = await t.productVariant.update({
        where: { id },
        data: {
          ...data,
          retail_price: data.retail_price !== undefined ? D(data.retail_price) : undefined,
          wholesale_price: data.wholesale_price !== undefined ? (data.wholesale_price === null ? null : D(data.wholesale_price)) : undefined,
          min_price: data.min_price !== undefined ? (data.min_price === null ? null : D(data.min_price)) : undefined,
          reorder_point: data.reorder_point !== undefined ? D(data.reorder_point) : undefined,
          reorder_qty: data.reorder_qty !== undefined ? D(data.reorder_qty) : undefined,
        },
      });
      await this.audit.record(auth, { action: priceChange ? "variant.price_changed" : "variant.updated", entityType: "product_variant", entityId: id, summary: `SKU ${v.sku} updated`, data: { before: { retail_price: v.retail_price, min_price: v.min_price }, after: data } }, t);
      return updated;
    });
  }

  /** Barcode or SKU lookup for scanning. Returns the variant and the base quantity the code represents. */
  async lookup(auth: AuthContext, code: string, branchId: string) {
    const c = code.trim();
    const bc = await this.prisma.client.barcode.findUnique({ where: { business_id_code: { business_id: auth.businessId, code: c } } });
    const variant = bc
      ? await this.prisma.client.productVariant.findUnique({ where: { id: bc.variant_id } })
      : await this.prisma.client.productVariant.findUnique({ where: { business_id_sku: { business_id: auth.businessId, sku: c.toUpperCase() } } });
    if (!variant) throw notFound(`Product for code "${c}"`);
    const [item] = await this.sellables(auth, { branchId, variantIds: [variant.id] });
    if (!item) throw notFound(`Product for code "${c}"`);
    let unit: { unit_id: string | null; unit_code: string | null; factor: string } = { unit_id: null, unit_code: item.base_unit_code, factor: "1" };
    if (bc?.unit_id) {
      const u = await this.prisma.client.unit.findUnique({ where: { id: bc.unit_id } });
      unit = { unit_id: bc.unit_id, unit_code: u?.code ?? null, factor: bc.quantity.toString() };
    }
    return { ...item, scanned: { code: c, ...unit } };
  }

  /** Sellable variants with branch price and available quantity (cost hidden unless permitted). */
  async sellables(auth: AuthContext, opts: { branchId: string; search?: string; shortcutsOnly?: boolean; variantIds?: string[]; take?: number; categoryId?: string }) {
    const variants = await this.prisma.client.productVariant.findMany({
      where: {
        business_id: auth.businessId, status: "ACTIVE",
        ...(opts.variantIds ? { id: { in: opts.variantIds } } : {}),
        ...(opts.shortcutsOnly ? { is_shortcut: true } : {}),
        ...(opts.categoryId ? { product: { category_id: opts.categoryId } } : {}),
        ...(opts.search ? { OR: [{ name: { contains: opts.search, mode: "insensitive" } }, { sku: { contains: opts.search, mode: "insensitive" } }, { product: { name: { contains: opts.search, mode: "insensitive" } } }, { barcodes: { some: { code: opts.search } } }] } : {}),
      },
      include: { product: true, unit_conversions: true },
      take: opts.take ?? 40,
      orderBy: { name: "asc" },
    });
    if (!variants.length) return [];
    const ids = variants.map((v) => v.id);
    const avail = await this.prisma.client.$queryRaw<{ variant_id: string; available: string }[]>`
      SELECT sb.variant_id, SUM(sb.qty_on_hand - sb.qty_reserved)::text AS available FROM stock_balances sb
      JOIN locations l ON l.id = sb.location_id
      WHERE sb.branch_id = ${opts.branchId}::uuid AND l.is_sellable AND sb.variant_id = ANY(${ids}::uuid[])
      GROUP BY sb.variant_id`;
    const units = await this.prisma.client.unit.findMany({ where: { business_id: auth.businessId } });
    const taxRates = await this.prisma.client.taxRate.findMany({ where: { business_id: auth.businessId } });
    const out = [];
    for (const v of variants) {
      const price = await this.pricing.resolve(this.prisma.client as unknown as Tx, { businessId: auth.businessId, branchId: opts.branchId, variantId: v.id, kind: "RETAIL" });
      const tax = taxRates.find((t) => t.id === v.product.tax_rate_id);
      out.push({
        variant_id: v.id, product_id: v.product_id, sku: v.sku, name: v.name, product_name: v.product.name,
        product_type: v.product.product_type, track_serials: v.product.track_serials, track_batches: v.product.track_batches,
        base_unit_code: units.find((u) => u.id === v.product.base_unit_id)?.code ?? "PCS",
        unit_price: price.unitPrice.toString(), min_price: price.minPrice?.toString() ?? null, price_source: price.source,
        tax_percent: tax?.rate_percent.toString() ?? "0", tax_code: tax?.code ?? null,
        available: v.product.product_type === "NON_STOCK" ? null : (avail.find((a) => a.variant_id === v.id)?.available ?? "0"),
        image_attachment_id: v.product.image_attachment_id,
        sell_units: v.unit_conversions.filter((c) => c.is_sellable).map((c) => ({ unit_id: c.unit_id, unit_code: units.find((u) => u.id === c.unit_id)?.code, factor: c.factor.toString() })),
      });
    }
    return out;
  }
}
