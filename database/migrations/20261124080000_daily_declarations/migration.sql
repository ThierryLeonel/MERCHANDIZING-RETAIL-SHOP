-- Daily balance declarations: staff in the required roles declare, every business day,
-- the money they hold (till, safe, petty cash, mobile money, bank) when they start and
-- when they finish. Declarations are blind (the system balance is not shown to the
-- declarer) and append-only; the system balance at that moment is stored alongside
-- for the variance report.
CREATE TABLE "daily_declarations" (
  "id" UUID NOT NULL,
  "business_id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "business_date" DATE NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "total_declared" DECIMAL(18,2) NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_declarations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daily_declarations_kind_check" CHECK ("kind" IN ('OPENING', 'CLOSING'))
);
CREATE UNIQUE INDEX "daily_declarations_business_id_user_id_business_date_kind_key" ON "daily_declarations"("business_id", "user_id", "business_date", "kind");
CREATE INDEX "daily_declarations_business_id_business_date_idx" ON "daily_declarations"("business_id", "business_date");
ALTER TABLE "daily_declarations" ADD CONSTRAINT "daily_declarations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "daily_declarations" ADD CONSTRAINT "daily_declarations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "daily_declarations" ADD CONSTRAINT "daily_declarations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "daily_declaration_lines" (
  "id" UUID NOT NULL,
  "declaration_id" UUID NOT NULL,
  "financial_account_id" UUID NOT NULL,
  "declared_amount" DECIMAL(18,2) NOT NULL,
  "system_balance" DECIMAL(18,2) NOT NULL,
  CONSTRAINT "daily_declaration_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daily_declaration_lines_amount_check" CHECK ("declared_amount" >= 0)
);
CREATE UNIQUE INDEX "daily_declaration_lines_declaration_id_financial_account_id_key" ON "daily_declaration_lines"("declaration_id", "financial_account_id");
ALTER TABLE "daily_declaration_lines" ADD CONSTRAINT "daily_declaration_lines_declaration_id_fkey" FOREIGN KEY ("declaration_id") REFERENCES "daily_declarations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "daily_declaration_lines" ADD CONSTRAINT "daily_declaration_lines_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER trg_daily_declarations_append_only BEFORE UPDATE OR DELETE ON daily_declarations
  FOR EACH ROW EXECUTE FUNCTION fn_append_only();
CREATE TRIGGER trg_daily_declaration_lines_append_only BEFORE UPDATE OR DELETE ON daily_declaration_lines
  FOR EACH ROW EXECUTE FUNCTION fn_append_only();

INSERT INTO "permissions" ("id", "code", "module", "description", "sensitive") VALUES
  (gen_random_uuid(), 'declarations.view', 'sessions', 'See everyone''s daily opening/closing balance declarations with system balances and variances', true)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."code" = 'declarations.view'
WHERE r."code" IN ('OWNER', 'STORE_MANAGER', 'ACCOUNTANT', 'AUDITOR')
ON CONFLICT DO NOTHING;

-- Sales Person: serves customers on the floor, prepares carts the cashier recalls and takes payment for.
INSERT INTO "roles" ("id", "business_id", "code", "name", "description", "is_system")
SELECT gen_random_uuid(), b."id", 'SALES_PERSON', 'Sales Person', 'Serves customers, looks up products and stock, prepares carts for the cashier', true
FROM "businesses" b
ON CONFLICT ("business_id", "code") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r
  JOIN "permissions" p ON p."code" IN ('dashboard.view', 'pos.hold', 'products.view', 'inventory.view', 'customers.view')
 WHERE r."code" = 'SALES_PERSON'
ON CONFLICT DO NOTHING;
