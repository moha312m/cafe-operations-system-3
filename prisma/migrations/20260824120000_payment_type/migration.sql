-- REFUND-001: give a payment row an explicit financial meaning.
--
-- Reversals were previously recorded as a collection carrying a negative
-- amount, so every report that summed `amount` counted returned money as
-- sales. Meaning moves off the sign and onto `type`.

CREATE TYPE "PaymentType" AS ENUM ('COLLECTION', 'REFUND');

ALTER TABLE "Payment"
  ADD COLUMN "type" "PaymentType" NOT NULL DEFAULT 'COLLECTION',
  ADD COLUMN "refundReason" TEXT;

-- Classify the existing reversals, then normalise their magnitude. Order
-- matters: the sign is the only way to identify them.
UPDATE "Payment" SET "type" = 'REFUND' WHERE "amount" < 0;
UPDATE "Payment" SET "amount" = ABS("amount") WHERE "amount" < 0;

-- Rows already flipped to REFUNDED in period are left exactly as they are.
-- They are historically correct collections that were reversed within their
-- own shift, and rewriting settled financial history to fit a newer shape
-- would be a worse trade than teaching reporting about both.

CREATE INDEX "Payment_cafeId_type_createdAt_idx" ON "Payment"("cafeId", "type", "createdAt");
CREATE INDEX "Payment_type_idx" ON "Payment"("type");
