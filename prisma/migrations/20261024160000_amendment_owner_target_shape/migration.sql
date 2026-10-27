ALTER TABLE "OwnerActionRequest" DROP CONSTRAINT "OwnerActionRequest_target_shape_check";
ALTER TABLE "OwnerActionRequest" ADD CONSTRAINT "OwnerActionRequest_target_shape_check" CHECK (
  ("action" IN ('CANCEL_ORDER','REFUND_ORDER') AND "targetOrderId" IS NOT NULL AND "targetOrderItemId" IS NULL AND "targetPaymentId" IS NULL AND "targetAmendmentId" IS NULL) OR
  ("action"='VOID_ORDER_ITEM' AND "targetOrderId" IS NOT NULL AND "targetOrderItemId" IS NOT NULL AND "targetPaymentId" IS NULL AND "targetAmendmentId" IS NULL) OR
  ("action"='REFUND_PAYMENT' AND "targetPaymentId" IS NOT NULL AND "targetOrderItemId" IS NULL AND "targetAmendmentId" IS NULL) OR
  ("action" IN ('AMEND_ORDER_REFUND','AMEND_ORDER_VOID') AND "targetOrderId" IS NOT NULL AND "targetOrderItemId" IS NULL AND "targetPaymentId" IS NULL AND "targetAmendmentId" IS NOT NULL)
);
ALTER TABLE "OwnerActionRequest" ADD CONSTRAINT "OwnerActionRequest_amendment_fkey" FOREIGN KEY ("targetAmendmentId") REFERENCES "OrderAmendment"("id") ON DELETE RESTRICT;
