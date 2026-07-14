-- Inventory & ingredients module: enums, extended InventoryItem, and the
-- InventoryTransaction ledger. The old InventoryItem was empty in all
-- environments, so column renames/type changes are safe.

CREATE TYPE "InventoryUnit" AS ENUM ('GRAM', 'KG', 'ML', 'LITER', 'PIECE', 'BOX', 'BAG');
CREATE TYPE "InventoryTransactionType" AS ENUM ('PURCHASE', 'USAGE', 'WASTE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN');

-- ── Extend InventoryItem ──
-- Drop the old free-text unit and re-add as an enum (no data to preserve).
ALTER TABLE "InventoryItem" DROP COLUMN "unit";
ALTER TABLE "InventoryItem" ADD COLUMN "unit" "InventoryUnit" NOT NULL DEFAULT 'PIECE';
ALTER TABLE "InventoryItem" RENAME COLUMN "quantity" TO "currentStock";
ALTER TABLE "InventoryItem" RENAME COLUMN "lowStockThreshold" TO "minimumStock";
ALTER TABLE "InventoryItem" ALTER COLUMN "currentStock" TYPE DECIMAL(12,2);
ALTER TABLE "InventoryItem" ALTER COLUMN "minimumStock" TYPE DECIMAL(12,2);
ALTER TABLE "InventoryItem" ADD COLUMN "category" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN "costPerUnit" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "InventoryItem" ADD COLUMN "supplierName" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN "expiryDate" TIMESTAMP(3);
ALTER TABLE "InventoryItem" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "InventoryItem" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "InventoryItem" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "InventoryItem_cafeId_isActive_idx" ON "InventoryItem"("cafeId", "isActive");
CREATE INDEX "InventoryItem_currentStock_idx" ON "InventoryItem"("currentStock");
CREATE INDEX "InventoryItem_minimumStock_idx" ON "InventoryItem"("minimumStock");

-- ── InventoryTransaction ledger ──
CREATE TABLE "InventoryTransaction" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "type" "InventoryTransactionType" NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(12,2),
    "totalCost" DECIMAL(12,2),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryTransaction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "InventoryTransaction_cafeId_idx" ON "InventoryTransaction"("cafeId");
CREATE INDEX "InventoryTransaction_branchId_idx" ON "InventoryTransaction"("branchId");
CREATE INDEX "InventoryTransaction_inventoryItemId_idx" ON "InventoryTransaction"("inventoryItemId");
CREATE INDEX "InventoryTransaction_type_idx" ON "InventoryTransaction"("type");
CREATE INDEX "InventoryTransaction_createdAt_idx" ON "InventoryTransaction"("createdAt");
CREATE INDEX "InventoryTransaction_cafeId_createdAt_idx" ON "InventoryTransaction"("cafeId", "createdAt");
