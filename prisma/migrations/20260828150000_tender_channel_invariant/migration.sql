-- Tender is not a fourth settlement channel alongside the three payment
-- methods. It is two of them.
--
-- CASH already has a single source of truth: the Shift cash reconciliation
-- at close. A ToleranceRule scoped TENDER/CASH is therefore legitimate — it
-- is the BOUND that path compares against — but it must never become the
-- configuration for a second, independent cash actual/variance record.
--
-- MIXED is not a channel at all. It marks an order that was settled across
-- more than one method, and every one of those settlements is already
-- recorded as its own Payment row under its own real method. Reconciling
-- "MIXED" would count the same money a second time under a label no
-- processor ever settles.
--
-- So: a TENDER-scoped rule names exactly one real method and never MIXED,
-- and a rule at any other scope names no method at all. The service layer
-- refuses these combinations with a readable message; this constraint is the
-- backstop for anything that reaches the table another way.
ALTER TABLE "ToleranceRule"
  ADD CONSTRAINT "ToleranceRule_tender_scope_method_valid"
  CHECK (
    ("scope" = 'TENDER' AND "tenderMethod" IS NOT NULL AND "tenderMethod" <> 'MIXED')
    OR
    ("scope" <> 'TENDER' AND "tenderMethod" IS NULL)
  );
