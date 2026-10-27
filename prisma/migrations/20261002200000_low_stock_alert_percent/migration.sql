-- Additive setting only. No stock, ledger, recipe or order row is read or rewritten.
ALTER TABLE "CafeSettings"
  ADD COLUMN "lowStockAlertPercent" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "CafeSettings" ADD CONSTRAINT "CafeSettings_lowStockAlertPercent_range"
  CHECK ("lowStockAlertPercent" BETWEEN 0 AND 90);
