-- Immutable SERVED accountability snapshot. Columns remain nullable solely
-- for historical orders created before M14; this migration intentionally has
-- no data mutation or backfill.
ALTER TABLE "Order"
  ADD COLUMN "servedById" TEXT,
  ADD COLUMN "servedStockCustodyPeriodId" TEXT,
  ADD COLUMN "servedShiftId" TEXT;

CREATE INDEX "Order_servedById_idx" ON "Order"("servedById");
CREATE INDEX "Order_servedStockCustodyPeriodId_idx" ON "Order"("servedStockCustodyPeriodId");
CREATE INDEX "Order_servedShiftId_idx" ON "Order"("servedShiftId");

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_servedById_fkey"
    FOREIGN KEY ("servedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Order_servedStockCustodyPeriodId_fkey"
    FOREIGN KEY ("servedStockCustodyPeriodId") REFERENCES "CustodyPeriod"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Order_servedShiftId_fkey"
    FOREIGN KEY ("servedShiftId") REFERENCES "Shift"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
