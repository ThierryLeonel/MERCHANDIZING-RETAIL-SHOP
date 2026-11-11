import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, Min, MinLength, ValidateNested } from "class-validator";
import { assertBranch, Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { Idempotent } from "../../common/idempotency";
import { PageQuery } from "../../common/pagination";
import { IsDecimalValue } from "../../common/validators";
import { InventoryService } from "./inventory.service";

class BalanceQuery extends PageQuery {
  @IsUUID() branch_id: string;
  @IsOptional() @IsUUID() location_id?: string;
  @IsOptional() @IsIn(["true", "false"]) low_only?: string;
  @IsOptional() @IsUUID() category_id?: string;
}
class MovementQuery extends PageQuery {
  @IsOptional() @IsUUID() branch_id?: string;
  @IsOptional() @IsUUID() variant_id?: string;
  @IsOptional() @IsString() movement_type?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}
class OpeningLineDto { @IsUUID() variant_id: string; @IsDecimalValue({ positive: true, maxDecimals: 3 }) quantity: string; @IsDecimalValue({ min: 0 }) unit_cost: string; @IsOptional() @IsString() batch_number?: string; @IsOptional() @IsDateString() expiry_date?: string }
class OpeningDto { @IsUUID() branch_id: string; @IsUUID() location_id: string; @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OpeningLineDto) lines: OpeningLineDto[] }
class AdjLineDto { @IsUUID() variant_id: string; @IsUUID() location_id: string; @IsDecimalValue({ maxDecimals: 3 }) quantity: string; @IsOptional() @IsUUID() batch_id?: string; @IsOptional() @IsDecimalValue({ min: 0 }) unit_cost?: string }
class AdjustmentDto {
  @IsUUID() branch_id: string;
  @IsIn(["DAMAGE", "EXPIRY", "LOSS", "FOUND", "CORRECTION"]) reason_code: any;
  @IsString() @MinLength(3) reason: string;
  @IsOptional() @IsUUID() approval_request_id?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => AdjLineDto) lines: AdjLineDto[];
}
class RelocateDto { @IsUUID() branch_id: string; @IsUUID() variant_id: string; @IsUUID() from_location_id: string; @IsUUID() to_location_id: string; @IsDecimalValue({ positive: true }) quantity: string; @IsOptional() @IsUUID() batch_id?: string; @IsString() @MinLength(3) reason: string }
class TransferLineDto { @IsUUID() variant_id: string; @IsDecimalValue({ positive: true, maxDecimals: 3 }) quantity: string }
class TransferDto {
  @IsUUID() from_branch_id: string; @IsUUID() from_location_id: string; @IsUUID() to_branch_id: string; @IsUUID() to_location_id: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TransferLineDto) lines: TransferLineDto[];
}
class DispatchDto { @IsOptional() @IsObject() quantities?: Record<string, string> }
class ReceiveLineDto { @IsUUID() line_id: string; @IsDecimalValue({ min: 0, maxDecimals: 3 }) qty_received: string; @IsOptional() @IsDecimalValue({ min: 0, maxDecimals: 3 }) qty_short?: string; @IsOptional() @IsString() note?: string }
class ReceiveDto { @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiveLineDto) lines: ReceiveLineDto[]; @IsOptional() @IsBoolean() close?: boolean }
class StartCountDto { @IsUUID() branch_id: string; @IsUUID() location_id: string; @IsOptional() @IsArray() @IsUUID("all", { each: true }) variant_ids?: string[]; @IsOptional() @IsString() notes?: string }
class CountLineDto { @IsUUID() variant_id: string; @IsDecimalValue({ min: 0, maxDecimals: 3 }) counted_qty: string }
class RecordCountDto { @IsArray() @ValidateNested({ each: true }) @Type(() => CountLineDto) counts: CountLineDto[] }
class TransferQuery extends PageQuery { @IsOptional() @IsString() status?: string }
class ExpiryQuery { @IsUUID() branch_id: string; @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) days?: number }

