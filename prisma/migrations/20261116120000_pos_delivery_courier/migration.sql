ALTER TABLE "User" ADD COLUMN "isDeliveryCourier" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Order" ADD COLUMN "deliveryCourierId" TEXT;

CREATE INDEX "Order_deliveryCourierId_idx" ON "Order"("deliveryCourierId");

ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryCourierId_fkey"
  FOREIGN KEY ("deliveryCourierId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
