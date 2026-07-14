-- QR approval workflow: order sources, waiter approval fields,
-- WAITER role, and the expanded status set.
-- Existing data is mapped: PENDING -> CONFIRMED, COMPLETED -> SERVED.

-- New enum: OrderSource
CREATE TYPE "OrderSource" AS ENUM ('QR_MENU', 'WAITER', 'CASHIER_POS');

-- Add WAITER to Role (not referenced inside this transaction)
ALTER TYPE "Role" ADD VALUE 'WAITER';

-- OrderStatus: replace with the new value set, mapping existing rows
CREATE TYPE "OrderStatus_new" AS ENUM ('PENDING_WAITER_APPROVAL', 'CONFIRMED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED', 'REJECTED');
ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus_new"
  USING (
    CASE "status"::text
      WHEN 'PENDING' THEN 'CONFIRMED'
      WHEN 'COMPLETED' THEN 'SERVED'
      ELSE "status"::text
    END
  )::"OrderStatus_new";
DROP TYPE "OrderStatus";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'CONFIRMED';

-- Order: source + approval/rejection tracking
ALTER TABLE "Order" ADD COLUMN "source" "OrderSource" NOT NULL DEFAULT 'CASHIER_POS';
ALTER TABLE "Order" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "Order" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "rejectedById" TEXT;
ALTER TABLE "Order" ADD COLUMN "rejectedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "rejectionReason" TEXT;

-- QR menu orders have no creating user
ALTER TABLE "Order" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "Order" DROP CONSTRAINT "Order_createdById_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Order" ADD CONSTRAINT "Order_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "Order_cafeId_status_idx" ON "Order"("cafeId", "status");
CREATE INDEX "Order_cafeId_source_createdAt_idx" ON "Order"("cafeId", "source", "createdAt");
