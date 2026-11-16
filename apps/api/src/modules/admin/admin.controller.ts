import { createGzip } from "node:zlib";
import type { Response } from "express";
import { MaintenanceService } from "./maintenance.service";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from "class-validator";
import { toCsv } from "../reports/reports.service";
import { PERMISSIONS } from "@retail/api-contracts";
import { Auth, AuthContext, assertCan, RequirePermissions } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { forbidden, invalid, notFound } from "../../common/errors";
import { D } from "../../common/money";
import { PageQuery, pageArgs, paginate } from "../../common/pagination";
import { PrismaService } from "../../common/prisma.service";
import { DEFAULT_POLICIES } from "../../common/settings.service";
import { IsDecimalValue } from "../../common/validators";
import { hashPassword, validatePasswordStrength } from "../auth/auth.service";
import { createBranchWithDefaults, createRegister } from "../../seed/business-setup";

class SettingsDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsString() legal_name?: string;
  @IsOptional() @IsString() tax_id?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() receipt_footer?: string;
  @IsOptional() @IsBoolean() prices_include_tax?: boolean;
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
}
class BranchDto { @IsString() @MinLength(2) @MaxLength(16) code: string; @IsString() @MinLength(2) name: string; @IsIn(["STORE", "WAREHOUSE"]) kind: "STORE" | "WAREHOUSE"; @IsOptional() @IsString() phone?: string; @IsOptional() @IsString() address?: string }
class UpdateBranchDto { @IsOptional() @IsString() @MinLength(2) @MaxLength(16) code?: string; @IsOptional() @IsString() @MinLength(2) name?: string; @IsOptional() @IsString() phone?: string; @IsOptional() @IsString() address?: string; @IsOptional() @IsBoolean() active?: boolean }
class LocationDto { @IsUUID() branch_id: string; @IsString() @MinLength(2) code: string; @IsString() name: string; @IsIn(["SALES_FLOOR", "STOREROOM", "QUARANTINE", "DAMAGED"]) kind: any }
class RegisterDto { @IsUUID() branch_id: string; @IsOptional() @IsUUID() location_id?: string; @IsString() @MinLength(2) @MaxLength(16) code: string; @IsString() @MinLength(2) name: string }
class UpdateRegisterDto { @IsOptional() @IsString() @MinLength(2) name?: string; @IsOptional() @IsString() @MinLength(2) @MaxLength(16) code?: string; @IsOptional() @IsUUID() location_id?: string; @IsOptional() @IsBoolean() active?: boolean }
class UserDto {
  @IsEmail() email: string; @IsString() @MinLength(2) full_name: string; @IsOptional() @IsString() phone?: string;
  @IsString() @MinLength(10) password: string; @IsArray() @IsString({ each: true }) roles: string[];
  @IsOptional() @IsBoolean() all_branches?: boolean; @IsOptional() @IsArray() @IsUUID("all", { each: true }) branch_ids?: string[]; @IsOptional() @IsUUID() default_branch_id?: string;
}
class UpdateUserDto {
  @IsOptional() @IsString() full_name?: string; @IsOptional() @IsString() phone?: string; @IsOptional() @IsIn(["ACTIVE", "DISABLED"]) status?: "ACTIVE" | "DISABLED";
  @IsOptional() @IsArray() @IsString({ each: true }) roles?: string[]; @IsOptional() @IsBoolean() all_branches?: boolean;
  @IsOptional() @IsArray() @IsUUID("all", { each: true }) branch_ids?: string[]; @IsOptional() @IsUUID() default_branch_id?: string; @IsOptional() @IsString() @MinLength(10) reset_password?: string;
}
class RolePermsDto { @IsArray() @ArrayUnique() @IsString({ each: true }) permissions: string[] }
class TaxDto { @IsString() code: string; @IsString() name: string; @IsDecimalValue({ min: 0, maxDecimals: 4 }) rate_percent: string; @IsOptional() @IsBoolean() active?: boolean }
class PolicyDto { @IsOptional() @IsBoolean() enabled?: boolean; @IsOptional() @IsDecimalValue({ min: 0 }) threshold_amount?: string | null; @IsOptional() @IsDecimalValue({ min: 0 }) threshold_percent?: string | null; @IsOptional() @IsBoolean() allow_self_approval?: boolean }

