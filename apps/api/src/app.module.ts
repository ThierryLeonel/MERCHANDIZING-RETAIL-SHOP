import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuditService } from "./common/audit.service";
import { DecimalSerializerInterceptor } from "./common/decimal.interceptor";
import { GlobalExceptionFilter } from "./common/errors";
import { AuthGuard, PermissionsGuard } from "./common/guards";
import { IdempotencyInterceptor } from "./common/idempotency";
import { PrismaService } from "./common/prisma.service";
import { SequenceService } from "./common/sequence.service";
import { SettingsService } from "./common/settings.service";
import { config } from "./config";
import { AccountingController } from "./modules/accounting/accounting.controller";
import { AccountingService } from "./modules/accounting/accounting.service";
import { PostingService } from "./modules/accounting/posting.service";
import { AdminController } from "./modules/admin/admin.controller";
import { ApprovalsController } from "./modules/approvals/approvals.controller";
import { ApprovalsService } from "./modules/approvals/approvals.service";
import { AuthController } from "./modules/auth/auth.controller";
import { AuthService } from "./modules/auth/auth.service";
import { CatalogueController } from "./modules/catalogue/catalogue.controller";
import { CatalogueService } from "./modules/catalogue/catalogue.service";
import { PricingService } from "./modules/catalogue/pricing.service";
import { CustomersController } from "./modules/customers/customers.controller";
import { CustomersService } from "./modules/customers/customers.service";
import { FinanceController } from "./modules/finance/finance.controller";
import { FinanceService } from "./modules/finance/finance.service";
import { InventoryController } from "./modules/inventory/inventory.controller";
import { InventoryService } from "./modules/inventory/inventory.service";
import { StockLedgerService } from "./modules/inventory/stock-ledger.service";
import { PurchasingController } from "./modules/purchasing/purchasing.controller";
import { PurchasingService } from "./modules/purchasing/purchasing.service";
import { ReportsController } from "./modules/reports/reports.controller";
import { ReportsService } from "./modules/reports/reports.service";
import { PaymentAdapterRegistry, SimulatorMobileMoneyAdapter } from "./modules/sales/payment-adapters";
import { SalesController } from "./modules/sales/sales.controller";
import { SalesService } from "./modules/sales/sales.service";
import { LocalStorageAdapter } from "./modules/system/storage";
import { SystemController } from "./modules/system/system.controller";

export const SERVICES = [
  PrismaService, AuditService, SequenceService, SettingsService, PostingService, ApprovalsService, StockLedgerService, PricingService,
  AuthService, CatalogueService, PurchasingService, InventoryService, SalesService, FinanceService, CustomersService, AccountingService,
  ReportsService, SimulatorMobileMoneyAdapter, PaymentAdapterRegistry, LocalStorageAdapter,
];

@Module({
  imports: [
    JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { algorithm: "HS256" }, verifyOptions: { algorithms: ["HS256"] } }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) }]),
  ],
  controllers: [
    AuthController, CatalogueController, PurchasingController, InventoryController, SalesController, FinanceController, CustomersController,
    AccountingController, ReportsController, AdminController, ApprovalsController, SystemController,
  ],
  providers: [
    ...SERVICES,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: DecimalSerializerInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
