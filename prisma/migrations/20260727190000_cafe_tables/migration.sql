-- Table setup (configured tables) + custom-table workflow switch.

-- AlterTable
ALTER TABLE "CafeSettings" ADD COLUMN "allowCustomTables" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CafeTable" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableNumber" TEXT NOT NULL,
    "displayName" TEXT,
    "area" TEXT,
    "seatsCount" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CafeTable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CafeTable_cafeId_idx" ON "CafeTable"("cafeId");
CREATE INDEX "CafeTable_branchId_idx" ON "CafeTable"("branchId");
CREATE INDEX "CafeTable_tableNumber_idx" ON "CafeTable"("tableNumber");
CREATE INDEX "CafeTable_isActive_idx" ON "CafeTable"("isActive");
CREATE INDEX "CafeTable_sortOrder_idx" ON "CafeTable"("sortOrder");
CREATE UNIQUE INDEX "CafeTable_branchId_tableNumber_key" ON "CafeTable"("branchId", "tableNumber");

-- AddForeignKey
ALTER TABLE "CafeTable" ADD CONSTRAINT "CafeTable_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CafeTable" ADD CONSTRAINT "CafeTable_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
