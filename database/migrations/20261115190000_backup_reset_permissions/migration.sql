-- Backup download and "clear the application", granted to every Owner role.
INSERT INTO "permissions" ("id", "code", "module", "description", "sensitive") VALUES
  (gen_random_uuid(), 'admin.backup', 'admin', 'Download a full backup of the application data', true),
  (gen_random_uuid(), 'admin.reset', 'admin', 'Clear the application (delete transactions or all business data)', true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."code" IN ('admin.backup', 'admin.reset')
WHERE r."code" = 'OWNER'
ON CONFLICT DO NOTHING;
