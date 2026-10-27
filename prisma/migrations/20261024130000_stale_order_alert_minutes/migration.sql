-- Additive local reminder precision; no existing setting/business rows rewritten.
ALTER TABLE "CafeSettings"
  ADD COLUMN "staleOrderAlertMinutes" INTEGER;
ALTER TABLE "CafeSettings"
  ADD CONSTRAINT "CafeSettings_staleOrderAlertMinutes_range"
  CHECK ("staleOrderAlertMinutes" IS NULL OR "staleOrderAlertMinutes" BETWEEN 0 AND 2880);
