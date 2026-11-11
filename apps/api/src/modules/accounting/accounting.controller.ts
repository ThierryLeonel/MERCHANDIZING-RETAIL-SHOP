import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MinLength, ValidateNested } from "class-validator";
import { Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { notFound } from "../../common/errors";
import { PageQuery } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { businessDate, SettingsService } from "../../common/settings.service";
import { IsDecimalValue } from "../../common/validators";
import { AccountingService } from "./accounting.service";
import { POSTING_KEYS } from "./posting.service";

class JournalLineDto { @IsUUID() account_id: string; @IsOptional() @IsDecimalValue({ min: 0 }) debit?: string; @IsOptional() @IsDecimalValue({ min: 0 }) credit?: string; @IsOptional() @IsString() memo?: string }
class ManualJournalDto { @IsDateString() entry_date: string; @IsString() @MinLength(5) description: string; @IsOptional() @IsUUID() branch_id?: string; @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => JournalLineDto) lines: JournalLineDto[] }
class ReasonDto { @IsString() @MinLength(3) reason: string }
class AccountDto { @IsString() code: string; @IsString() @MinLength(2) name: string; @IsIn(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]) type: any; @IsOptional() @IsString() subtype?: string; @IsOptional() @IsBoolean() allow_manual?: boolean }
class RuleDto { @IsUUID() account_id: string }
class JournalQuery extends PageQuery { @IsOptional() @IsString() source_type?: string; @IsOptional() @IsString() from?: string; @IsOptional() @IsString() to?: string; @IsOptional() @IsUUID() account_id?: string }
class DateQuery { @IsOptional() @IsDateString() as_of?: string }
class RangeQuery { @IsOptional() @IsDateString() from?: string; @IsOptional() @IsDateString() to?: string; @IsOptional() @IsUUID() branch_id?: string }

@ApiTags("accounting")
@ApiBearerAuth()
@Controller("accounting")
export class AccountingController {
  constructor(private svc: AccountingService, private prisma: PrismaService, private settings: SettingsService, private audit: AuditService) {}

  private async today(a: AuthContext) { const b = await this.settings.business(a.businessId); return businessDate(new Date(), b.timezone); }

  @Get("accounts") @RequirePermissions("accounting.view") chart(@Auth() a: AuthContext) { return this.svc.chart(a); }

  @Post("accounts") @RequirePermissions("accounting.periods")
  async createAccount(@Auth() a: AuthContext, @Body() dto: AccountDto) {
    const acc = await this.prisma.client.account.create({ data: { business_id: a.businessId, code: dto.code, name: dto.name, type: dto.type, subtype: dto.subtype ?? null, allow_manual: dto.allow_manual ?? true } });
    await this.audit.record(a, { action: "account.created", entityType: "account", entityId: acc.id, summary: `Account ${acc.code} ${acc.name} created` });
    return acc;
  }

  @Get("posting-rules") @RequirePermissions("accounting.view")
  async rules(@Auth() a: AuthContext) {
    const rules = await this.prisma.client.postingRule.findMany({ where: { business_id: a.businessId }, orderBy: { key: "asc" } });
    const accounts = await this.prisma.client.account.findMany({ where: { id: { in: rules.map((r) => r.account_id) } } });
    return { keys: POSTING_KEYS, rules: rules.map((r) => ({ ...r, account_code: accounts.find((x) => x.id === r.account_id)?.code, account_name: accounts.find((x) => x.id === r.account_id)?.name })) };
  }

  @Patch("posting-rules/:key") @RequirePermissions("accounting.periods")
  async updateRule(@Auth() a: AuthContext, @Param("key") key: string, @Body() dto: RuleDto) {
    const r = await this.prisma.client.postingRule.findUnique({ where: { business_id_key: { business_id: a.businessId, key } } });
    if (!r) throw notFound("Posting rule");
    const u = await this.prisma.client.postingRule.update({ where: { id: r.id }, data: { account_id: dto.account_id } });
    await this.audit.record(a, { action: "posting_rule.changed", entityType: "posting_rule", entityId: r.id, summary: `Posting rule ${key} remapped`, data: { from: r.account_id, to: dto.account_id } });
    return u;
  }

  @Get("journals") @RequirePermissions("accounting.view") journals(@Auth() a: AuthContext, @Query() q: JournalQuery) { return this.svc.listJournals(a, q); }
  @Get("journals/:id") @RequirePermissions("accounting.view") journal(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.getJournal(a, id); }
  @Post("journals/manual") @RequirePermissions("accounting.journal") manual(@Auth() a: AuthContext, @Body() dto: ManualJournalDto) { return this.svc.requestManualJournal(a, dto); }
  @Post("journals/:id/reverse") @HttpCode(200) @RequirePermissions("accounting.journal") reverse(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.reverseManual(a, id, dto.reason); }

  @Get("periods") @RequirePermissions("accounting.view") periods(@Auth() a: AuthContext) { return this.svc.periods(a); }
  @Post("periods/:id/close") @HttpCode(200) @RequirePermissions("accounting.periods") close(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) { return this.svc.closePeriod(a, id); }
  @Post("periods/:id/reopen-request") @RequirePermissions("accounting.periods") reopen(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: ReasonDto) { return this.svc.requestReopen(a, id, dto.reason); }

  @Get("trial-balance") @RequirePermissions("reports.financial")
  async tb(@Auth() a: AuthContext, @Query() q: DateQuery) { return this.svc.trialBalance(a, q.as_of ?? (await this.today(a))); }

  @Get("profit-and-loss") @RequirePermissions("reports.financial")
  async pl(@Auth() a: AuthContext, @Query() q: RangeQuery) { const t = await this.today(a); return this.svc.profitAndLoss(a, q.from ?? `${t.slice(0, 7)}-01`, q.to ?? t, q.branch_id); }

  @Get("balance-sheet") @RequirePermissions("reports.financial")
  async bs(@Auth() a: AuthContext, @Query() q: DateQuery) { return this.svc.balanceSheet(a, q.as_of ?? (await this.today(a))); }

  @Get("reconciliation") @RequirePermissions("reports.financial") recon(@Auth() a: AuthContext) { return this.svc.reconciliation(a); }
}
