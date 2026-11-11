import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, MinLength, ValidateNested } from "class-validator";
import { randomUUID } from "node:crypto";
import { Auth, AuthContext, Public, RequirePermissions } from "../../common/auth-context";
import { DomainError, notFound } from "../../common/errors";
import { Idempotent } from "../../common/idempotency";
import { PageQuery } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { IsDecimalValue } from "../../common/validators";
import { config } from "../../config";
import { SimulatorMobileMoneyAdapter } from "./payment-adapters";
import { SalesService } from "./sales.service";

const METHODS = ["CASH", "MOBILE_MONEY", "CARD", "BANK_TRANSFER", "CUSTOMER_CREDIT"];
class LineDto {
  @IsUUID() variant_id: string;
  @IsDecimalValue({ positive: true, maxDecimals: 3 }) quantity: string;
  @IsOptional() @IsUUID() unit_id?: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) discount_amount?: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) discount_percent?: string;
  @IsOptional() @IsString() discount_reason?: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) override_price?: string;
  @IsOptional() @IsUUID() approval_request_id?: string;
  @IsOptional() @IsUUID() serial_number_id?: string;
}
class PaymentDto {
  @IsIn(METHODS) method: any;
  @IsDecimalValue({ positive: true }) amount: string;
  @IsOptional() @IsDecimalValue({ positive: true }) amount_tendered?: string;
  @IsOptional() @IsUUID() financial_account_id?: string;
  @IsOptional() @IsString() payer_phone?: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsUUID() approval_request_id?: string;
}
class CheckoutDto {
  @IsUUID() branch_id: string;
  @IsUUID() register_id: string;
  @IsOptional() @IsUUID() customer_id?: string;
  @IsOptional() @IsIn(["RETAIL", "WHOLESALE"]) price_list_kind?: any;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => LineDto) lines: LineDto[];
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PaymentDto) payments: PaymentDto[];
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsUUID() exchange_return_id?: string;
}
class QuoteDto {
  @IsUUID() branch_id: string;
  @IsUUID() register_id: string;
  @IsOptional() @IsUUID() customer_id?: string;
  @IsOptional() @IsIn(["RETAIL", "WHOLESALE"]) price_list_kind?: any;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => LineDto) lines: LineDto[];
}
class ReturnLineDto {
  @IsUUID() sale_line_id: string;
  @IsDecimalValue({ positive: true, maxDecimals: 3 }) quantity: string;
  @IsIn(["SELLABLE", "QUARANTINED", "DAMAGED", "SUPPLIER_RETURN_PENDING", "NON_RESTOCKABLE"]) condition: any;
  @IsOptional() @IsString() inspection_notes?: string;
}
class ReturnDto {
  @IsUUID() sale_id: string;
  @IsOptional() @IsUUID() register_id?: string;
  @IsString() @MinLength(3) reason: string;
  @IsIn(METHODS) refund_method: any;
  @IsOptional() @IsUUID() financial_account_id?: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsUUID() approval_request_id?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReturnLineDto) lines: ReturnLineDto[];
}
class ConfirmDto { @IsString() @MinLength(3) reference: string }
class ReasonDto { @IsString() @MinLength(3) reason: string }
class HoldDto {
  @IsUUID() branch_id: string;
  @IsOptional() @IsUUID() register_id?: string;
  @IsString() @MinLength(1) label: string;
  @IsOptional() @IsUUID() customer_id?: string;
  @IsObject() payload: object;
}
class SalesQuery extends PageQuery {
  @IsOptional() @IsUUID() branch_id?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsUUID() customer_id?: string;
  @IsOptional() @IsUUID() session_id?: string;
}
class WebhookDto {
  @IsString() event_id: string;
  @IsString() request_reference: string;
  @IsIn(["SUCCESSFUL", "FAILED"]) status: "SUCCESSFUL" | "FAILED";
  @IsOptional() @IsString() external_reference?: string;
}

@ApiTags("sales")
@ApiBearerAuth()
@Controller()
export class SalesController {
  constructor(private svc: SalesService, private prisma: PrismaService, private sim: SimulatorMobileMoneyAdapter) {}

  @Post("sales/checkout") @Idempotent() @RequirePermissions("pos.sell")
  checkout(@Auth() a: AuthContext, @Body() dto: CheckoutDto, @Headers("idempotency-key") key: string) { return this.svc.checkout(a, dto, key); }

