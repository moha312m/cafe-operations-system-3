-- CreateEnum
CREATE TYPE "PurchasePaymentFunding" AS ENUM ('DRAWER', 'SAFE', 'BANK');

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "totalCashPayouts" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchasePayment" ADD COLUMN     "fundingSource" "PurchasePaymentFunding",
ADD COLUMN     "shiftId" TEXT;

-- CreateIndex
CREATE INDEX "PurchasePayment_shiftId_idx" ON "PurchasePayment"("shiftId");

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A drawer payment names its shift, and only a drawer payment does. Cash
-- sources pay in cash; a bank source never does. Legacy rows (NULL source,
-- NULL shift) stay valid.
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_funding_check" CHECK (
  ("shiftId" IS NULL OR "fundingSource" IS NOT DISTINCT FROM 'DRAWER')
  AND ("fundingSource" IS DISTINCT FROM 'DRAWER' OR "shiftId" IS NOT NULL)
  AND ("fundingSource" IS NULL OR "fundingSource" = 'BANK' OR "method" = 'CASH')
  AND ("fundingSource" IS DISTINCT FROM 'BANK' OR "method" <> 'CASH')
);
