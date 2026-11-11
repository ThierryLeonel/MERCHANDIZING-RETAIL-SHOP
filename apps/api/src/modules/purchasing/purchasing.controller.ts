import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { notFound } from "../../common/errors";
import { Idempotent } from "../../common/idempotency";
import { PageQuery } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { IsDecimalValue } from "../../common/validators";
import { PurchasingService } from "./purchasing.service";

class SupplierDto {
  @IsString() @MinLength(2) @MaxLength(24) code: string;
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() contact_name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() tax_id?: string;
  @IsOptional() @IsInt() @Min(0) payment_terms_days?: number;
}
class PoLineDto {
  @IsUUID() variant_id: string;
  @IsOptional() @IsUUID() unit_id?: string;
  @IsDecimalValue({ positive: true, maxDecimals: 3 }) quantity: string;
  @IsDecimalValue({ min: 0 }) unit_cost: string;
}
class PoDto {
  @IsUUID() branch_id: string;
  @IsUUID() supplier_id: string;
  @IsOptional() @IsDateString() order_date?: string;
  @IsOptional() @IsDateString() expected_date?: string;
  @IsOptional() @IsIn(["CASH", "CREDIT"]) payment_type?: "CASH" | "CREDIT";
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PoLineDto) lines: PoLineDto[];
}
class ReasonDto { @IsString() @MinLength(3) reason: string }
class OptionalReasonDto { @IsOptional() @IsString() reason?: string }
class ReceiptLineDto {
  @IsOptional() @IsUUID() purchase_order_line_id?: string;
  @IsUUID() variant_id: string;
  @IsOptional() @IsUUID() unit_id?: string;
  @IsDecimalValue({ min: 0, maxDecimals: 3 }) qty_accepted: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 3 }) qty_damaged?: string;
  @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 3 }) qty_rejected?: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) unit_cost?: string;
  @IsOptional() @IsString() batch_number?: string;
  @IsOptional() @IsDateString() expiry_date?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) serial_numbers?: string[];
}
class ReceiptDto {
  @IsUUID() branch_id: string;
  @IsOptional() @IsUUID() supplier_id?: string;
  @IsOptional() @IsUUID() purchase_order_id?: string;
  @IsOptional() @IsUUID() location_id?: string;
  @IsOptional() @IsString() supplier_reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReceiptLineDto) lines: ReceiptLineDto[];
}
class InvoiceLineDto {
  @IsOptional() @IsUUID() goods_receipt_line_id?: string;
  @IsOptional() @IsDecimalValue({ positive: true, maxDecimals: 3 }) quantity_base?: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) base_unit_cost?: string;
  @IsOptional() @IsUUID() tax_rate_id?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsDecimalValue({ positive: true }) amount?: string;
  @IsOptional() @IsUUID() expense_account_id?: string;
}
class InvoiceDto {
  @IsUUID() branch_id: string;
  @IsUUID() supplier_id: string;
  @IsString() @MinLength(1) supplier_invoice_no: string;
  @IsDateString() invoice_date: string;
  @IsOptional() @IsDateString() due_date?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceLineDto) lines: InvoiceLineDto[];
}
class AllocationDto { @IsUUID() supplier_invoice_id: string; @IsDecimalValue({ positive: true }) amount: string }
class SupplierPaymentDto {
  @IsUUID() branch_id: string;
  @IsUUID() supplier_id: string;
  @IsUUID() financial_account_id: string;
  @IsDecimalValue({ positive: true }) amount: string;
  @IsDateString() payment_date: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AllocationDto) allocations?: AllocationDto[];
}
class PoQuery extends PageQuery { @IsOptional() @IsString() status?: string; @IsOptional() @IsUUID() supplier_id?: string }
class SupplierDocQuery extends PageQuery { @IsOptional() @IsUUID() supplier_id?: string; @IsOptional() @IsIn(["true", "false"]) open?: string }

