-- Products and categories are added, edited, deactivated and deleted only by the
-- Owner and the System Administrator. The built-in Store Manager role loses
-- products.manage (managers keep price management, receiving, counts and transfers).
-- The System Administrator can also set up starting stock: post opening stock,
-- set selling prices, see buying prices and import product lists.
DELETE FROM "role_permissions" rp
 USING "roles" r, "permissions" p
 WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
   AND p."code" = 'products.manage'
   AND r."is_system" AND r."code" NOT IN ('OWNER', 'SYSTEM_ADMIN');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r
  JOIN "permissions" p ON p."code" IN ('products.manage', 'inventory.opening', 'prices.manage', 'products.view_cost', 'data.import', 'inventory.view')
 WHERE r."code" = 'SYSTEM_ADMIN'
ON CONFLICT DO NOTHING;
