ALTER TABLE "Branch"
  ADD COLUMN "posDefaultOrderType" "OrderType" NOT NULL DEFAULT 'DINE_IN',
  ADD COLUMN "pickupAtCashier" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT "Branch_posDefaultOrderType_check"
    CHECK ("posDefaultOrderType" IN ('DINE_IN', 'TAKEAWAY'));
