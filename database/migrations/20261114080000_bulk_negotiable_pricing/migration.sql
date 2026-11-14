-- Bulk / loose goods (stocked and sold by quantity, not item by item) and
-- negotiable ("bargain") pricing with a hard minimum price floor.
ALTER TYPE "ProductType" ADD VALUE IF NOT EXISTS 'BULK';

ALTER TABLE "products" ADD COLUMN "negotiable_price" BOOLEAN NOT NULL DEFAULT false;
