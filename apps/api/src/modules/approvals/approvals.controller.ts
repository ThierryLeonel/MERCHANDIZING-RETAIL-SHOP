import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { APPROVAL_TYPES } from "@retail/api-contracts";
import { IsEmail, IsIn, IsObject, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import { Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { notFound } from "../../common/errors";
import { PageQuery, pageArgs, paginate } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { IsDecimalValue } from "../../common/validators";
import { ApprovalsService } from "./approvals.service";

const REQUESTABLE = ["DISCOUNT", "PRICE_OVERRIDE", "REFUND", "STOCK_ADJUSTMENT", "CUSTOMER_CREDIT", "CASH_VARIANCE", "PAID_OUT"];
class RequestDto { @IsIn(REQUESTABLE) type: any; @IsString() @MinLength(3) reason: string; @IsOptional() @IsDecimalValue() amount?: string; @IsOptional() @IsUUID() branch_id?: string; @IsOptional() @IsObject() payload?: object; @IsOptional() @IsString() subject_type?: string; @IsOptional() @IsUUID() subject_id?: string }
class DecideDto { @IsIn(["APPROVE", "REJECT"]) decision: "APPROVE" | "REJECT"; @IsOptional() @IsString() note?: string }
class OverrideDto { @IsEmail() email: string; @IsString() password: string; @IsOptional() @IsString() note?: string }
class ApprovalQuery extends PageQuery { @IsOptional() @IsString() status?: string; @IsOptional() @IsString() request_type?: string; @IsOptional() @IsIn(["true", "false"]) mine?: string }

@ApiTags("approvals")
@ApiBearerAuth()
@Controller("approvals")
export class ApprovalsController {
  constructor(private svc: ApprovalsService, private prisma: PrismaService) {}

  @Get() @RequirePermissions("approvals.view")
  async list(@Auth() a: AuthContext, @Query() q: ApprovalQuery) {
    const where: any = { business_id: a.businessId, ...(q.status ? { status: q.status } : {}), ...(q.request_type ? { request_type: q.request_type } : {}), ...(q.mine === "true" ? { requested_by_id: a.userId } : {}), ...(a.allBranches ? {} : { OR: [{ branch_id: null }, { branch_id: { in: a.branchIds } }] }) };
    const page = await paginate(q, this.prisma.client.approvalRequest.count({ where }), this.prisma.client.approvalRequest.findMany({ where, ...pageArgs(q), orderBy: { created_at: "desc" }, include: { actions: { orderBy: { created_at: "asc" } } } }));
    const users = await this.prisma.client.user.findMany({ where: { id: { in: page.items.flatMap((r) => [r.requested_by_id, r.decided_by_id].filter(Boolean) as string[]) } }, select: { id: true, full_name: true } });
    const name = (id: string | null) => users.find((u) => u.id === id)?.full_name ?? null;
    return { ...page, items: page.items.map((r) => ({ ...r, requested_by_name: name(r.requested_by_id), decided_by_name: name(r.decided_by_id), can_decide: a.permissions.has((APPROVAL_TYPES as any)[r.request_type]) && r.requested_by_id !== a.userId && r.status === "PENDING" })) };
  }

  /** Requests are raised by operational users (e.g. a cashier) — any authenticated user may request; deciding needs the type's permission. */
  @Post()
  request(@Auth() a: AuthContext, @Body() dto: RequestDto) { return this.svc.request(a, { type: dto.type, reason: dto.reason, amount: dto.amount, branchId: dto.branch_id, payload: dto.payload, subjectType: dto.subject_type, subjectId: dto.subject_id }); }

  @Get(":id")
  async get(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const r = await this.prisma.client.approvalRequest.findFirst({ where: { id, business_id: a.businessId }, include: { actions: true } });
    if (!r) throw notFound("Approval request");
    return r;
  }

  @Post(":id/decide") @HttpCode(200) @RequirePermissions("approvals.view")
  decide(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: DecideDto) { return this.svc.decide(a, id, dto.decision, dto.note); }

  /** Supervisor override at the POS (approver re-authenticates; single use; rate limited). */
  @Post(":id/override") @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60_000 } })
  override(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: OverrideDto) { return this.svc.decideWithCredentials(a, id, dto.email, dto.password, dto.note); }
}
