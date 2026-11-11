import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength, ValidateNested } from "class-validator";
import { Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { Idempotent } from "../../common/idempotency";
import { PageQuery } from "../../common/pagination";
import { IsDecimalValue } from "../../common/validators";
import { CustomersService } from "./customers.service";

class CustomerDto {
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsUUID() customer_group_id?: string;
  @IsOptional() @IsDecimalValue({ min: 0 }) credit_limit?: string;
  @IsOptional() @IsInt() @Min(0) payment_terms_days?: number;
  @IsOptional() @IsIn(["NONE", "ACTIVE", "ON_HOLD"]) credit_status?: "NONE" | "ACTIVE" | "ON_HOLD";
}
class UpdateCustomerDto extends CustomerDto { @IsOptional() @IsString() @MinLength(2) declare name: string; @IsOptional() @IsBoolean() active?: boolean }
class AllocDto { @IsUUID() sale_id: string; @IsDecimalValue({ positive: true }) amount: string }
class CustomerPaymentDto {
  @IsUUID() branch_id: string; @IsUUID() financial_account_id: string; @IsDecimalValue({ positive: true }) amount: string; @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AllocDto) allocations?: AllocDto[];
}

@ApiTags("customers")
@ApiBearerAuth()
@Controller("customers")
export class CustomersController {
  constructor(private svc: CustomersService) {}
  @Get() @RequirePermissions("customers.view") list(@Auth() a: AuthContext, @Query() q: PageQuery) { return this.svc.list(a, q); }
  @Get("groups") @RequirePermissions("customers.view") groups(@Auth() a: AuthContext) { return this.svc.groups(a); }
  @Get("ageing") @RequirePermissions("customers.view") ageing(@Auth() a: AuthContext) { return this.svc.ageing(a); }
  @Post() @RequirePermissions("customers.manage") create(@Auth() a: AuthContext, @Body() dto: CustomerDto) { return this.svc.create(a, dto); }
  @Get(":id") @RequirePermissions("customers.view") get(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.get(a, id); }
  @Patch(":id") @RequirePermissions("customers.manage") update(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) { return this.svc.update(a, id, dto); }
  @Get(":id/statement") @RequirePermissions("customers.view") statement(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.statement(a, id); }
  @Post(":id/payments") @Idempotent() @RequirePermissions("customers.credit") pay(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: CustomerPaymentDto) { return this.svc.receivePayment(a, id, dto); }
}