@ApiTags("purchasing")
@ApiBearerAuth()
@Controller()
export class PurchasingController {
  constructor(private svc: PurchasingService, private prisma: PrismaService, private audit: AuditService) {}

  @Get("suppliers") @RequirePermissions("suppliers.view")
  suppliers(@Auth() a: AuthContext, @Query() q: PageQuery) { return this.svc.listSuppliers(a, q); }

  @Post("suppliers") @RequirePermissions("suppliers.manage")
  async createSupplier(@Auth() a: AuthContext, @Body() dto: SupplierDto) {
    const s = await this.prisma.client.supplier.create({ data: { ...dto, code: dto.code.toUpperCase(), business_id: a.businessId } });
    await this.audit.record(a, { action: "supplier.created", entityType: "supplier", entityId: s.id, summary: `Supplier ${s.name} created` });
    return s;
  }

  @Get("suppliers/:id") @RequirePermissions("suppliers.view")
  async supplier(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const s = await this.prisma.client.supplier.findFirst({ where: { id, business_id: a.businessId } });
    if (!s) throw notFound("Supplier");
    const balance = a.permissions.has("payables.manage") || a.permissions.has("reports.financial") ? await this.svc.supplierBalance(a, id) : null;
    return { ...s, balance };
  }

  @Patch("suppliers/:id") @RequirePermissions("suppliers.manage")
  async updateSupplier(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: Partial<SupplierDto>) {
    const s = await this.prisma.client.supplier.findFirst({ where: { id, business_id: a.businessId } });
    if (!s) throw notFound("Supplier");
    const { code: _ignored, ...rest } = dto;
    const u = await this.prisma.client.supplier.update({ where: { id }, data: rest });
    await this.audit.record(a, { action: "supplier.updated", entityType: "supplier", entityId: id, summary: `Supplier ${s.name} updated`, data: rest });
    return u;
  }

  @Get("purchase-orders") @RequirePermissions("purchasing.view")
  pos(@Auth() a: AuthContext, @Query() q: PoQuery) { return this.svc.listPOs(a, q); }

  @Post("purchase-orders") @RequirePermissions("purchasing.manage")
  createPO(@Auth() a: AuthContext, @Body() dto: PoDto) { return this.svc.createPO(a, dto); }

  @Get("purchase-orders/:id") @RequirePermissions("purchasing.view")
  po(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.getPO(a, id); }

  @Post("purchase-orders/:id/submit") @HttpCode(200) @RequirePermissions("purchasing.manage")
  submit(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: OptionalReasonDto) { return this.svc.submitPO(a, id, dto.reason); }

  @Post("purchase-orders/:id/cancel") @HttpCode(200) @RequirePermissions("purchasing.manage")
  cancel(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.cancelPO(a, id, dto.reason); }

  @Post("purchase-orders/:id/close") @HttpCode(200) @RequirePermissions("purchasing.manage")
  close(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.closePO(a, id, dto.reason); }

  @Get("goods-receipts") @RequirePermissions("purchasing.view")
  receipts(@Auth() a: AuthContext, @Query() q: SupplierDocQuery) { return this.svc.listReceipts(a, q); }

  @Post("goods-receipts") @Idempotent() @RequirePermissions("purchasing.receive")
  receive(@Auth() a: AuthContext, @Body() dto: ReceiptDto, @Headers("idempotency-key") key: string) { return this.svc.receive(a, dto, key); }

  @Get("supplier-invoices") @RequirePermissions("purchasing.view")
  invoices(@Auth() a: AuthContext, @Query() q: SupplierDocQuery) { return this.svc.listInvoices(a, q); }

  @Post("supplier-invoices") @Idempotent() @RequirePermissions("payables.manage")
  postInvoice(@Auth() a: AuthContext, @Body() dto: InvoiceDto) { return this.svc.postInvoice(a, dto); }

  @Post("supplier-payments") @Idempotent() @RequirePermissions("payables.manage")
  pay(@Auth() a: AuthContext, @Body() dto: SupplierPaymentDto) { return this.svc.paySupplier(a, dto); }
}
