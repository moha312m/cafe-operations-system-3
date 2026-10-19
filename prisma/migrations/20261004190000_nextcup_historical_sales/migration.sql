ALTER TABLE "Product" ADD COLUMN "sku" TEXT;
CREATE UNIQUE INDEX "Product_cafeId_sku_key" ON "Product"("cafeId", "sku");

CREATE TABLE "HistoricalSaleLine" (
    "id" TEXT NOT NULL,
    "cafeId" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "saleLocalDate" TEXT NOT NULL,
    "saleDate" TEXT NOT NULL,
    "saleMonth" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "quantityUnit" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL,
    "tax" DECIMAL(12,2) NOT NULL,
    "priceIncTax" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "paymentMethod" TEXT,
    "customerName" TEXT,
    "contactId" TEXT,
    "contactNumber" TEXT,
    "email" TEXT,
    "location" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HistoricalSaleLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HistoricalSaleLine_cafeId_sourceHash_sourceRow_key" ON "HistoricalSaleLine"("cafeId", "sourceHash", "sourceRow");
CREATE INDEX "HistoricalSaleLine_cafeId_saleDate_idx" ON "HistoricalSaleLine"("cafeId", "saleDate");
CREATE INDEX "HistoricalSaleLine_cafeId_saleMonth_idx" ON "HistoricalSaleLine"("cafeId", "saleMonth");
CREATE INDEX "HistoricalSaleLine_cafeId_sku_idx" ON "HistoricalSaleLine"("cafeId", "sku");
ALTER TABLE "HistoricalSaleLine" ADD CONSTRAINT "HistoricalSaleLine_cafeId_fkey" FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