  @Post("sales/quote") @HttpCode(200) @RequirePermissions("pos.sell")
  quote(@Auth() a: AuthContext, @Body() dto: QuoteDto) { return this.svc.quote(a, dto); }

  @Get("sales") @RequirePermissions("pos.sell")
  list(@Auth() a: AuthContext, @Query() q: SalesQuery) { return this.svc.listSales(a, q); }

  @Get("sales/lookup/:number") @RequirePermissions("pos.sell")
  async byNumber(@Auth() a: AuthContext, @Param("number") number: string) {
    const s = await this.prisma.client.sale.findFirst({ where: { business_id: a.businessId, number: number.trim().toUpperCase() } });
    if (!s) throw notFound("Sale");
    return this.svc.getSale(a, s.id);
  }

  @Get("sales/:id") @RequirePermissions("pos.sell")
  get(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.getSale(a, id); }

  @Post("sales/:id/payments") @Idempotent() @RequirePermissions("pos.sell")
  addPayment(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: PaymentDto) { return this.svc.addPayment(a, id, dto); }

  @Post("sales/:id/cancel") @HttpCode(200) @RequirePermissions("pos.sell")
  cancel(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.cancelPending(a, id, dto.reason); }

  @Post("payments/:id/confirm") @HttpCode(200) @RequirePermissions("pos.confirm_payment")
  confirm(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ConfirmDto) { return this.svc.confirmPayment(a, id, dto.reference); }

  @Post("returns") @Idempotent() @RequirePermissions("pos.return")
  returnSale(@Auth() a: AuthContext, @Body() dto: ReturnDto, @Headers("idempotency-key") key: string) { return this.svc.returnSale(a, dto, key); }

  @Get("returns/:id") @RequirePermissions("pos.sell")
  async getReturn(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const r = await this.prisma.client.salesReturn.findFirst({ where: { id, business_id: a.businessId }, include: { lines: true } });
    if (!r) throw notFound("Return");
    return r;
  }

  @Get("held-carts") @RequirePermissions("pos.hold")
  held(@Auth() a: AuthContext, @Query("branch_id", ParseUUIDPipe) branchId: string) { return this.svc.listHeld(a, branchId); }

  @Post("held-carts") @RequirePermissions("pos.hold")
  hold(@Auth() a: AuthContext, @Body() dto: HoldDto) { return this.svc.holdCart(a, dto); }

  @Delete("held-carts/:id") @RequirePermissions("pos.hold")
  recall(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.recallHeld(a, id); }

  /** Provider webhook. Signature verified; duplicates ignored. */
  @Public()
  @Post("payments/webhooks/:provider")
  @HttpCode(200)
  async webhook(@Param("provider") provider: string, @Body() dto: WebhookDto, @Headers("x-signature") sig: string, @Req() req: any) {
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(dto);
    if (provider.toUpperCase() !== "SIMULATOR" || !this.sim.verifySignature(raw, sig)) throw new DomainError("SIGNATURE_INVALID", "Webhook signature invalid", 401);
    return this.svc.handleProviderEvent("SIMULATOR", dto, dto);
  }

  /** DEVELOPMENT SIMULATOR ONLY — emits a signed provider callback. Disabled unless MOBILE_MONEY_MODE=simulator. */
  @Post("payments/simulator/:requestReference/:outcome") @HttpCode(200) @RequirePermissions("pos.sell")
  async simulate(@Param("requestReference") ref: string, @Param("outcome") outcome: string, @Body() body: { event_id?: string }) {
    if (config.mobileMoneyMode !== "simulator" || config.isProduction) throw new DomainError("SIMULATOR_DISABLED", "The payment simulator is disabled", 403);
    const payload = { event_id: body?.event_id ?? randomUUID(), request_reference: ref, status: outcome === "approve" ? ("SUCCESSFUL" as const) : ("FAILED" as const), external_reference: `SIMTX-${ref.slice(-8)}` };
    const raw = JSON.stringify(payload);
    if (!this.sim.verifySignature(raw, this.sim.sign(raw))) throw new Error("simulator signing failed");
    return this.svc.handleProviderEvent("SIMULATOR", payload, payload);
  }
}
