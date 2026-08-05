-- Suppliers & purchase invoices module.

-- CreateEnum
CREATE TYPE "PurchaseInvoiceStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');
CREATE TYPE "PurchasePaymentStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID');
CREATE TYPE "PurchasePaymentMethod" AS ENUM ('CASH', 'CARD', 'WALLET', 'BANK_TRANSFER');

-- AlterTable
ALTER TABLE "CafeSettings" ADD COLUMN "purchasesEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseInvoice" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "supplierId" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "PurchaseInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "subtotalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "remainingAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paymentStatus" "PurchasePaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseInvoiceItem" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "purchaseInvoiceId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" "InventoryUnit" NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchasePayment" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "purchaseInvoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PurchasePaymentMethod" NOT NULL DEFAULT 'CASH',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchasePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supplier_cafeId_idx" ON "Supplier"("cafeId");
CREATE INDEX "Supplier_cafeId_isActive_idx" ON "Supplier"("cafeId", "isActive");
CREATE INDEX "PurchaseInvoice_cafeId_idx" ON "PurchaseInvoice"("cafeId");
CREATE INDEX "PurchaseInvoice_branchId_idx" ON "PurchaseInvoice"("branchId");
CREATE INDEX "PurchaseInvoice_supplierId_idx" ON "PurchaseInvoice"("supplierId");
CREATE INDEX "PurchaseInvoice_cafeId_invoiceDate_idx" ON "PurchaseInvoice"("cafeId", "invoiceDate");
CREATE INDEX "PurchaseInvoice_status_idx" ON "PurchaseInvoice"("status");
CREATE INDEX "PurchaseInvoice_paymentStatus_idx" ON "PurchaseInvoice"("paymentStatus");
CREATE UNIQUE INDEX "PurchaseInvoice_branchId_invoiceNumber_key" ON "PurchaseInvoice"("branchId", "invoiceNumber");
CREATE INDEX "PurchaseInvoiceItem_cafeId_idx" ON "PurchaseInvoiceItem"("cafeId");
CREATE INDEX "PurchaseInvoiceItem_branchId_idx" ON "PurchaseInvoiceItem"("branchId");
CREATE INDEX "PurchaseInvoiceItem_purchaseInvoiceId_idx" ON "PurchaseInvoiceItem"("purchaseInvoiceId");
CREATE INDEX "PurchaseInvoiceItem_inventoryItemId_idx" ON "PurchaseInvoiceItem"("inventoryItemId");
CREATE INDEX "PurchasePayment_cafeId_idx" ON "PurchasePayment"("cafeId");
CREATE INDEX "PurchasePayment_branchId_idx" ON "PurchasePayment"("branchId");
CREATE INDEX "PurchasePayment_purchaseInvoiceId_idx" ON "PurchasePayment"("purchaseInvoiceId");
CREATE INDEX "PurchasePayment_cafeId_paidAt_idx" ON "PurchasePayment"("cafeId", "paidAt");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseInvoice" ADD CONSTRAINT "PurchaseInvoice_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseInvoice" ADD CONSTRAINT "PurchaseInvoice_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseInvoice" ADD CONSTRAINT "PurchaseInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseInvoice" ADD CONSTRAINT "PurchaseInvoice_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PurchaseInvoiceItem" ADD CONSTRAINT "PurchaseInvoiceItem_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "PurchaseInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseInvoiceItem" ADD CONSTRAINT "PurchaseInvoiceItem_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "PurchaseInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
