-- Opening balances: one document per batch, posted as a single journal; customer
-- balances become open items that later payments settle; supplier balances are
-- recorded as opening supplier invoices.
CREATE TABLE "opening_balances" (
  "id" UUID NOT NULL,
  "business_id" UUID NOT NULL,
  "number" VARCHAR(32) NOT NULL,
  "as_of_date" DATE NOT NULL,
  "status" "DocumentStatus" NOT NULL DEFAULT 'POSTED',
  "notes" TEXT,
  "total_debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "equity_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "journal_entry_id" UUID,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voided_at" TIMESTAMPTZ(6),
  "voided_by_id" UUID,
  "void_reason" TEXT,
  CONSTRAINT "opening_balances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "opening_balances_business_id_number_key" ON "opening_balances"("business_id", "number");
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opening_balances" ADD CONSTRAINT "opening_balances_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "customer_opening_items" (
  "id" UUID NOT NULL,
  "business_id" UUID NOT NULL,
  "opening_balance_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "reference" TEXT,
  "item_date" DATE NOT NULL,
  "due_date" DATE NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "settled" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "voided" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_opening_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_opening_items_settled_check" CHECK ("settled" >= 0 AND "settled" <= "amount" AND "amount" > 0)
);
CREATE INDEX "customer_opening_items_customer_id_idx" ON "customer_opening_items"("customer_id");
ALTER TABLE "customer_opening_items" ADD CONSTRAINT "customer_opening_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_opening_items" ADD CONSTRAINT "customer_opening_items_opening_balance_id_fkey" FOREIGN KEY ("opening_balance_id") REFERENCES "opening_balances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_opening_items" ADD CONSTRAINT "customer_opening_items_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "customer_opening_allocations" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "opening_item_id" UUID NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_opening_allocations_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "customer_opening_allocations" ADD CONSTRAINT "customer_opening_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_opening_allocations" ADD CONSTRAINT "customer_opening_allocations_opening_item_id_fkey" FOREIGN KEY ("opening_item_id") REFERENCES "customer_opening_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_invoices" ADD COLUMN "opening_balance_id" UUID;
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_opening_balance_id_fkey" FOREIGN KEY ("opening_balance_id") REFERENCES "opening_balances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "permissions" ("id", "code", "module", "description", "sensitive") VALUES
  (gen_random_uuid(), 'accounting.opening_balances', 'accounting', 'Enter opening balances (cash, bank, customers, suppliers, other accounts) when starting the system', true)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."code" = 'accounting.opening_balances'
WHERE r."code" IN ('OWNER', 'SYSTEM_ADMIN')
ON CONFLICT DO NOTHING;
