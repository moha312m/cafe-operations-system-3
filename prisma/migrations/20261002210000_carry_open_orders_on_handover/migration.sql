-- Additive only. The setting defaults to false, so every existing café keeps
-- today's behaviour (a handover close is refused while orders are open) until
-- its owner turns it on. No order, payment, stock or ledger row is rewritten.
ALTER TABLE "CafeSettings"
  ADD COLUMN "carryOpenOrdersOnHandover" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "HandoverCarriedOrder" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "handoverId" TEXT,
    "orderId" TEXT NOT NULL,
    "orderNumber" INTEGER NOT NULL,
    "statusAtHandover" "OrderStatus" NOT NULL,
    "paymentStatusAtHandover" "PaymentStatus" NOT NULL,
    "remainingAtHandover" DECIMAL(10,2) NOT NULL,
    "stockDeductedAtHandover" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandoverCarriedOrder_pkey" PRIMARY KEY ("id")
);

-- Only open orders are ever carried, and only an order that was being made can
-- have had its recipe deducted at the handover.
ALTER TABLE "HandoverCarriedOrder" ADD CONSTRAINT "HandoverCarriedOrder_status_open"
  CHECK ("statusAtHandover"::text IN ('PENDING_WAITER_APPROVAL', 'CONFIRMED', 'PREPARING', 'READY'));
ALTER TABLE "HandoverCarriedOrder" ADD CONSTRAINT "HandoverCarriedOrder_deduction_only_when_made"
  CHECK (NOT "stockDeductedAtHandover" OR "statusAtHandover"::text IN ('PREPARING', 'READY'));

CREATE INDEX "HandoverCarriedOrder_cafeId_idx" ON "HandoverCarriedOrder"("cafeId");
CREATE INDEX "HandoverCarriedOrder_branchId_createdAt_idx" ON "HandoverCarriedOrder"("branchId", "createdAt");
CREATE INDEX "HandoverCarriedOrder_handoverId_idx" ON "HandoverCarriedOrder"("handoverId");
CREATE INDEX "HandoverCarriedOrder_orderId_idx" ON "HandoverCarriedOrder"("orderId");
CREATE UNIQUE INDEX "HandoverCarriedOrder_shiftId_orderId_key" ON "HandoverCarriedOrder"("shiftId", "orderId");

ALTER TABLE "HandoverCarriedOrder" ADD CONSTRAINT "HandoverCarriedOrder_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoverCarriedOrder" ADD CONSTRAINT "HandoverCarriedOrder_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoverCarriedOrder" ADD CONSTRAINT "HandoverCarriedOrder_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandoverCarriedOrder" ADD CONSTRAINT "HandoverCarriedOrder_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "HandoverSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandoverCarriedOrder" ADD CONSTRAINT "HandoverCarriedOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
