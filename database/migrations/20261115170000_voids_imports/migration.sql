-- Voiding posted transactions (records are kept; reversing entries are posted)
-- and spreadsheet imports. New permissions are granted to every Owner role.
ALTER TABLE "sales" ADD COLUMN "voided_at" TIMESTAMPTZ(6), ADD COLUMN "voided_by_id" UUID, ADD COLUMN "void_reason" TEXT, ADD COLUMN "void_return_id" UUID;
ALTER TABLE "expenses" ADD COLUMN "voided_at" TIMESTAMPTZ(6), ADD COLUMN "voided_by_id" UUID, ADD COLUMN "void_reason" TEXT;
ALTER TABLE "supplier_payments" ADD COLUMN "voided_at" TIMESTAMPTZ(6), ADD COLUMN "voided_by_id" UUID, ADD COLUMN "void_reason" TEXT;
ALTER TABLE "payments" ADD COLUMN "voided_at" TIMESTAMPTZ(6), ADD COLUMN "voided_by_id" UUID, ADD COLUMN "void_reason" TEXT;

INSERT INTO "permissions" ("id", "code", "module", "description", "sensitive") VALUES
  (gen_random_uuid(), 'transactions.void', 'admin', 'Void sales, expenses and payments (posts reversing entries; records are kept)', true),
  (gen_random_uuid(), 'data.import', 'admin', 'Import products, opening stock and customers from spreadsheets', true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."code" IN ('transactions.void', 'data.import')
WHERE r."code" = 'OWNER'
ON CONFLICT DO NOTHING;

ALTER TABLE "sales" ADD CONSTRAINT "sales_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_void_return_id_fkey" FOREIGN KEY ("void_return_id") REFERENCES "sales_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
