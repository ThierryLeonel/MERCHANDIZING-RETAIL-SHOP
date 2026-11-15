import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsBoolean, IsObject, IsOptional, IsUUID } from "class-validator";
import { Auth, AuthContext, RequirePermissions } from "../../common/auth-context";
import { ImportService, Row } from "./import.service";

class ImportDto {
  @IsArray() @ArrayMaxSize(5000) @IsObject({ each: true }) rows: Row[];
  /** Defaults to true: validate and return the plan without saving. */
  @IsOptional() @IsBoolean() dry_run?: boolean;
}
class ProductImportDto extends ImportDto {
  /** With a branch, quantity/unit cost columns are posted as opening stock there. */
  @IsOptional() @IsUUID() branch_id?: string;
  @IsOptional() @IsUUID() location_id?: string;
}
class StockImportDto extends ImportDto {
  @IsUUID() branch_id: string;
  @IsOptional() @IsUUID() location_id?: string;
}

/** Spreadsheet imports. Each file is validated in full, then imported completely or not at all. */
@ApiTags("imports") @ApiBearerAuth()
@Controller("imports")
export class DataController {
  constructor(private svc: ImportService) {}

  @Get("products/export") @RequirePermissions("products.view")
  exportProducts(@Auth() a: AuthContext) { return this.svc.exportProducts(a); }

  @Get("customers/export") @RequirePermissions("customers.view")
  exportCustomers(@Auth() a: AuthContext) { return this.svc.exportCustomers(a); }

  @Post("products") @HttpCode(200) @RequirePermissions("data.import", "products.manage")
  products(@Auth() a: AuthContext, @Body() dto: ProductImportDto) { return this.svc.products(a, dto); }

  @Post("stock") @HttpCode(200) @RequirePermissions("data.import", "inventory.opening")
  stock(@Auth() a: AuthContext, @Body() dto: StockImportDto) { return this.svc.stock(a, dto); }

  @Post("customers") @HttpCode(200) @RequirePermissions("data.import", "customers.manage")
  customers(@Auth() a: AuthContext, @Body() dto: ImportDto) { return this.svc.customers(a, dto); }
}
