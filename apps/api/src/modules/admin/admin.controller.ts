import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
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
class LocationDto { @IsUUID() branch_id: string; @IsString() @MinLength(2) code: string; @IsString() name: string; @IsIn(["SALES_FLOOR", "STOREROOM", "QUARANTINE", "DAMAGED"]) kind: any }
class RegisterDto { @IsUUID() branch_id: string; @IsOptional() @IsUUID() location_id?: string; @IsString() @MinLength(2) @MaxLength(16) code: string; @IsString() name: string }
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
@Controller("admin")
export class AdminController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

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

  @Post("locations") @RequirePermissions("admin.settings")
  async createLocation(@Auth() a: AuthContext, @Body() dto: LocationDto) {
    const br = await this.prisma.client.branch.findFirst({ where: { id: dto.branch_id, business_id: a.businessId } });
    if (!br) throw notFound("Branch");
    const l = await this.prisma.client.location.create({ data: { business_id: a.businessId, branch_id: br.id, code: dto.code.toUpperCase(), name: dto.name, kind: dto.kind, is_sellable: dto.kind === "SALES_FLOOR" || dto.kind === "STOREROOM" } });
    await this.audit.record(a, { action: "location.created", entityType: "location", entityId: l.id, summary: `Location ${l.code} created at ${br.code}`, branchId: br.id });
    return l;
  }

  @Get("registers") @RequirePermissions("admin.settings")
  registers(@Auth() a: AuthContext) { return this.prisma.client.cashRegister.findMany({ where: { business_id: a.businessId }, orderBy: { code: "asc" } }); }

  /** Creates a register with its own till financial account and GL sub-account. */
  @Post("registers") @RequirePermissions("admin.settings")
  async createRegister(@Auth() a: AuthContext, @Body() dto: RegisterDto) {
    return this.prisma.tx(async (tx) => {
      const br = await tx.branch.findFirst({ where: { id: dto.branch_id, business_id: a.businessId } });
      if (!br) throw notFound("Branch");
      const reg = await createRegister(tx, a.businessId, br.id, dto.code.toUpperCase(), dto.name);
      if (dto.location_id && dto.location_id !== reg.location_id) await tx.cashRegister.update({ where: { id: reg.id }, data: { location_id: dto.location_id } });
      await this.audit.record(a, { action: "register.created", entityType: "cash_register", entityId: reg.id, summary: `Register ${reg.code} created at ${br.code}`, branchId: br.id }, tx);
      return reg;
    });
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
