import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { AuthContext, IS_PUBLIC, PERMISSIONS_KEY } from "./auth-context";
import { DomainError, forbidden } from "./errors";
import { PrismaService } from "./prisma.service";

export interface AccessTokenPayload { sub: string; sid: string; bid: string }

/**
 * Authenticates every request (unless @Public) with a short-lived JWT AND a
 * live DB session check, so revoking a session takes effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7));
    } catch {
      throw new DomainError("TOKEN_INVALID", "Access token expired or invalid", 401);
    }
    req.auth = await loadAuthContext(this.prisma, payload.sub, payload.sid);
    req.auth.ip = req.ip;
    return true;
  }
}

export async function loadAuthContext(prisma: PrismaService, userId: string, sessionId: string): Promise<AuthContext> {
  const session = await prisma.client.userSession.findUnique({ where: { id: sessionId } });
  if (!session || session.user_id !== userId || session.revoked_at || session.expires_at < new Date()) {
    throw new DomainError("SESSION_REVOKED", "Session has ended; please sign in again", 401);
  }
  const user = await prisma.client.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }, branch_access: true },
  });
  if (!user || user.status !== "ACTIVE") throw new DomainError("USER_DISABLED", "User is disabled", 401);
  const permissions = new Set<string>();
  for (const ur of user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.code);
  return {
    userId: user.id,
    sessionId,
    businessId: user.business_id,
    fullName: user.full_name,
    email: user.email,
    permissions,
    roles: user.roles.map((r) => r.role.code),
    allBranches: user.all_branches,
    branchIds: user.branch_access.map((b) => b.branch_id),
    defaultBranchId: user.default_branch_id,
  };
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const perms = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!perms?.length) return true;
    const auth: AuthContext | undefined = ctx.switchToHttp().getRequest().auth;
    if (!auth) return true; // public route
    const missing = perms.filter((p) => !auth.permissions.has(p));
    if (missing.length) throw forbidden(`Missing permission: ${missing.join(", ")}`);
    return true;
  }
}