@ApiTags("inventory")
@ApiBearerAuth()
@Controller("inventory")
export class InventoryController {
  constructor(private svc: InventoryService) {}

  @Get("locations") @RequirePermissions("inventory.view")
  locations(@Auth() a: AuthContext, @Query("branch_id") branchId?: string) { return this.svc.locations(a, branchId); }

  @Get("balances") @RequirePermissions("inventory.view")
  balances(@Auth() a: AuthContext, @Query() q: BalanceQuery) { return this.svc.balances(a, q); }

  @Get("movements") @RequirePermissions("inventory.view")
  movements(@Auth() a: AuthContext, @Query() q: MovementQuery) { return this.svc.movements(a, q); }

  @Get("reorder-suggestions") @RequirePermissions("inventory.view")
  reorder(@Auth() a: AuthContext, @Query("branch_id", ParseUUIDPipe) branchId: string) { assertBranch(a, branchId); return this.svc.reorderSuggestions(a, branchId); }

  @Get("expiring") @RequirePermissions("inventory.view")
  expiring(@Auth() a: AuthContext, @Query() q: ExpiryQuery) { return this.svc.expiring(a, q.branch_id, q.days ?? 60); }

  @Post("opening") @Idempotent() @RequirePermissions("inventory.opening")
  opening(@Auth() a: AuthContext, @Body() dto: OpeningDto) { return this.svc.postOpening(a, dto); }

  @Get("adjustments") @RequirePermissions("inventory.view")
  adjustments(@Auth() a: AuthContext, @Query() q: PageQuery) { return this.svc.listAdjustments(a, q); }

  @Post("adjustments") @Idempotent() @RequirePermissions("inventory.adjust")
  adjust(@Auth() a: AuthContext, @Body() dto: AdjustmentDto) { return this.svc.adjust(a, dto); }

  @Post("relocations") @Idempotent() @RequirePermissions("inventory.adjust")
  relocate(@Auth() a: AuthContext, @Body() dto: RelocateDto) { return this.svc.relocate(a, dto); }

  @Get("transfers") @RequirePermissions("inventory.view")
  transfers(@Auth() a: AuthContext, @Query() q: TransferQuery) { return this.svc.listTransfers(a, q); }

  @Post("transfers") @RequirePermissions("inventory.transfer")
  createTransfer(@Auth() a: AuthContext, @Body() dto: TransferDto) { return this.svc.createTransfer(a, dto); }

  @Post("transfers/:id/approve") @HttpCode(200) @RequirePermissions("inventory.transfer")
  approve(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.approveTransfer(a, id); }

  @Post("transfers/:id/dispatch") @HttpCode(200) @Idempotent() @RequirePermissions("inventory.transfer")
  dispatch(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: DispatchDto) { return this.svc.dispatchTransfer(a, id, dto.quantities); }

  @Post("transfers/:id/receive") @HttpCode(200) @Idempotent() @RequirePermissions("inventory.transfer")
  receive(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReceiveDto) { return this.svc.receiveTransfer(a, id, dto); }

  @Get("counts") @RequirePermissions("inventory.view")
  counts(@Auth() a: AuthContext, @Query() q: PageQuery) { return this.svc.listCounts(a, q); }

  @Get("counts/:id") @RequirePermissions("inventory.view")
  count(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.getCount(a, id); }

  @Post("counts") @RequirePermissions("inventory.count")
  startCount(@Auth() a: AuthContext, @Body() dto: StartCountDto) { return this.svc.startCount(a, dto); }

  @Post("counts/:id/lines") @HttpCode(200) @RequirePermissions("inventory.count")
  record(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: RecordCountDto) { return this.svc.recordCount(a, id, dto.counts); }

  @Post("counts/:id/submit") @HttpCode(200) @RequirePermissions("inventory.count")
  submit(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.submitCount(a, id); }

  @Post("counts/:id/post") @HttpCode(200) @Idempotent() @RequirePermissions("inventory.count")
  post(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.postCount(a, id); }
}
