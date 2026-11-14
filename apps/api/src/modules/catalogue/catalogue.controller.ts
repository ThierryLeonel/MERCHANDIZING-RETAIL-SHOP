import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from "class-validator";
import { assertBranch, Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { invalid, notFound } from "../../common/errors";
import { D } from "../../common/money";
import { PageQuery } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { IsDecimalValue } from "../../common/validators";
import { assertPriceFloor, CatalogueService } from "./catalogue.service";
import { PricingService } from "./pricing.service";

class BarcodeDto {
  @IsString() @MinLength(3) @MaxLength(64) code: string;
  @IsOptional() @IsUUID() unit_id?: string;
  @IsOptional() @IsDecimalValue({ positive: true }) quantity?: string;
}
class ConversionDto {
  @IsUUID() unit_id: string;
  @IsDecimalValue({ positive: true, maxDecimals: 3 }) factor: string;
  @IsOptional() @IsBoolean() is_purchase_default?: boolean;
  @IsOptional() @IsBoolean() is_sellable?: boolean;
}
class VariantDto {
  @IsString() @MinLength(2) @MaxLength(48) sku: string;
  @IsString() @MinLength(1) name: string;
  @IsDecimalValue({ min: 0, maxDecimals: 2 }) retail_price: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 2 }) wholesale_price?: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 2 }) min_price?: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 3 }) reorder_point?: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 3 }) reorder_qty?: string;
  @IsOptional() @IsUUID() preferred_supplier_id?: string;
  @IsOptional() @IsBoolean() is_shortcut?: boolean;
  @IsOptional() @IsArray() @IsUUID("all", { each: true }) attribute_value_ids?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BarcodeDto) barcodes?: BarcodeDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ConversionDto) conversions?: ConversionDto[];
}
class CreateProductDto {
  @IsString() @MinLength(2) @MaxLength(32) code: string;
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() description?: string;
  @IsEnum(["STANDARD", "VARIANT", "PREPACKED_SET", "VIRTUAL_BUNDLE", "ASSEMBLED_KIT", "NON_STOCK", "BULK"]) product_type: any;
  @IsOptional() @IsBoolean() negotiable_price?: boolean;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsUUID() brand_id?: string;
  @IsUUID() base_unit_id: string;
  @IsOptional() @IsUUID() tax_rate_id?: string;
  @IsOptional() @IsBoolean() track_batches?: boolean;
  @IsOptional() @IsBoolean() track_expiry?: boolean;
  @IsOptional() @IsBoolean() track_serials?: boolean;
  @IsOptional() @IsInt() warranty_months?: number;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => VariantDto) variants: VariantDto[];
}
class UpdateProductDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsUUID() brand_id?: string;
  @IsOptional() @IsUUID() tax_rate_id?: string;
  @IsOptional() @IsBoolean() negotiable_price?: boolean;
  @IsOptional() @IsIn(["ACTIVE", "DISCONTINUED"]) status?: "ACTIVE" | "DISCONTINUED";
}
class UpdateVariantDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 2 }) retail_price?: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 2 }) wholesale_price?: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 2 }) min_price?: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) reorder_point?: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) reorder_qty?: string;
  @IsOptional() @IsUUID() preferred_supplier_id?: string;
  @IsOptional() @IsBoolean() is_shortcut?: boolean;
  @IsOptional() @IsIn(["ACTIVE", "DISCONTINUED"]) status?: "ACTIVE" | "DISCONTINUED";
}
class ProductQuery extends PageQuery {
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsIn(["ACTIVE", "DISCONTINUED"]) status?: string;
}
class SellableQuery {
  @IsUUID() branch_id: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(["true", "false"]) shortcuts?: string;
  @IsOptional() @IsUUID() category_id?: string;
}
class RefDto {
  @IsOptional() @IsString() @MaxLength(32) code?: string;
  @IsString() @MinLength(1) name: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsUUID() parent_id?: string;
}
class UpdateRefDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  /** Categories only. null clears the value. */
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsUUID() parent_id?: string | null;
}
class PriceListItemDto {
  @IsUUID() variant_id: string;
  @IsDecimalValue({ min: 0, maxDecimals: 2 }) price: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 2 }) min_price?: string;
  @IsString() effective_from: string;
  @IsOptional() @IsString() effective_to?: string;
}
class PriceQuoteQuery {
  @IsUUID() branch_id: string;
  @IsUUID() variant_id: string;
  @IsOptional() @IsIn(["RETAIL", "WHOLESALE"]) kind?: "RETAIL" | "WHOLESALE";
  @IsOptional() @IsString() at?: string;
}

@ApiTags("catalogue")
@ApiBearerAuth()
@Controller()
export class CatalogueController {
  constructor(private svc: CatalogueService, private prisma: PrismaService, private pricing: PricingService, private audit: AuditService) {}

