-- CreateEnum
CREATE TYPE "ServiceChargeType" AS ENUM ('PERCENTAGE', 'FIXED');
CREATE TYPE "ChargeApplicationScope" AS ENUM ('ALL_ORDERS', 'DINE_IN_ONLY', 'TAKEAWAY_ONLY', 'DELIVERY_ONLY');
-- AlterEnum: new PaymentStatus values (must commit before use)
ALTER TYPE "PaymentStatus" ADD VALUE 'UNPAID';
ALTER TYPE "PaymentStatus" ADD VALUE 'PENDING_COLLECTION';