@ApiTags("admin")
@ApiBearerAuth()
class AuditPurgeDto {
  @IsInt() @Min(6) months: number;
  @IsString() password: string;
}
class ClearDto {
  @IsIn(["transactions", "everything"]) mode: "transactions" | "everything";
  @IsString() confirm_name: string;
  @IsString() password: string;
}

@Controller("admin")
export class AdminController {
  constructor(private prisma: PrismaService, private audit: AuditService, private maintenance: MaintenanceService) {}

  /** Full backup (SQL script) streamed as a gzip download. */
  @Get("backup") @RequirePermissions("admin.backup")
  async backup(@Auth() a: AuthContext, @Res() res: Response) {
    const b = await this.prisma.client.business.findUniqueOrThrow({ where: { id: a.businessId }, select: { name: true } });
    const slug = b.name.normalize("NFD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "retail";
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}-backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.sql.gz"`);
    res.setHeader("Cache-Control", "no-store");
    const gz = createGzip();
    gz.pipe(res);
    try {
      for await (const chunk of this.maintenance.backup(a)) if (!gz.write(chunk)) await new Promise((r) => gz.once("drain", r));
      gz.end();
    } catch (e) {
      gz.end(`\n-- BACKUP FAILED: ${(e as Error).message}\nROLLBACK;\n`);
      throw e;
    }
  }

  @Get("audit-retention") @RequirePermissions("admin.audit_purge")
  auditPreview(@Auth() a: AuthContext, @Query("months") months?: string) { return this.maintenance.auditPurgePreview(a, Number(months ?? 6)); }