  @Get("products") @RequirePermissions("products.view")
  list(@Auth() a: AuthContext, @Query() q: ProductQuery) { return this.svc.listProducts(a, q); }

  @Post("products") @RequirePermissions("products.manage")
  create(@Auth() a: AuthContext, @Body() dto: CreateProductDto) {
    if (!a.permissions.has("prices.manage") && (dto.variants.some((v) => v.min_price) || dto.negotiable_price)) throw invalid("FORBIDDEN_PRICE", "Setting minimum prices or bargaining requires prices.manage");
    return this.svc.createProduct(a, dto);
  }

  @Get("products/:id") @RequirePermissions("products.view")
  get(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.getProduct(a, id); }

  @Patch("products/:id") @RequirePermissions("products.manage")
  update(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) { return this.svc.updateProduct(a, id, dto); }

  @Post("products/:id/variants") @RequirePermissions("products.manage")
  async addVariant(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: VariantDto) {
    const p = await this.prisma.client.product.findFirst({ where: { id, business_id: a.businessId } });
    if (!p) throw notFound("Product");
    if (p.product_type !== "VARIANT") throw invalid("SINGLE_VARIANT", "Only VARIANT products can have additional SKUs");
    assertPriceFloor(p.negotiable_price, dto);
    await this.prisma.tx((t) => this.svc.createVariant(t, a, id, dto));
    return this.svc.getProduct(a, id);
  }

  @Patch("variants/:id") @RequirePermissions("products.manage")
  updateVariant(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateVariantDto) { return this.svc.updateVariant(a, id, dto); }

  @Get("catalogue/sellables") @RequirePermissions("products.view")
  sellables(@Auth() a: AuthContext, @Query() q: SellableQuery) {
    assertBranch(a, q.branch_id);
    return this.svc.sellables(a, { branchId: q.branch_id, search: q.search, shortcutsOnly: q.shortcuts === "true", categoryId: q.category_id });
  }

  @Get("catalogue/lookup") @RequirePermissions("products.view")
  lookup(@Auth() a: AuthContext, @Query("code") code: string, @Query("branch_id", ParseUUIDPipe) branchId: string) {
    assertBranch(a, branchId);
    return this.svc.lookup(a, code ?? "", branchId);
  }

  @Get("catalogue/price-quote") @RequirePermissions("products.view")
  async quote(@Auth() a: AuthContext, @Query() q: PriceQuoteQuery) {
    assertBranch(a, q.branch_id);
    const r = await this.pricing.resolve(this.prisma.client as any, { businessId: a.businessId, branchId: q.branch_id, variantId: q.variant_id, kind: q.kind ?? "RETAIL", at: q.at ? new Date(q.at) : undefined });
    return { unit_price: r.unitPrice, min_price: r.minPrice, source: r.source };
  }

  @Get("catalogue/serials") @RequirePermissions("products.view")
  async serials(@Auth() a: AuthContext, @Query("variant_id", ParseUUIDPipe) variantId: string, @Query("branch_id", ParseUUIDPipe) branchId: string) {
    assertBranch(a, branchId);
    const locs = await this.prisma.client.location.findMany({ where: { branch_id: branchId, is_sellable: true }, select: { id: true } });
    return this.prisma.client.serialNumber.findMany({ where: { business_id: a.businessId, variant_id: variantId, status: "IN_STOCK", location_id: { in: locs.map((l) => l.id) } }, select: { id: true, serial: true, location_id: true }, orderBy: { serial: "asc" }, take: 200 });
  }

  // ---------------------------------------------------------- reference data
  @Get("catalogue/reference") @RequirePermissions("products.view")
  async reference(@Auth() a: AuthContext) {
    const b = { business_id: a.businessId };
    const [departments, categories, brands, units, tax_rates, attributes, suppliers, price_lists] = await Promise.all([
      this.prisma.client.department.findMany({ where: b, orderBy: { name: "asc" } }),
      this.prisma.client.category.findMany({ where: b, orderBy: { name: "asc" } }),
      this.prisma.client.brand.findMany({ where: b, orderBy: { name: "asc" } }),
      this.prisma.client.unit.findMany({ where: b, orderBy: { code: "asc" } }),
      this.prisma.client.taxRate.findMany({ where: b, orderBy: { code: "asc" } }),
      this.prisma.client.attribute.findMany({ where: b, include: { values: { orderBy: { sort_order: "asc" } } } }),
      this.prisma.client.supplier.findMany({ where: { ...b, active: true }, select: { id: true, code: true, name: true }, orderBy: { name: "asc" } }),
      this.prisma.client.priceList.findMany({ where: b, orderBy: { code: "asc" } }),
    ]);
    return { departments, categories, brands, units, tax_rates, attributes, suppliers, price_lists };
  }

