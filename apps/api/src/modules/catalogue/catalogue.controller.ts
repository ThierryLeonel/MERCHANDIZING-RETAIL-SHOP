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
import { CatalogueService } from "./catalogue.service";
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
  @IsEnum(["STANDARD", "VARIANT", "PREPACKED_SET", "VIRTUAL_BUNDLE", "ASSEMBLED_KIT", "NON_STOCK"]) product_type: any;
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
    if (!a.permissions.has("prices.manage") && dto.variants.some((v) => v.min_price)) throw invalid("FORBIDDEN_PRICE", "Setting minimum prices requires prices.manage");
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

  @Post("catalogue/:kind") @RequirePermissions("products.manage")
  async createRef(@Auth() a: AuthContext, @Param("kind") kind: string, @Body() dto: RefDto) {
    const code = (dto.code ?? dto.name).toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24);
    let row: { id: string };
    switch (kind) {
      case "departments": row = await this.prisma.client.department.create({ data: { business_id: a.businessId, code, name: dto.name } }); break;
      case "categories": row = await this.prisma.client.category.create({ data: { business_id: a.businessId, code, name: dto.name, department_id: dto.department_id ?? null, parent_id: dto.parent_id ?? null } }); break;
      case "brands": row = await this.prisma.client.brand.create({ data: { business_id: a.businessId, name: dto.name } }); break;
      case "units": row = await this.prisma.client.unit.create({ data: { business_id: a.businessId, code: code.slice(0, 16), name: dto.name } }); break;
      default: throw notFound(`Reference type ${kind}`);
    }
    await this.audit.record(a, { action: `${kind}.created`, entityType: kind, entityId: row.id, summary: `${kind} "${dto.name}" created` });
    return row;
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
