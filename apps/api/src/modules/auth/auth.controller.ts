import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";
import type { Request, Response } from "express";
import { Auth, AuthContext, Public } from "../../common/auth-context";
import { PrismaService } from "../../common/prisma.service";
import { config } from "../../config";
import { AuthService } from "./auth.service";

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) @MaxLength(200) password: string;
}
class ChangePasswordDto {
  @IsString() current_password: string;
  @IsString() @MinLength(10) @MaxLength(200) new_password: string;
}

const COOKIE = "rs_refresh";
const cookieOpts = () => ({
  httpOnly: true,
  secure: config.isProduction,
  sameSite: "strict" as const,
  path: "/api/v1/auth",
  maxAge: config.refreshTtlDays * 86_400_000,
});

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService, private prisma: PrismaService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("login")
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(dto.email, dto.password, { ip: req.ip, userAgent: req.headers["user-agent"] });
    res.cookie(COOKIE, r.refreshToken, cookieOpts());
    return { access_token: r.accessToken, must_change_password: r.mustChangePassword };
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.refresh(req.cookies?.[COOKIE] ?? req.body?.refresh_token);
    res.cookie(COOKIE, r.refreshToken, cookieOpts());
    return { access_token: r.accessToken };
  }

  @ApiBearerAuth()
  @Post("logout")
  @HttpCode(200)
  async logout(@Auth() a: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.revoke(a, a.sessionId, "logout");
    res.clearCookie(COOKIE, { path: "/api/v1/auth" });
    return { ok: true };
  }

  @ApiBearerAuth()
  @Get("me")
  me(@Auth() a: AuthContext) {
    return this.auth.me(a);
  }

  @ApiBearerAuth()
  @Get("sessions")
  sessions(@Auth() a: AuthContext) {
    return this.prisma.client.userSession.findMany({
      where: { user_id: a.userId, revoked_at: null, expires_at: { gt: new Date() } },
      select: { id: true, created_at: true, last_used_at: true, ip_address: true, user_agent: true, expires_at: true },
      orderBy: { last_used_at: "desc" },
    }).then((rows) => rows.map((r) => ({ ...r, current: r.id === a.sessionId })));
  }

  @ApiBearerAuth()
  @Post("sessions/:id/revoke")
  @HttpCode(200)
  async revoke(@Auth() a: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    await this.auth.revoke(a, id, "revoked by user");
    return { ok: true };
  }

  @ApiBearerAuth()
  @Post("change-password")
  @HttpCode(200)
  async changePassword(@Auth() a: AuthContext, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(a, dto.current_password, dto.new_password);
    return { ok: true };
  }
}
