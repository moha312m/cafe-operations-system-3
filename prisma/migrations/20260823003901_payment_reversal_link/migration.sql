-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "reversalOfPaymentId" TEXT;

-- CreateIndex
CREATE INDEX "Payment_reversalOfPaymentId_idx" ON "Payment"("reversalOfPaymentId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reversalOfPaymentId_fkey" FOREIGN KEY ("reversalOfPaymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
