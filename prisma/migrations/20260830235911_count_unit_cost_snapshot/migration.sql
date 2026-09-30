ALTER TABLE "StockCountLine"
  ADD COLUMN "unitCostSnapshot" DECIMAL(12,2),
  ADD COLUMN "unitCostSource" TEXT,
  ADD COLUMN "unitCostCapturedAt" TIMESTAMP(3);
