ALTER TABLE "OrderItem"
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidedById" TEXT,
  ADD COLUMN "voidApprovalRequestId" TEXT,
  ADD COLUMN "voidReason" TEXT;

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_voidApprovalRequestId_fkey"
  FOREIGN KEY ("voidApprovalRequestId") REFERENCES "OwnerActionRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "OrderItem_voidApprovalRequestId_key" ON "OrderItem"("voidApprovalRequestId");
CREATE INDEX "OrderItem_voidedById_idx" ON "OrderItem"("voidedById");