import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsObject, IsOptional, IsString, IsUUID, MinLength, ValidateNested } from "class-validator";
import { Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { Idempotent } from "../../common/idempotency";
import { PageQuery } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { IsDecimalValue } from "../../common/validators";
import { FinanceService } from "./finance.service";

class OpenDto { @IsUUID() register_id: string; @IsDecimalValue({ min: 0 }) opening_float: string; @IsOptional() @IsUUID() float_source_account_id?: string }
class MovementDto {
  @IsIn(["CASH_DROP", "PAID_OUT", "CASH_IN"]) kind: "CASH_DROP" | "PAID_OUT" | "CASH_IN";
  @IsDecimalValue({ positive: true }) amount: string;
  @IsOptional() @IsUUID() counter_account_id?: string;
  @IsOptional() @IsUUID() expense_account_id?: string;
  @IsString() @MinLength(3) reason: string;
  @IsOptional() @IsUUID() approval_request_id?: string;
}
class CloseDto {
  @IsDecimalValue({ min: 0 }) counted_cash: string;
  @IsOptional() @IsObject() denominations?: Record<string, number>;
  @IsOptional() @IsString() variance_reason?: string;
  @IsOptional() @IsUUID() approval_request_id?: string;
  @IsOptional() @IsUUID() transfer_to_account_id?: string;
}
class TransferDto {
  @IsUUID() from_account_id: string; @IsUUID() to_account_id: string;
  @IsDecimalValue({ positive: true }) amount: string; @IsOptional() @IsDecimalValue({ min: 0 }) fee_amount?: string;
  @IsDateString() transfer_date: string; @IsOptional() @IsString() reference?: string;
}
class ExpenseLineDto { @IsUUID() expense_category_id: string; @IsString() @MinLength(2) description: string; @IsDecimalValue({ positive: true }) amount: string }
class ExpenseDto {
  @IsUUID() branch_id: string; @IsDateString() expense_date: string; @IsString() @MinLength(2) payee: string;
  @IsUUID() financial_account_id: string; @IsOptional() @IsString() reference?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ExpenseLineDto) lines: ExpenseLineDto[];
}
class SessionQuery extends PageQuery { @IsOptional() @IsString() status?: string; @IsOptional() @IsUUID() branch_id?: string }

@ApiTags("finance")
@ApiBearerAuth()
@Controller()
export class FinanceController {
  constructor(private svc: FinanceService, private prisma: PrismaService) {}

  @Get("registers") @RequirePermissions("pos.sell")
  async registers(@Auth() a: AuthContext, @Query("branch_id") branchId?: string) {
    const regs = await this.prisma.client.cashRegister.findMany({ where: { business_id: a.businessId, active: true, ...(branchId ? { branch_id: branchId } : {}), ...(a.allBranches ? {} : { branch_id: { in: a.branchIds } }) }, orderBy: { code: "asc" } });
    const open = await this.prisma.client.cashierSession.findMany({ where: { register_id: { in: regs.map((r) => r.id) }, status: "OPEN" }, select: { register_id: true, user_id: true, number: true } });
    return regs.map((r) => ({ ...r, open_session: open.find((o) => o.register_id === r.id) ?? null }));
  }

  @Get("cashier-sessions/current") @RequirePermissions("sessions.open")
  current(@Auth() a: AuthContext) { return this.svc.currentSession(a); }

  @Get("cashier-sessions") @RequirePermissions("sessions.open")
  sessions(@Auth() a: AuthContext, @Query() q: SessionQuery) { return this.svc.listSessions(a, q); }

  @Get("cashier-sessions/:id") @RequirePermissions("sessions.open")
  session(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.getSession(a, id); }

  @Post("cashier-sessions") @Idempotent() @RequirePermissions("sessions.open")
  open(@Auth() a: AuthContext, @Body() dto: OpenDto) { return this.svc.openSession(a, dto); }

  @Post("cashier-sessions/:id/movements") @Idempotent() @RequirePermissions("sessions.open")
  movement(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: MovementDto) { return this.svc.cashMovement(a, id, dto); }

  @Post("cashier-sessions/:id/close") @HttpCode(200) @Idempotent() @RequirePermissions("sessions.close")
  close(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: CloseDto) { return this.svc.closeSession(a, id, dto); }

  @Get("financial-accounts") @RequirePermissions("finance.view")
  accounts(@Auth() a: AuthContext) { return this.svc.accountBalances(a); }

  @Get("financial-accounts/options") @RequirePermissions("pos.sell")
  async accountOptions(@Auth() a: AuthContext) {
    return this.prisma.client.financialAccount.findMany({ where: { business_id: a.businessId, active: true }, select: { id: true, code: true, name: true, kind: true, branch_id: true }, orderBy: { code: "asc" } });
  }

  @Post("funds-transfers") @Idempotent() @RequirePermissions("finance.manage")
  transfer(@Auth() a: AuthContext, @Body() dto: TransferDto) { return this.svc.transfer(a, dto); }

  @Get("expenses") @RequirePermissions("finance.view")
  expenses(@Auth() a: AuthContext, @Query() q: PageQuery) { return this.svc.listExpenses(a, q); }

  @Get("expense-categories") @RequirePermissions("expenses.manage")
  categories(@Auth() a: AuthContext) { return this.prisma.client.expenseCategory.findMany({ where: { business_id: a.businessId, active: true }, orderBy: { name: "asc" } }); }

  @Post("expenses") @Idempotent() @RequirePermissions("expenses.manage")
  expense(@Auth() a: AuthContext, @Body() dto: ExpenseDto) { return this.svc.createExpense(a, dto); }
}
