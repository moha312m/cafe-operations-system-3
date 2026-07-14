-- Kitchen/barista display: preparation timeline on orders and
-- item-level kitchen status (prepared for later use).

CREATE TYPE "KitchenStatus" AS ENUM ('NEW', 'PREPARING', 'READY', 'SERVED', 'CANCELLED');

ALTER TABLE "Order" ADD COLUMN "preparationStartedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "readyAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "servedAt" TIMESTAMP(3);

ALTER TABLE "OrderItem" ADD COLUMN "kitchenStatus" "KitchenStatus" NOT NULL DEFAULT 'NEW';
