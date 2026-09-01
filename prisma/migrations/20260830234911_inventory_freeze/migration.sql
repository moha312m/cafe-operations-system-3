-- A durable stock-write boundary owned by one handover. Existing cafes get
-- no row: a freeze is operational state, never historical data to fabricate.
CREATE TABLE "InventoryFreeze" (
  "id"           TEXT NOT NULL,
  "cafeId"       TEXT NOT NULL,
  "branchId"     TEXT NOT NULL,
  "handoverId"   TEXT NOT NULL,
  "startedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedById"  TEXT NOT NULL,
  "releasedAt"   TIMESTAMP(3),
  "releasedById" TEXT,

  CONSTRAINT "InventoryFreeze_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryFreeze_release_pair_consistent"
    CHECK (
      ("releasedAt" IS NULL AND "releasedById" IS NULL)
      OR
      ("releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "InventoryFreeze_handoverId_key"
  ON "InventoryFreeze"("handoverId");
CREATE INDEX "InventoryFreeze_cafeId_startedAt_idx"
  ON "InventoryFreeze"("cafeId", "startedAt");
CREATE INDEX "InventoryFreeze_branchId_startedAt_idx"
  ON "InventoryFreeze"("branchId", "startedAt");
CREATE INDEX "InventoryFreeze_startedById_idx"
  ON "InventoryFreeze"("startedById");
CREATE INDEX "InventoryFreeze_releasedById_idx"
  ON "InventoryFreeze"("releasedById");

CREATE UNIQUE INDEX "InventoryFreeze_one_active_per_branch"
  ON "InventoryFreeze"("branchId")
  WHERE "releasedAt" IS NULL;

ALTER TABLE "InventoryFreeze"
  ADD CONSTRAINT "InventoryFreeze_cafeId_fkey"
  FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryFreeze"
  ADD CONSTRAINT "InventoryFreeze_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryFreeze"
  ADD CONSTRAINT "InventoryFreeze_handoverId_fkey"
  FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryFreeze"
  ADD CONSTRAINT "InventoryFreeze_startedById_fkey"
  FOREIGN KEY ("startedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryFreeze"
  ADD CONSTRAINT "InventoryFreeze_releasedById_fkey"
  FOREIGN KEY ("releasedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
