-- Gram-level recipe deductions (e.g. 18g of coffee = 0.018 kg) need more
-- than 2 decimal places on stock quantities. Widen to 3 decimals.

ALTER TABLE "InventoryItem" ALTER COLUMN "currentStock" TYPE DECIMAL(12,3);
ALTER TABLE "InventoryItem" ALTER COLUMN "minimumStock" TYPE DECIMAL(12,3);
ALTER TABLE "InventoryTransaction" ALTER COLUMN "quantity" TYPE DECIMAL(12,3);
