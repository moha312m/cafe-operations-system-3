-- The type must agree with the evidence, not merely be accompanied by some.
--
-- T18's "VarianceCase_single_source_check" counts sources: exactly one of the
-- three source columns is set, or the type is CASH. That is necessary and it
-- is not sufficient, and the gap is easy to miss because the constraint looks
-- complete.
--
-- Counting cannot tell a STOCK case holding a TENDER source from a STOCK case
-- holding a stock line. Both have exactly one non-null source column, so both
-- pass. A case could therefore claim to be about a counted shelf while
-- pointing at a card settlement, and every reader downstream -- the API, the
-- export, the investigation screen -- would believe the label rather than the
-- pointer. Six combinations were reachable:
--
--   STOCK + tenderReconciliationId       STOCK + openingExceptionId
--   TENDER + stockCountLineId            TENDER + openingExceptionId
--   OPENING_EXCEPTION + stockCountLineId OPENING_EXCEPTION + tenderReconciliationId
--
-- CASH needed a clause of its own for the opposite reason. It has no source
-- column, so "exactly one source" was satisfied by the type alone -- which
-- let a CASH case exist with a NULL "shiftId", pointing at nothing at all.
-- Cash evidence IS the shift close (T16), so a CASH case without a shift is a
-- case without evidence. "shiftId" stays nullable at the column level because
-- the other three types reach their evidence through their own columns and
-- may legitimately leave it null; the requirement is specific to CASH, so it
-- belongs in a CHECK rather than in the column definition.
--
-- Additive, and alongside T18's constraint rather than replacing it: that
-- migration has been applied and is not edited. The matrix below is strictly
-- narrower than the count, so every row the pair admits satisfies both.
ALTER TABLE "VarianceCase"
  ADD CONSTRAINT "VarianceCase_type_matches_source_check" CHECK (
    CASE "type"
      WHEN 'CASH' THEN
        "shiftId"                IS NOT NULL
        AND "stockCountLineId"       IS NULL
        AND "tenderReconciliationId" IS NULL
        AND "openingExceptionId"     IS NULL
      WHEN 'STOCK' THEN
        "stockCountLineId"       IS NOT NULL
        AND "tenderReconciliationId" IS NULL
        AND "openingExceptionId"     IS NULL
      WHEN 'TENDER' THEN
        "tenderReconciliationId" IS NOT NULL
        AND "stockCountLineId"       IS NULL
        AND "openingExceptionId"     IS NULL
      WHEN 'OPENING_EXCEPTION' THEN
        "openingExceptionId"     IS NOT NULL
        AND "stockCountLineId"       IS NULL
        AND "tenderReconciliationId" IS NULL
    END
  );
