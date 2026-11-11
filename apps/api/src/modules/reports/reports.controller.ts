import { Controller, Get, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import type { Response } from "express";
import { Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { toJSONSafe } from "../../common/money";
import { businessDate, SettingsService } from "../../common/settings.service";
import { ReportsService, toCsv } from "./reports.service";

class RangeQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() branch_id?: string;
  @IsOptional() @IsIn(["json", "csv"]) format?: string;
  @IsOptional() @IsIn(["product", "variant", "category", "branch", "cashier"]) dimension?: any;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) days?: number;
  @IsOptional() @IsString() search?: string;
}

@ApiTags("reports")
@ApiBearerAuth()
@Controller("reports")
export class ReportsController {
  constructor(private svc: ReportsService, private settings: SettingsService) {}

  private async range(a: AuthContext, q: RangeQuery) {
    const b = await this.settings.business(a.businessId);
    const today = businessDate(new Date(), b.timezone);
    return { from: q.from ?? today, to: q.to ?? today, branch_id: q.branch_id };
  }
  private send(res: Response, q: RangeQuery, name: string, data: any, rowsKey?: string) {
    if (q.format === "csv") {
      const rows = rowsKey ? data[rowsKey] : data;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
      return res.send(toCsv(toJSONSafe(rows)));
    }
    return res.json(toJSONSafe(data));
  }

  @Get("dashboard") @RequirePermissions("dashboard.view")
  dashboard(@Auth() a: AuthContext, @Query("branch_id") branchId?: string) { return this.svc.dashboard(a, branchId || undefined); }

  @Get("daily-sales") @RequirePermissions("reports.view")
  async daily(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "daily-sales", await this.svc.dailySales(a, await this.range(a, q)), "sales"); }

  @Get("sales-by") @RequirePermissions("reports.view")
  async salesBy(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, `sales-by-${q.dimension ?? "variant"}`, await this.svc.salesBy(a, { ...(await this.range(a, q)), dimension: q.dimension ?? "variant" }), "rows"); }

  @Get("gross-profit") @RequirePermissions("reports.financial")
  async gp(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { const d = await this.svc.grossProfit(a, await this.range(a, q)); return this.send(res, q, "gross-profit", q.format === "csv" ? [d] : d); }

  @Get("discounts-refunds") @RequirePermissions("reports.view")
  async dr(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "discounts", await this.svc.discountsAndRefunds(a, await this.range(a, q)), "discounts"); }

  @Get("inventory-valuation") @RequirePermissions("reports.view")
  async iv(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "inventory-valuation", await this.svc.inventoryValuation(a, q.branch_id), "rows"); }

  @Get("slow-moving") @RequirePermissions("reports.view")
  async slow(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "slow-moving", await this.svc.slowMoving(a, q.branch_id ?? a.defaultBranchId ?? a.branchIds[0], q.days ?? 60)); }

  @Get("count-variances") @RequirePermissions("reports.view")
  async cv(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "count-variances", await this.svc.countVariances(a, await this.range(a, q))); }

  @Get("purchases-by-supplier") @RequirePermissions("reports.view")
  async pbs(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "purchases-by-supplier", await this.svc.purchasesBySupplier(a, await this.range(a, q))); }

  @Get("supplier-ageing") @RequirePermissions("reports.financial")
  async sa(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "supplier-ageing", await this.svc.supplierAgeing(a)); }

  @Get("cashier-variances") @RequirePermissions("reports.view")
  async cashv(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "cashier-variances", await this.svc.cashierVariances(a, await this.range(a, q))); }

  @Get("expenses") @RequirePermissions("reports.financial")
  async exp(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "expenses", await this.svc.expenses(a, await this.range(a, q))); }

  @Get("transfers-in-transit") @RequirePermissions("reports.view")
  async tit(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "transfers-in-transit", await this.svc.transfersInTransit(a)); }

  @Get("audit") @RequirePermissions("admin.audit")
  async audit(@Auth() a: AuthContext, @Query() q: RangeQuery, @Res() res: Response) { return this.send(res, q, "audit", await this.svc.audit(a, { ...(await this.range(a, q)), search: q.search })); }
}