  /** Categories with parent, department and product counts (for the catalogue setup screen). */
  @Get("catalogue/categories") @RequirePermissions("products.view")
  async categories(@Auth() a: AuthContext) {
    const [cats, depts, counts] = await Promise.all([
      this.prisma.client.category.findMany({ where: { business_id: a.businessId }, orderBy: { name: "asc" } }),
      this.prisma.client.department.findMany({ where: { business_id: a.businessId } }),
      this.prisma.client.product.groupBy({ by: ["category_id"], where: { business_id: a.businessId }, _count: { _all: true } }),
    ]);
    return cats.map((c) => ({
      ...c,
      parent_name: cats.find((p) => p.id === c.parent_id)?.name ?? null,
      department_name: depts.find((d) => d.id === c.department_id)?.name ?? null,
      product_count: counts.find((x) => x.category_id === c.id)?._count._all ?? 0,
    }));
  }

  @Post("catalogue/:kind") @RequirePermissions("products.manage")
  async createRef(@Auth() a: AuthContext, @Param("kind") kind: string, @Body() dto: RefDto) {
    const name = dto.name.trim();
    if (!name) throw invalid("NAME_REQUIRED", "Enter a name");
    const b = a.businessId;
    const base = (dto.code ?? name).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, kind === "units" ? 16 : 24) || "X";
    // Pick a free code (CODE, CODE-2, CODE-3…) so two similar names never collide.
    const freeCode = async (exists: (code: string) => Promise<unknown>) => {
      for (let i = 1; i < 100; i++) {
        const code = i === 1 ? base : `${base.slice(0, (kind === "units" ? 16 : 24) - String(i).length - 1)}-${i}`;
        if (!(await exists(code))) return code;
      }
      throw invalid("CODE_EXHAUSTED", "Choose a different name");
    };
    const dup = () => invalid("DUPLICATE_NAME", `"${name}" already exists`);
    let row: { id: string };
    switch (kind) {
      case "departments": {
        if (await this.prisma.client.department.findFirst({ where: { business_id: b, name: { equals: name, mode: "insensitive" } } })) throw dup();
        const code = await freeCode((c) => this.prisma.client.department.findFirst({ where: { business_id: b, code: c } }));
        row = await this.prisma.client.department.create({ data: { business_id: b, code, name } }); break;
      }
      case "categories": {
        if (dto.parent_id && !(await this.prisma.client.category.findFirst({ where: { id: dto.parent_id, business_id: b } }))) throw notFound("Parent category");
        if (dto.department_id && !(await this.prisma.client.department.findFirst({ where: { id: dto.department_id, business_id: b } }))) throw notFound("Department");
        if (await this.prisma.client.category.findFirst({ where: { business_id: b, parent_id: dto.parent_id ?? null, name: { equals: name, mode: "insensitive" } } })) throw dup();
        const code = await freeCode((c) => this.prisma.client.category.findFirst({ where: { business_id: b, code: c } }));
        row = await this.prisma.client.category.create({ data: { business_id: b, code, name, department_id: dto.department_id ?? null, parent_id: dto.parent_id ?? null } }); break;
      }
      case "brands":
        if (await this.prisma.client.brand.findFirst({ where: { business_id: b, name: { equals: name, mode: "insensitive" } } })) throw dup();
        row = await this.prisma.client.brand.create({ data: { business_id: b, name } }); break;
      case "units": {
        if (await this.prisma.client.unit.findFirst({ where: { business_id: b, name: { equals: name, mode: "insensitive" } } })) throw dup();
        const code = dto.code ? base : await freeCode((c) => this.prisma.client.unit.findFirst({ where: { business_id: b, code: c } }));
        if (dto.code && (await this.prisma.client.unit.findFirst({ where: { business_id: b, code } }))) throw invalid("DUPLICATE_CODE", `Unit code ${code} already exists`);
        row = await this.prisma.client.unit.create({ data: { business_id: b, code, name } }); break;
      }
      default: throw notFound(`Reference type ${kind}`);
    }
    await this.audit.record(a, { action: `${kind}.created`, entityType: kind, entityId: row.id, summary: `${kind} "${name}" created` });
    return row;
  }

  @Patch("catalogue/:kind/:id") @RequirePermissions("products.manage")
  async updateRef(@Auth() a: AuthContext, @Param("kind") kind: string, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateRefDto) {
    const b = a.businessId;
    const name = dto.name?.trim();
    const dup = () => invalid("DUPLICATE_NAME", `"${name}" already exists`);
    let before: any;
    switch (kind) {
      case "categories": {
        before = await this.prisma.client.category.findFirst({ where: { id, business_id: b } });
        if (!before) throw notFound("Category");
        const parentId = dto.parent_id !== undefined ? dto.parent_id : before.parent_id;
        if (parentId) {
          if (!(await this.prisma.client.category.findFirst({ where: { id: parentId, business_id: b } }))) throw notFound("Parent category");
          // A category cannot be placed under itself or one of its own sub-categories.
          if ((await this.svc.categoryTree(b, id)).includes(parentId)) throw invalid("CATEGORY_CYCLE", "A category cannot be placed under itself or one of its sub-categories");
        }
        if (dto.department_id && !(await this.prisma.client.department.findFirst({ where: { id: dto.department_id, business_id: b } }))) throw notFound("Department");
        if (name && (await this.prisma.client.category.findFirst({ where: { business_id: b, parent_id: parentId ?? null, id: { not: id }, name: { equals: name, mode: "insensitive" } } }))) throw dup();
        await this.prisma.client.category.update({ where: { id }, data: { name, active: dto.active, parent_id: dto.parent_id !== undefined ? dto.parent_id : undefined, department_id: dto.department_id !== undefined ? dto.department_id : undefined } });
        break;
      }
      case "departments":
        before = await this.prisma.client.department.findFirst({ where: { id, business_id: b } });
        if (!before) throw notFound("Department");
        if (name && (await this.prisma.client.department.findFirst({ where: { business_id: b, id: { not: id }, name: { equals: name, mode: "insensitive" } } }))) throw dup();
        await this.prisma.client.department.update({ where: { id }, data: { name, active: dto.active } }); break;
      case "brands":
        before = await this.prisma.client.brand.findFirst({ where: { id, business_id: b } });
        if (!before) throw notFound("Brand");
        if (name && (await this.prisma.client.brand.findFirst({ where: { business_id: b, id: { not: id }, name: { equals: name, mode: "insensitive" } } }))) throw dup();
        await this.prisma.client.brand.update({ where: { id }, data: { name, active: dto.active } }); break;
      case "units":
        before = await this.prisma.client.unit.findFirst({ where: { id, business_id: b } });
        if (!before) throw notFound("Unit");
        if (dto.active !== undefined) throw invalid("UNIT_NO_STATUS", "Units cannot be deactivated; rename them instead");
        if (name && (await this.prisma.client.unit.findFirst({ where: { business_id: b, id: { not: id }, name: { equals: name, mode: "insensitive" } } }))) throw dup();
        await this.prisma.client.unit.update({ where: { id }, data: { name } }); break;
      default: throw notFound(`Reference type ${kind}`);
    }
    await this.audit.record(a, { action: `${kind}.updated`, entityType: kind, entityId: id, summary: `${kind} "${before.name}" updated`, data: { before: { name: before.name, active: before.active, parent_id: before.parent_id, department_id: before.department_id }, after: dto } });
    return { id };
  }

  // ------------------------------------------------------------- price lists
  @Get("price-lists/:id/items") @RequirePermissions("products.view")
  async priceItems(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const pl = await this.prisma.client.priceList.findFirst({ where: { id, business_id: a.businessId } });
    if (!pl) throw notFound("Price list");
    const items = await this.prisma.client.priceListItem.findMany({ where: { price_list_id: id }, orderBy: [{ variant_id: "asc" }, { effective_from: "desc" }], take: 500 });
    const variants = await this.prisma.client.productVariant.findMany({ where: { id: { in: items.map((i) => i.variant_id) } }, select: { id: true, sku: true, name: true } });
    return { price_list: pl, items: items.map((i) => ({ ...i, sku: variants.find((v) => v.id === i.variant_id)?.sku, variant_name: variants.find((v) => v.id === i.variant_id)?.name })) };
  }

  @Post("price-lists/:id/items") @RequirePermissions("prices.manage")
  async addPriceItem(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: PriceListItemDto) {
    const pl = await this.prisma.client.priceList.findFirst({ where: { id, business_id: a.businessId } });
    if (!pl) throw notFound("Price list");
    const from = new Date(dto.effective_from);
    const to = dto.effective_to ? new Date(dto.effective_to) : null;
    if (isNaN(from.getTime()) || (to && (isNaN(to.getTime()) || to <= from))) throw invalid("INVALID_DATES", "effective_to must be after effective_from");
    const item = await this.prisma.client.priceListItem.create({
      data: { price_list_id: id, variant_id: dto.variant_id, price: D(dto.price), min_price: dto.min_price ? D(dto.min_price) : null, effective_from: from, effective_to: to, created_by_id: a.userId },
    });
    await this.audit.record(a, { action: "price.scheduled", entityType: "price_list_item", entityId: item.id, summary: `Price ${dto.price} scheduled on ${pl.code}`, data: dto, branchId: pl.branch_id });
    return item;
  }
}
