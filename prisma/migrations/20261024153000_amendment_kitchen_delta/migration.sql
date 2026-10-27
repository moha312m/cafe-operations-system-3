ALTER TABLE "OrderAmendment" ADD COLUMN "kitchenStatus" TEXT, ADD COLUMN "stockPlan" JSONB;
ALTER TABLE "OrderAmendment" ADD CONSTRAINT "OrderAmendment_kitchen_status" CHECK ("kitchenStatus" IS NULL OR "kitchenStatus" IN ('PENDING','SERVED'));
