import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, IsDateString, IsOptional, IsString, IsUUID, MinLength, ValidateNested } from "class-validator";
import { Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { IsDecimalValue } from "../../common/validators";
import { OpeningBalanceService } from "./opening-balance.service";

class ObAccountDto { @IsUUID() financial_account_id: string; @IsDecimalValue() amount: string }
class ObCustomerDto {
  @IsUUID() customer_id: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) owed?: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) store_credit?: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsDateString() due_date?: string;
}
class ObSupplierDto { @IsUUID() supplier_id: string; @IsDecimalValue({ min: 0 }) owed: string; @IsOptional() @IsString() reference?: string; @IsOptional() @IsDateString() due_date?: string }
class ObOtherDto { @IsUUID() account_id: string; @IsOptional() @IsDecimalValue({ min: 0 }) debit?: string; @IsOptional() @IsDecimalValue({ min: 0 }) credit?: string; @IsOptional() @IsString() memo?: string }
class OpeningBalanceDto {
  @IsDateString() as_of_date: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ObAccountDto) accounts?: ObAccountDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ObCustomerDto) customers?: ObCustomerDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ObSupplierDto) suppliers?: ObSupplierDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ObOtherDto) other?: ObOtherDto[];
}
class ReasonDto { @IsString() @MinLength(3) reason: string }

/** Opening balances entered when the business starts using the system. */
@ApiTags("accounting") @ApiBearerAuth()
@Controller("opening-balances")
export class OpeningBalanceController {
  constructor(private svc: OpeningBalanceService) {}

  @Get("options") @RequirePermissions("accounting.opening_balances")
  options(@Auth() a: AuthContext) { return this.svc.options(a); }

  @Get(":id") @RequirePermissions("accounting.opening_balances")
  get(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.get(a, id); }

  @Post() @RequirePermissions("accounting.opening_balances")
  create(@Auth() a: AuthContext, @Body() dto: OpeningBalanceDto) { return this.svc.create(a, dto); }

  @Post(":id/void") @HttpCode(200) @RequirePermissions("accounting.opening_balances")
  void(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.void(a, id, dto.reason); }
}
