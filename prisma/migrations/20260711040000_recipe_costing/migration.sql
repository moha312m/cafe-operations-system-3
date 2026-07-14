-- Recipe costing, product cost, and automatic stock deduction.

ALTER TABLE "Cafe" ADD COLUMN "allowNegativeStock" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "stockDeductedAt" TIMESTAMP(3);
ALTER TABLE "InventoryTransaction" ADD COLUMN "orderId" TEXT;

ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "InventoryTransaction_orderId_idx" ON "InventoryTransaction"("orderId");

-- وصفة المنتج
CREATE TABLE "ProductRecipeItem" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" "InventoryUnit" NOT NULL,
    "wastePercentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductRecipeItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProductRecipeItem" ADD CONSTRAINT "ProductRecipeItem_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductRecipeItem" ADD CONSTRAINT "ProductRecipeItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductRecipeItem" ADD CONSTRAINT "ProductRecipeItem_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ProductRecipeItem_productId_inventoryItemId_key" ON "ProductRecipeItem"("productId", "inventoryItemId");
CREATE INDEX "ProductRecipeItem_cafeId_idx" ON "ProductRecipeItem"("cafeId");
CREATE INDEX "ProductRecipeItem_productId_idx" ON "ProductRecipeItem"("productId");
CREATE INDEX "ProductRecipeItem_inventoryItemId_idx" ON "ProductRecipeItem"("inventoryItemId");
