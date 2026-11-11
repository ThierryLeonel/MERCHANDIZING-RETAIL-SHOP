import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";
import { AuthContext } from "../../common/auth-context";
import { AuditService } from "../../common/audit.service";
import { DomainError, invalid } from "../../common/errors";
import { PrismaService } from "../../common/prisma.service";
import { config } from "../../config";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REFRESH_GRACE_MS = 30_000;

export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 }); // argon2id (OWASP baseline)
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function validatePasswordStrength(pw: string) {
  if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    throw invalid("WEAK_PASSWORD", "Password must be at least 10 characters and include letters and numbers");
  }
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private audit: AuditService) {}

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }) {
    const users = await this.prisma.client.user.findMany({ where: { email: email.trim().toLowerCase() } });
    const user = users.length === 1 ? users[0] : null;
    const fail = () => new DomainError("INVALID_CREDENTIALS", "Email or password is incorrect", 401);
    if (!user) {
      await hashPassword("timing-equaliser-x1"); // reduce user-enumeration timing signal
      throw fail();
    }
    if (user.locked_until && user.locked_until > new Date()) {
      throw new DomainError("ACCOUNT_LOCKED", "Too many failed attempts. Try again later.", 423);
    }
    const ok = user.status === "ACTIVE" && (await verify(user.password_hash, password));
    if (!ok) {
      const failed = user.failed_logins + 1;
      await this.prisma.client.user.update({
        where: { id: user.id },
        data: { failed_logins: failed >= MAX_FAILED ? 0 : failed, locked_until: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      await this.audit.record({ userId: user.id, businessId: user.business_id, ip: meta.ip }, { action: "auth.login_failed", entityType: "user", entityId: user.id, summary: `Failed sign-in for ${user.email}` });
      throw fail();
    }
    await this.prisma.client.user.update({ where: { id: user.id }, data: { failed_logins: 0, locked_until: null, last_login_at: new Date() } });
    const refresh = randomBytes(48).toString("base64url");
    const session = await this.prisma.client.userSession.create({
      data: {
        user_id: user.id,
        refresh_token_hash: sha256(refresh),
        ip_address: meta.ip ?? null,
        user_agent: meta.userAgent?.slice(0, 250) ?? null,
        expires_at: new Date(Date.now() + config.refreshTtlDays * 86_400_000),
      },
    });
    await this.audit.record({ userId: user.id, businessId: user.business_id, ip: meta.ip }, { action: "auth.login", entityType: "user", entityId: user.id, summary: `${user.email} signed in` });
    return { accessToken: await this.issueAccess(user.id, session.id, user.business_id), refreshToken: `${session.id}.${refresh}`, mustChangePassword: user.must_change_password };
  }

  private issueAccess(userId: string, sessionId: string, businessId: string) {
    return this.jwt.signAsync({ sub: userId, sid: sessionId, bid: businessId }, { expiresIn: config.accessTtlSeconds });
  }

  /** Rotates the refresh token. Presenting a stale token revokes the session (theft detection). */
  async refresh(token: string | undefined) {
    const [sid, secret] = (token ?? "").split(".");
    if (!sid || !secret) throw new DomainError("REFRESH_INVALID", "Sign in again", 401);
    const session = await this.prisma.client.userSession.findUnique({ where: { id: sid } }).catch(() => null);
    if (!session || session.revoked_at || session.expires_at < new Date()) throw new DomainError("REFRESH_INVALID", "Sign in again", 401);
    const presented = sha256(secret);
    const user = await this.prisma.client.user.findUnique({ where: { id: session.user_id } });
    if (!user || user.status !== "ACTIVE") throw new DomainError("USER_DISABLED", "User is disabled", 401);
    if (session.refresh_token_hash !== presented) {
      // Grace window: a concurrent request (another tab) already rotated this token moments ago.
      // Issue an access token but do not rotate again or set a cookie (the browser already holds the newer one).
      const inGrace = session.previous_refresh_hash === presented && session.rotated_at && Date.now() - session.rotated_at.getTime() < REFRESH_GRACE_MS;
      if (inGrace) return { accessToken: await this.issueAccess(user.id, sid, user.business_id), refreshToken: null };
      await this.prisma.client.userSession.update({ where: { id: sid }, data: { revoked_at: new Date(), revoked_reason: "refresh token reuse detected" } });
      throw new DomainError("REFRESH_REUSED", "Session revoked for security. Sign in again.", 401);
    }
    const next = randomBytes(48).toString("base64url");
    // Conditional rotation: only one concurrent request wins; losers fall back to the grace path.
    const rotated = await this.prisma.client.userSession.updateMany({ where: { id: sid, refresh_token_hash: presented }, data: { refresh_token_hash: sha256(next), previous_refresh_hash: presented, rotated_at: new Date(), last_used_at: new Date() } });
    if (rotated.count !== 1) return { accessToken: await this.issueAccess(user.id, sid, user.business_id), refreshToken: null };
    return { accessToken: await this.issueAccess(user.id, sid, user.business_id), refreshToken: `${sid}.${next}` as string | null };
  }

  async revoke(auth: AuthContext, sessionId: string, reason: string) {
    const s = await this.prisma.client.userSession.findUnique({ where: { id: sessionId } });
    if (!s) return;
    if (s.user_id !== auth.userId && !auth.permissions.has("admin.users")) throw new DomainError("FORBIDDEN", "Cannot revoke another user's session", 403);
    await this.prisma.client.userSession.update({ where: { id: sessionId }, data: { revoked_at: new Date(), revoked_reason: reason } });
    await this.audit.record(auth, { action: "auth.session_revoked", entityType: "user_session", entityId: sessionId, summary: `Session revoked: ${reason}` });
  }

  async changePassword(auth: AuthContext, current: string, next: string) {
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await verify(user.password_hash, current))) throw new DomainError("INVALID_CREDENTIALS", "Current password is incorrect", 401);
    validatePasswordStrength(next);
    await this.prisma.client.user.update({ where: { id: user.id }, data: { password_hash: await hashPassword(next), must_change_password: false } });
    await this.prisma.client.userSession.updateMany({ where: { user_id: user.id, revoked_at: null, NOT: { id: auth.sessionId } }, data: { revoked_at: new Date(), revoked_reason: "password changed" } });
    await this.audit.record(auth, { action: "auth.password_changed", entityType: "user", entityId: user.id, summary: "Password changed; other sessions revoked" });
  }

  async me(auth: AuthContext) {
    const business = await this.prisma.client.business.findUniqueOrThrow({ where: { id: auth.businessId } });
    const branches = await this.prisma.client.branch.findMany({
      where: { business_id: auth.businessId, active: true, ...(auth.allBranches ? {} : { id: { in: auth.branchIds } }) },
      orderBy: { code: "asc" },
    });
    return {
      user: { id: auth.userId, email: auth.email, full_name: auth.fullName, roles: auth.roles, default_branch_id: auth.defaultBranchId },
      permissions: [...auth.permissions].sort(),
      branches,
      business: {
        id: business.id, name: business.name, currency_code: business.currency_code, currency_decimals: business.currency_decimals,
        timezone: business.timezone, locale: business.locale, prices_include_tax: business.prices_include_tax,
        receipt_footer: business.receipt_footer, phone: business.phone, address: business.address, tax_id: business.tax_id, is_demo: business.is_demo,
      },
    };
  }
}
