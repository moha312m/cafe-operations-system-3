ALTER TABLE "OrderItem"
  DROP CONSTRAINT "OrderItem_voidApprovalRequestId_fkey";

ALTER TABLE "OrderItem"
  ADD CONSTRAINT "OrderItem_voidApprovalRequestId_fkey"
  FOREIGN KEY ("voidApprovalRequestId") REFERENCES "OwnerActionRequest"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;