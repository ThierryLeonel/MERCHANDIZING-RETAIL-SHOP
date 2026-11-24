import { Body, Controller, Get, Post, Put, Query, ParseUUIDPipe } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from "class-validator";
import { Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { IsDecimalValue } from "../../common/validators";
import { DeclarationsService } from "./declarations.service";

class LineDto { @IsUUID() financial_account_id: string; @IsDecimalValue() amount: string }
class DeclareDto {
  @IsIn(["OPENING", "CLOSING"]) kind: "OPENING" | "CLOSING";
  @IsUUID() branch_id: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => LineDto) lines: LineDto[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class RolesDto { @IsArray() @IsString({ each: true }) roles: string[] }

@Controller("declarations")
export class DeclarationsController {
  constructor(private svc: DeclarationsService) {}

  /** Today's declarations of the signed-in user (any signed-in user). */
  @Get("me")
  me(@Auth() a: AuthContext, @Query("branch_id", ParseUUIDPipe) branchId: string) { return this.svc.status(a, branchId); }

  @Post()
  declare(@Auth() a: AuthContext, @Body() dto: DeclareDto) { return this.svc.declare(a, dto); }

  @Get() @RequirePermissions("declarations.view")
  report(@Auth() a: AuthContext, @Query("date") date?: string, @Query("branch_id") branchId?: string) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = undefined;
    return this.svc.report(a, { date, branch_id: branchId || undefined });
  }

  @Get("settings")
  async settings(@Auth() a: AuthContext) { return { roles: await this.svc.requiredRoles(a.businessId) }; }

  @Put("settings") @RequirePermissions("admin.settings")
  setSettings(@Auth() a: AuthContext, @Body() dto: RolesDto) { return this.svc.setRequiredRoles(a, dto.roles); }
}