  /** CSV of the entries a purge would delete — download it before purging if you need to keep them. */
  @Get("audit-retention/export") @RequirePermissions("admin.audit_purge")
  async auditExport(@Auth() a: AuthContext, @Res() res: Response, @Query("months") months?: string) {
    const rows = await this.maintenance.auditPurgeRows(a, Number(months ?? 6));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-before-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows));
  }

  @Post("audit-retention/purge") @HttpCode(200) @RequirePermissions("admin.audit_purge")
  purgeAudit(@Auth() a: AuthContext, @Body() dto: AuditPurgeDto) { return this.maintenance.purgeAudit(a, dto); }

  @Post("clear") @HttpCode(200) @RequirePermissions("admin.reset")
  clear(@Auth() a: AuthContext, @Body() dto: ClearDto) { return this.maintenance.clear(a, dto); }

  @Get("settings") @RequirePermissions("admin.settings")
  async settings(@Auth() a: AuthContext) {
    const b = await this.prisma.client.business.findUniqueOrThrow({ where: { id: a.businessId } });
    return { ...b, policies: { ...DEFAULT_POLICIES, ...(b.settings as object) } };
  }

  @Patch("settings") @RequirePermissions("admin.settings")
  async updateSettings(@Auth() a: AuthContext, @Body() dto: SettingsDto) {
    const b = await this.prisma.client.business.findUniqueOrThrow({ where: { id: a.businessId } });
    if (dto.prices_include_tax !== undefined && dto.prices_include_tax !== b.prices_include_tax) assertCan(a, "accounting.periods", "Changing tax-inclusive pricing is a financial policy change (Owner/Accountant)");
    const settings = dto.settings ? { ...(b.settings as object), ...pick(dto.settings, Object.keys(DEFAULT_POLICIES)) } : undefined;
    const u = await this.prisma.client.business.update({ where: { id: a.businessId }, data: { ...dto, settings: settings as any } });
    await this.audit.record(a, { action: "settings.updated", entityType: "business", entityId: a.businessId, summary: "Business settings updated", data: dto });
    return u;
  }

  @Get("branches") @RequirePermissions("admin.settings")
  async branches(@Auth() a: AuthContext) {
    return this.prisma.client.branch.findMany({ where: { business_id: a.businessId }, include: { locations: { orderBy: { code: "asc" } } }, orderBy: { code: "asc" } });
  }

  @Post("branches") @RequirePermissions("admin.settings")
  async createBranch(@Auth() a: AuthContext, @Body() dto: BranchDto) {
    return this.prisma.tx(async (tx) => {
      const br = await createBranchWithDefaults(tx, a.businessId, { code: dto.code.toUpperCase(), name: dto.name, kind: dto.kind, phone: dto.phone, address: dto.address });
      await this.audit.record(a, { action: "branch.created", entityType: "branch", entityId: br.id, summary: `Branch ${br.code} created with default locations and safe`, branchId: br.id }, tx);
      return br;
    });
  }

  /** Counts the business records that tie a branch to its history (a branch with any of these cannot be deleted). */
  private async branchHistory(id: string) {
    const db = this.prisma.client;
    const w = { branch_id: id };
    const counts = await Promise.all([
      db.sale.count({ where: w }), db.heldCart.count({ where: w }), db.payment.count({ where: w }), db.salesReturn.count({ where: w }),
      db.purchaseOrder.count({ where: w }), db.goodsReceipt.count({ where: w }), db.supplierInvoice.count({ where: w }), db.supplierPayment.count({ where: w }), db.purchaseReturn.count({ where: w }),
      db.stockMovement.count({ where: w }), db.stockTransfer.count({ where: { OR: [{ from_branch_id: id }, { to_branch_id: id }] } }), db.stockCount.count({ where: w }), db.stockAdjustment.count({ where: w }),
      db.cashierSession.count({ where: w }), db.journalEntry.count({ where: w }), db.journalLine.count({ where: w }), db.expense.count({ where: w }), db.approvalRequest.count({ where: w }),
      db.priceList.count({ where: w }), db.promotion.count({ where: w }),
    ]);
    return counts.reduce((x, y) => x + y, 0);
  }

  /** Rename, change contact details, re-code (only while unused), activate/deactivate. */
  @Patch("branches/:id") @RequirePermissions("admin.settings")
  async updateBranch(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto) {
    const db = this.prisma.client;
    const br = await db.branch.findFirst({ where: { id, business_id: a.businessId } });
    if (!br) throw notFound("Branch");
    const data: { name?: string; code?: string; phone?: string | null; address?: string | null; active?: boolean } = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.phone !== undefined) data.phone = dto.phone.trim() || null;
    if (dto.address !== undefined) data.address = dto.address.trim() || null;
    if (dto.code !== undefined && dto.code.trim().toUpperCase() !== br.code) {
      const code = dto.code.trim().toUpperCase();
      if (await this.branchHistory(id)) throw invalid("BRANCH_IN_USE", "This branch already has transactions — its code cannot change (rename it instead)");
      if (await db.branch.findFirst({ where: { business_id: a.businessId, code, id: { not: id } } })) throw invalid("DUPLICATE_CODE", `A branch with code ${code} already exists`);
      data.code = code;
    }
    if (dto.active === false && br.active) {
      if ((await db.branch.count({ where: { business_id: a.businessId, active: true } })) <= 1) throw invalid("LAST_BRANCH", "At least one branch must stay active");
      const open = await db.cashierSession.findFirst({ where: { branch_id: id, status: { in: ["OPEN", "CLOSING"] } } });
      if (open) throw invalid("SESSION_OPEN", `Close cashier session ${open.number} before deactivating this branch`);
    }
    if (dto.active !== undefined) data.active = dto.active;
    await this.prisma.tx(async (tx) => {
      await tx.branch.update({ where: { id }, data });
      if (data.name || data.code) {
        // keep the branch safe's names in step
        const safes = await tx.financialAccount.findMany({ where: { branch_id: id, kind: "SAFE" } });
        for (const fa of safes) {
          const name = `Safe — ${data.name ?? br.name}`;
          const code = data.code && fa.code === `SAFE-${br.code}` && !(await tx.financialAccount.findFirst({ where: { business_id: a.businessId, code: `SAFE-${data.code}` } })) ? `SAFE-${data.code}` : fa.code;
          await tx.financialAccount.update({ where: { id: fa.id }, data: { name, code } });
          await tx.account.update({ where: { id: fa.gl_account_id }, data: { name } });
        }
      }
      await this.audit.record(a, { action: "branch.updated", entityType: "branch", entityId: id, summary: `Branch ${br.code} updated`, branchId: id, data: { before: { code: br.code, name: br.name, phone: br.phone, address: br.address, active: br.active }, after: data } }, tx);
    });
    return db.branch.findUniqueOrThrow({ where: { id } });
  }

  /** Deletes a branch that has no transactions, with its default locations, unused registers, tills and safe. */
  @Delete("branches/:id") @RequirePermissions("admin.settings")
  async deleteBranch(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const db = this.prisma.client;
    const br = await db.branch.findFirst({ where: { id, business_id: a.businessId } });
    if (!br) throw notFound("Branch");
    if ((await db.branch.count({ where: { business_id: a.businessId } })) <= 1) throw invalid("LAST_BRANCH", "The only branch cannot be deleted");
    if (br.active && (await db.branch.count({ where: { business_id: a.businessId, active: true } })) <= 1) throw invalid("LAST_BRANCH", "At least one branch must stay active");
    if (await this.branchHistory(id)) throw invalid("BRANCH_IN_USE", `${br.code} has transactions and cannot be deleted — deactivate it instead`);
    const stock = await db.stockBalance.count({ where: { branch_id: id, NOT: { qty_on_hand: 0 } } });
    if (stock) throw invalid("BRANCH_IN_USE", `${br.code} still holds stock — deactivate it instead`);
    try {
      await this.prisma.tx(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.branch_delete', ${id}, true)`;
        await tx.$executeRaw`UPDATE audit_events SET branch_id = NULL WHERE branch_id = ${id}::uuid`;
        await tx.notification.deleteMany({ where: { branch_id: id } });
        await tx.userBranchAccess.deleteMany({ where: { branch_id: id } });
        await tx.user.updateMany({ where: { business_id: a.businessId, default_branch_id: id }, data: { default_branch_id: null } });
        const regs = await tx.cashRegister.findMany({ where: { branch_id: id } });
        await tx.cashRegister.deleteMany({ where: { branch_id: id } });
        const fas = await tx.financialAccount.findMany({ where: { OR: [{ branch_id: id }, { id: { in: regs.map((r) => r.till_account_id) } }] } });
        for (const fa of fas) {
          if ((await tx.journalLine.count({ where: { OR: [{ account_id: fa.gl_account_id }, { financial_account_id: fa.id }] } })) + (await tx.payment.count({ where: { financial_account_id: fa.id } }))) throw invalid("BRANCH_IN_USE", `${fa.name} has postings — deactivate the branch instead`);
          await tx.financialAccount.delete({ where: { id: fa.id } });
          const glUsed = (await tx.financialAccount.count({ where: { gl_account_id: fa.gl_account_id } })) + (await tx.postingRule.count({ where: { account_id: fa.gl_account_id } })) + (await tx.journalLine.count({ where: { account_id: fa.gl_account_id } }));
          if (!glUsed) await tx.account.delete({ where: { id: fa.gl_account_id } });
        }
        await tx.stockBalance.deleteMany({ where: { branch_id: id } });
        await tx.inventoryCostPool.deleteMany({ where: { branch_id: id } });
        await tx.location.deleteMany({ where: { branch_id: id } });
        await tx.branch.delete({ where: { id } });
        await this.audit.record(a, { action: "branch.deleted", entityType: "branch", entityId: id, summary: `Branch ${br.code} "${br.name}" deleted`, data: { code: br.code, name: br.name, registers: regs.map((r) => r.code) } }, tx);
      });
    } catch (e: any) {
      if (e?.code === "P2003" || /foreign key/i.test(String(e?.message))) throw invalid("BRANCH_IN_USE", `${br.code} is referenced by other records — deactivate it instead`);
      throw e;
    }
    return { id, deleted: true };
  }

  @Post("locations") @RequirePermissions("admin.settings")
  async createLocation(@Auth() a: AuthContext, @Body() dto: LocationDto) {
    const br = await this.prisma.client.branch.findFirst({ where: { id: dto.branch_id, business_id: a.businessId } });
    if (!br) throw notFound("Branch");
    const l = await this.prisma.client.location.create({ data: { business_id: a.businessId, branch_id: br.id, code: dto.code.toUpperCase(), name: dto.name, kind: dto.kind, is_sellable: dto.kind === "SALES_FLOOR" || dto.kind === "STOREROOM" } });
    await this.audit.record(a, { action: "location.created", entityType: "location", entityId: l.id, summary: `Location ${l.code} created at ${br.code}`, branchId: br.id });
    return l;
  }

  @Get("registers") @RequirePermissions("admin.settings")
  async registers(@Auth() a: AuthContext) {
    const regs = await this.prisma.client.cashRegister.findMany({ where: { business_id: a.businessId }, orderBy: [{ branch_id: "asc" }, { code: "asc" }] });
    const ids = regs.map((r) => r.id);
    const [open, counts, locations] = await Promise.all([
      this.prisma.client.cashierSession.findMany({ where: { register_id: { in: ids }, status: { in: ["OPEN", "CLOSING"] } }, select: { register_id: true, number: true } }),
      this.prisma.client.cashierSession.groupBy({ by: ["register_id"], where: { register_id: { in: ids } }, _count: { _all: true } }),
      this.prisma.client.location.findMany({ where: { id: { in: regs.map((r) => r.location_id) } }, select: { id: true, code: true, name: true } }),
    ]);
    return regs.map((r) => ({ ...r, open_session: open.find((o) => o.register_id === r.id)?.number ?? null, session_count: counts.find((c) => c.register_id === r.id)?._count._all ?? 0, location: locations.find((l) => l.id === r.location_id) ?? null }));
  }

  /** Creates a register with its own till financial account and GL sub-account. */
  @Post("registers") @RequirePermissions("admin.settings")
  async createRegister(@Auth() a: AuthContext, @Body() dto: RegisterDto) {
    return this.prisma.tx(async (tx) => {
      const br = await tx.branch.findFirst({ where: { id: dto.branch_id, business_id: a.businessId } });
      if (!br) throw notFound("Branch");
      const code = dto.code.trim().toUpperCase();
      if (await tx.cashRegister.findFirst({ where: { branch_id: br.id, code } })) throw invalid("DUPLICATE_CODE", `${br.name} already has a register with code ${code}`);
      if (dto.location_id && !(await tx.location.findFirst({ where: { id: dto.location_id, branch_id: br.id, is_sellable: true } }))) throw invalid("INVALID_LOCATION", "Choose a sellable location of this branch");
      const reg = await createRegister(tx, a.businessId, br.id, code, dto.name.trim());
      if (dto.location_id && dto.location_id !== reg.location_id) await tx.cashRegister.update({ where: { id: reg.id }, data: { location_id: dto.location_id } });
      await this.audit.record(a, { action: "register.created", entityType: "cash_register", entityId: reg.id, summary: `Register ${reg.code} created at ${br.code}`, branchId: br.id }, tx);
      return reg;
    });
  }

  /** Rename, re-code (only while unused), move to another sellable location of the branch, activate/deactivate. */
  @Patch("registers/:id") @RequirePermissions("admin.settings")
  async updateRegister(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateRegisterDto) {
    const db = this.prisma.client;
    const reg = await db.cashRegister.findFirst({ where: { id, business_id: a.businessId } });
    if (!reg) throw notFound("Register");
    const openSession = await db.cashierSession.findFirst({ where: { register_id: id, status: { in: ["OPEN", "CLOSING"] } } });
    const data: { name?: string; code?: string; location_id?: string; active?: boolean } = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.code !== undefined && dto.code.trim().toUpperCase() !== reg.code) {
      const code = dto.code.trim().toUpperCase();
      if (await db.cashierSession.count({ where: { register_id: id } })) throw invalid("REGISTER_IN_USE", "This register has cashier sessions — its code cannot change (rename it instead)");
      if (await db.cashRegister.findFirst({ where: { branch_id: reg.branch_id, code, id: { not: id } } })) throw invalid("DUPLICATE_CODE", `A register with code ${code} already exists at this branch`);
      data.code = code;
    }
    if (dto.location_id !== undefined && dto.location_id !== reg.location_id) {
      if (openSession) throw invalid("SESSION_OPEN", "Close the open cashier session before moving the register");
      if (!(await db.location.findFirst({ where: { id: dto.location_id, branch_id: reg.branch_id, is_sellable: true } }))) throw invalid("INVALID_LOCATION", "Choose a sellable location of this branch");
      data.location_id = dto.location_id;
    }
    if (dto.active === false && reg.active && openSession) throw invalid("SESSION_OPEN", `Close the open cashier session (${openSession.number}) before deactivating this register`);
    if (dto.active !== undefined) data.active = dto.active;
    await this.prisma.tx(async (tx) => {
      await tx.cashRegister.update({ where: { id }, data });
      if (data.name || data.active !== undefined) {
        // keep the till account in step: same name, active with its register (a till must be empty to be switched off)
        const br = await tx.branch.findUniqueOrThrow({ where: { id: reg.branch_id } });
        const fa = await tx.financialAccount.findUniqueOrThrow({ where: { id: reg.till_account_id } });
        if (data.active === false) {
          const bal = await tx.journalLine.aggregate({ where: { account_id: fa.gl_account_id }, _sum: { debit: true, credit: true } });
          if (!D(bal._sum.debit ?? 0).equals(D(bal._sum.credit ?? 0))) throw invalid("TILL_NOT_EMPTY", "The till still holds money — close its last session to the safe first");
        }
        await tx.financialAccount.update({ where: { id: fa.id }, data: { ...(data.name ? { name: `Till ${br.code} ${data.name}` } : {}), ...(data.active !== undefined ? { active: data.active } : {}) } });
        if (data.name) await tx.account.update({ where: { id: fa.gl_account_id }, data: { name: `Till ${br.code} ${data.name}` } });
      }
      await this.audit.record(a, { action: "register.updated", entityType: "cash_register", entityId: id, summary: `Register ${reg.code} updated`, branchId: reg.branch_id, data: { before: { name: reg.name, code: reg.code, location_id: reg.location_id, active: reg.active }, after: data } }, tx);
    });
    return db.cashRegister.findUniqueOrThrow({ where: { id } });
  }

  /** Deletes a register that never had a cashier session or sale (with its till account and ledger account). */
  @Delete("registers/:id") @RequirePermissions("admin.settings")
  async deleteRegister(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const db = this.prisma.client;
    const reg = await db.cashRegister.findFirst({ where: { id, business_id: a.businessId } });
    if (!reg) throw notFound("Register");
    const fa = await db.financialAccount.findUniqueOrThrow({ where: { id: reg.till_account_id } });
    const used = (await Promise.all([
      db.cashierSession.count({ where: { register_id: id } }), db.sale.count({ where: { register_id: id } }), db.heldCart.count({ where: { register_id: id } }),
      db.journalLine.count({ where: { OR: [{ account_id: fa.gl_account_id }, { financial_account_id: fa.id }] } }), db.payment.count({ where: { financial_account_id: fa.id } }),
    ])).reduce((x, y) => x + y, 0);
    if (used) throw invalid("REGISTER_IN_USE", `${reg.code} has cashier sessions or sales and cannot be deleted — deactivate it instead`);
    try {
      await this.prisma.tx(async (tx) => {
        await tx.cashRegister.delete({ where: { id } });
        await tx.financialAccount.delete({ where: { id: fa.id } });
        const glUsed = (await tx.financialAccount.count({ where: { gl_account_id: fa.gl_account_id } })) + (await tx.postingRule.count({ where: { account_id: fa.gl_account_id } }));
        if (!glUsed) await tx.account.delete({ where: { id: fa.gl_account_id } });
        await this.audit.record(a, { action: "register.deleted", entityType: "cash_register", entityId: id, summary: `Register ${reg.code} "${reg.name}" deleted`, branchId: reg.branch_id }, tx);
      });
    } catch (e: any) {
      if (e?.code === "P2003" || /foreign key/i.test(String(e?.message))) throw invalid("REGISTER_IN_USE", `${reg.code} is referenced by other records — deactivate it instead`);
      throw e;
    }
    return { id, deleted: true };
  }

  @Get("users") @RequirePermissions("admin.users")
  async users(@Auth() a: AuthContext, @Query() q: PageQuery) {
    const where = { business_id: a.businessId, ...(q.search ? { OR: [{ email: { contains: q.search, mode: "insensitive" as const } }, { full_name: { contains: q.search, mode: "insensitive" as const } }] } : {}) };
    const page = await paginate(q, this.prisma.client.user.count({ where }), this.prisma.client.user.findMany({ where, ...pageArgs(q), orderBy: { full_name: "asc" }, include: { roles: { include: { role: true } }, branch_access: true } }));
    return { ...page, items: page.items.map(({ password_hash, pin_hash, mfa_secret, ...u }) => ({ ...u, roles: u.roles.map((r) => r.role.code), branch_ids: u.branch_access.map((x) => x.branch_id), branch_access: undefined })) };
  }

  @Post("users") @RequirePermissions("admin.users")
  async createUser(@Auth() a: AuthContext, @Body() dto: UserDto) {
    validatePasswordStrength(dto.password);
    await this.guardRoleGrant(a, dto.roles);
    return this.prisma.tx(async (tx) => {
      const roles = await tx.role.findMany({ where: { business_id: a.businessId, code: { in: dto.roles } } });
      if (roles.length !== dto.roles.length) throw invalid("ROLE_UNKNOWN", "One or more roles do not exist");
      const u = await tx.user.create({
        data: {
          business_id: a.businessId, email: dto.email.toLowerCase(), full_name: dto.full_name, phone: dto.phone ?? null, password_hash: await hashPassword(dto.password),
          all_branches: !!dto.all_branches, default_branch_id: dto.default_branch_id ?? dto.branch_ids?.[0] ?? null, must_change_password: true,
          roles: { create: roles.map((r) => ({ role_id: r.id })) }, branch_access: { create: (dto.branch_ids ?? []).map((b) => ({ branch_id: b })) },
        },
      });
      await this.audit.record(a, { action: "user.created", entityType: "user", entityId: u.id, summary: `User ${u.email} created with roles ${dto.roles.join(", ")}` }, tx);
      return { id: u.id, email: u.email };
    });
  }

  @Patch("users/:id") @RequirePermissions("admin.users")
  async updateUser(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    const u = await this.prisma.client.user.findFirst({ where: { id, business_id: a.businessId } });
    if (!u) throw notFound("User");
    if (dto.roles) await this.guardRoleGrant(a, dto.roles);
    if (id === a.userId && (dto.status === "DISABLED" || dto.roles)) throw forbidden("You cannot change your own roles or disable yourself");
    if (dto.reset_password) validatePasswordStrength(dto.reset_password);
    await this.prisma.tx(async (tx) => {
      await tx.user.update({ where: { id }, data: { full_name: dto.full_name, phone: dto.phone, status: dto.status, all_branches: dto.all_branches, default_branch_id: dto.default_branch_id, ...(dto.reset_password ? { password_hash: await hashPassword(dto.reset_password), must_change_password: true } : {}) } });
      if (dto.roles) {
        const roles = await tx.role.findMany({ where: { business_id: a.businessId, code: { in: dto.roles } } });
        await tx.userRole.deleteMany({ where: { user_id: id } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ user_id: id, role_id: r.id })) });
      }
      if (dto.branch_ids) {
        await tx.userBranchAccess.deleteMany({ where: { user_id: id } });
        await tx.userBranchAccess.createMany({ data: dto.branch_ids.map((b) => ({ user_id: id, branch_id: b })) });
      }
      if (dto.status === "DISABLED" || dto.reset_password || dto.roles) {
        await tx.userSession.updateMany({ where: { user_id: id, revoked_at: null }, data: { revoked_at: new Date(), revoked_reason: "user access changed by administrator" } });
      }
      await this.audit.record(a, { action: "user.updated", entityType: "user", entityId: id, summary: `User ${u.email} updated`, data: { ...dto, reset_password: dto.reset_password ? "[set]" : undefined } }, tx);
    });
    return { ok: true };
  }

  /** Only holders of a permission may grant a role containing it (prevents privilege escalation by admins). */
  private async guardRoleGrant(a: AuthContext, roleCodes: string[]) {
    const roles = await this.prisma.client.role.findMany({ where: { business_id: a.businessId, code: { in: roleCodes } }, include: { permissions: { include: { permission: true } } } });
    const missing = roles.flatMap((r) => r.permissions.map((p) => p.permission.code)).filter((c) => !a.permissions.has(c));
    if (missing.length) throw forbidden(`You cannot grant permissions you do not hold: ${[...new Set(missing)].slice(0, 6).join(", ")}`);
  }

  @Get("roles") @RequirePermissions("admin.users")
  async roles(@Auth() a: AuthContext) {
    const roles = await this.prisma.client.role.findMany({ where: { business_id: a.businessId }, include: { permissions: { include: { permission: true } } }, orderBy: { name: "asc" } });
    return { catalogue: PERMISSIONS, roles: roles.map((r) => ({ ...r, permissions: r.permissions.map((p) => p.permission.code).sort() })) };
  }

  @Put("roles/:id/permissions") @RequirePermissions("admin.roles")
  async setRolePermissions(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: RolePermsDto) {
    const role = await this.prisma.client.role.findFirst({ where: { id, business_id: a.businessId }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw notFound("Role");
    const current = new Set(role.permissions.map((p) => p.permission.code));
    const added = dto.permissions.filter((p) => !current.has(p));
    const notHeld = added.filter((p) => !a.permissions.has(p));
    if (notHeld.length) throw forbidden(`You cannot grant permissions you do not hold: ${notHeld.join(", ")}`);
    if (role.code === "OWNER") throw forbidden("The Owner role always has all permissions");
    const perms = await this.prisma.client.permission.findMany({ where: { code: { in: dto.permissions } } });
    await this.prisma.tx(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { role_id: id } });
      await tx.rolePermission.createMany({ data: perms.map((p) => ({ role_id: id, permission_id: p.id })) });
      await this.audit.record(a, { action: "role.permissions_changed", entityType: "role", entityId: id, summary: `Role ${role.code} permissions changed`, data: { added, removed: [...current].filter((c) => !dto.permissions.includes(c)) } }, tx);
    });
    return { ok: true };
  }

  @Get("tax-rates") @RequirePermissions("admin.settings")
  taxes(@Auth() a: AuthContext) { return this.prisma.client.taxRate.findMany({ where: { business_id: a.businessId }, orderBy: { code: "asc" } }); }

  @Post("tax-rates") @RequirePermissions("admin.settings")
  async createTax(@Auth() a: AuthContext, @Body() dto: TaxDto) {
    assertCan(a, "accounting.periods", "Tax configuration is a financial setting (Owner/Accountant)");
    const t = await this.prisma.client.taxRate.create({ data: { business_id: a.businessId, code: dto.code.toUpperCase(), name: dto.name, rate_percent: D(dto.rate_percent), active: dto.active ?? true } });
    await this.audit.record(a, { action: "tax.created", entityType: "tax_rate", entityId: t.id, summary: `Tax rate ${t.code} ${t.rate_percent}% created` });
    return t;
  }

  @Get("approval-policies") @RequirePermissions("approvals.view")
  policies(@Auth() a: AuthContext) { return this.prisma.client.approvalPolicy.findMany({ where: { business_id: a.businessId }, orderBy: { request_type: "asc" } }); }

  /** Thresholds are financial controls: require admin.settings AND accounting.periods (Owner by default). */
  @Patch("approval-policies/:id") @RequirePermissions("admin.settings", "accounting.periods")
  async updatePolicy(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() dto: PolicyDto) {
    const p = await this.prisma.client.approvalPolicy.findFirst({ where: { id, business_id: a.businessId } });
    if (!p) throw notFound("Policy");
    const u = await this.prisma.client.approvalPolicy.update({ where: { id }, data: { enabled: dto.enabled, allow_self_approval: dto.allow_self_approval, threshold_amount: dto.threshold_amount === undefined ? undefined : dto.threshold_amount === null ? null : D(dto.threshold_amount), threshold_percent: dto.threshold_percent === undefined ? undefined : dto.threshold_percent === null ? null : D(dto.threshold_percent) } });
    await this.audit.record(a, { action: "approval_policy.changed", entityType: "approval_policy", entityId: id, summary: `Approval policy ${p.request_type} changed`, data: { before: p, after: dto } });
    return u;
  }

  @Post("notifications/:id/read") @HttpCode(200) @RequirePermissions("dashboard.view")
  async readNotification(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.prisma.client.notification.updateMany({ where: { id, business_id: a.businessId }, data: { read_at: new Date() } });
    return { ok: true };
  }
}

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
}
