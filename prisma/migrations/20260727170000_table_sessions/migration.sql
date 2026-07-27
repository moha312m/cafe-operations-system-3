-- Table sessions + item-level payments.

-- CreateEnum
CREATE TYPE "TableSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "tableSessionId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "tableSessionId" TEXT,
ADD COLUMN "note" TEXT;

-- CreateTable
CREATE TABLE "TableSession" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableNumber" TEXT NOT NULL,
    "status" "TableSessionStatus" NOT NULL DEFAULT 'OPEN',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "totalAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "remainingAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "openedByUserId" TEXT,
    "closedByUserId" TEXT,
    "customerName" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TableSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemPayment" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "tableSessionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "quantityPaid" INTEGER NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItemPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TableSession_cafeId_idx" ON "TableSession"("cafeId");
CREATE INDEX "TableSession_branchId_status_idx" ON "TableSession"("branchId", "status");
CREATE INDEX "TableSession_tableNumber_idx" ON "TableSession"("tableNumber");
CREATE INDEX "TableSession_status_idx" ON "TableSession"("status");
CREATE INDEX "TableSession_startedAt_idx" ON "TableSession"("startedAt");
CREATE INDEX "OrderItemPayment_cafeId_idx" ON "OrderItemPayment"("cafeId");
CREATE INDEX "OrderItemPayment_branchId_idx" ON "OrderItemPayment"("branchId");
CREATE INDEX "OrderItemPayment_tableSessionId_idx" ON "OrderItemPayment"("tableSessionId");
CREATE INDEX "OrderItemPayment_orderId_idx" ON "OrderItemPayment"("orderId");
CREATE INDEX "OrderItemPayment_orderItemId_idx" ON "OrderItemPayment"("orderItemId");
CREATE INDEX "OrderItemPayment_paymentId_idx" ON "OrderItemPayment"("paymentId");
CREATE INDEX "Order_tableSessionId_idx" ON "Order"("tableSessionId");
CREATE INDEX "Payment_tableSessionId_idx" ON "Payment"("tableSessionId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemPayment" ADD CONSTRAINT "OrderItemPayment_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemPayment" ADD CONSTRAINT "OrderItemPayment_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemPayment" ADD CONSTRAINT "OrderItemPayment_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
