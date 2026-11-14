-- Units commonly used for bulk / loose goods, added to every existing business
-- (new businesses get them from setup). Existing codes are left untouched.
INSERT INTO "units" ("id", "business_id", "code", "name")
SELECT gen_random_uuid(), b."id", u.code, u.name
FROM "businesses" b
CROSS JOIN (VALUES ('KG', 'Kilogram'), ('L', 'Litre'), ('M', 'Metre'), ('BAG', 'Bag'), ('BALE', 'Bale'), ('HEAP', 'Heap')) AS u(code, name)
ON CONFLICT ("business_id", "code") DO NOTHING;
