-- Manager pricing system: cost price, POS visibility, category customer
-- visibility, absolute variant prices (migrated from deltas), and
-- per-branch price overrides.

ALTER TABLE "MenuCategory" ADD COLUMN "showInCustomerMenu" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Product" ADD COLUMN "costPrice" DECIMAL(10,2);
ALTER TABLE "Product" ADD COLUMN "showInPOS" BOOLEAN NOT NULL DEFAULT true;

-- Variants move from priceDelta (relative) to price (absolute).
ALTER TABLE "ProductVariant" ADD COLUMN "price" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "ProductVariant" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
UPDATE "ProductVariant" v
SET "price" = p."basePrice" + v."priceDelta"
FROM "Product" p
WHERE p."id" = v."productId";
ALTER TABLE "ProductVariant" DROP COLUMN "priceDelta";

-- Per-branch base price override.
CREATE TABLE "ProductBranchPrice" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    CONSTRAINT "ProductBranchPrice_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ProductBranchPrice" ADD CONSTRAINT "ProductBranchPrice_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductBranchPrice" ADD CONSTRAINT "ProductBranchPrice_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ProductBranchPrice_productId_branchId_key" ON "ProductBranchPrice"("productId", "branchId");
CREATE INDEX "ProductBranchPrice_branchId_idx" ON "ProductBranchPrice"("branchId");

-- Query-path indexes
CREATE INDEX "Product_cafeId_isAvailable_idx" ON "Product"("cafeId", "isAvailable");
CREATE INDEX "Product_cafeId_showInCustomerMenu_idx" ON "Product"("cafeId", "showInCustomerMenu");
CREATE INDEX "Product_cafeId_showInPOS_idx" ON "Product"("cafeId", "showInPOS");
CREATE INDEX "Product_cafeId_sortOrder_idx" ON "Product"("cafeId", "sortOrder");
