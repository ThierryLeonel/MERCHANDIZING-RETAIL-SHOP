import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { PermissionCode } from "@retail/api-contracts";
import { forbidden } from "./errors";

export interface AuthContext {
  userId: string;
  sessionId: string;
  businessId: string;
  fullName: string;
  email: string;
  permissions: Set<string>;
  roles: string[];
  allBranches: boolean;
  branchIds: string[];
  defaultBranchId: string | null;
  ip?: string;
}

export const IS_PUBLIC = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const PERMISSIONS_KEY = "permissions";
/** Requires ALL listed permissions (checked server-side by PermissionsGuard). */
export const RequirePermissions = (...perms: PermissionCode[]) => SetMetadata(PERMISSIONS_KEY, perms);

export const Auth = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthContext => ctx.switchToHttp().getRequest().auth);

export function can(auth: AuthContext, perm: PermissionCode): boolean {
  return auth.permissions.has(perm);
}
export function assertCan(auth: AuthContext, perm: PermissionCode, message?: string) {
  if (!auth.permissions.has(perm)) throw forbidden(message ?? `Missing permission: ${perm}`);
}
export function hasBranch(auth: AuthContext, branchId: string | null | undefined): boolean {
  if (!branchId) return true;
  return auth.allBranches || auth.branchIds.includes(branchId);
}
export function assertBranch(auth: AuthContext, branchId: string | null | undefined) {
  if (!hasBranch(auth, branchId)) throw forbidden("You do not have access to this branch");
}
/** Prisma where-fragment restricting rows to the user's branches. */
export function branchFilter(auth: AuthContext, field = "branch_id"): Record<string, unknown> {
  return auth.allBranches ? {} : { [field]: { in: auth.branchIds } };
}
