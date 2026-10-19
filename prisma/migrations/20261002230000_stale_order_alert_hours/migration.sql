-- Additive setting only. No order or payment row is read or rewritten.
ALTER TABLE "CafeSettings"
  ADD COLUMN "staleOrderAlertHours" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "CafeSettings" ADD CONSTRAINT "CafeSettings_staleOrderAlertHours_range"
  CHECK ("staleOrderAlertHours" BETWEEN 0 AND 48);
