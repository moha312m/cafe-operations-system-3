-- A recorded handover cash difference may remain unexplained for later review.
-- Existing reason references and all observation/case rows are preserved.
ALTER TABLE "OpeningException" ALTER COLUMN "reasonCodeId" DROP NOT NULL;

-- Keep other opening-exception kinds reasoned. CASH_MISMATCH service paths
-- outside ordinary handover retain their own existing reason validation.
ALTER TABLE "OpeningException" ADD CONSTRAINT "OpeningException_other_kinds_reason_check"
  CHECK ("reasonCodeId" IS NOT NULL OR "kind" = 'CASH_MISMATCH');
