-- OWNER-UAT-RESALE-001: approved additive migration. Apply only to verified disposable clone.
-- Preserve SQL-only checks, partial indexes and historical immutability triggers.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE TYPE "ProductStockMode" AS ENUM ('RECIPE', 'FINISHED_GOOD');
ALTER TABLE "Product" ADD COLUMN "stockMode" "ProductStockMode" NOT NULL DEFAULT 'RECIPE';
ALTER TABLE "CafeSettings" ADD COLUMN "finishedGoodsSalesEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Product_sale_identity_key" ON "Product" ("id", "cafeId");
CREATE UNIQUE INDEX "ProductVariant_sale_identity_key" ON "ProductVariant" ("id", "productId");
CREATE UNIQUE INDEX "Branch_sale_identity_key" ON "Branch" ("id", "cafeId");
CREATE UNIQUE INDEX "Order_sale_identity_key" ON "Order" ("id", "cafeId", "branchId");
CREATE UNIQUE INDEX "InventoryItem_sale_identity_key" ON "InventoryItem" ("id", "cafeId", "branchId", "unit");
CREATE UNIQUE INDEX "InventoryTransaction_sale_identity_key" ON "InventoryTransaction" ("id", "cafeId", "branchId", "inventoryItemId", "orderId");
CREATE UNIQUE INDEX "InventoryFreeze_sale_identity_key" ON "InventoryFreeze" ("id", "handoverId", "cafeId", "branchId");

-- Existing independent cafe/branch FKs remain; this additional FK closes their mismatch gap.
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_sale_branch_fkey"
  FOREIGN KEY ("branchId", "cafeId") REFERENCES "Branch" ("id", "cafeId")
  ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TABLE "ProductStockBinding" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "inventoryItemId" TEXT NOT NULL,
  "unit" "InventoryUnit" NOT NULL DEFAULT 'PIECE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductStockBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductStockBinding_piece_check" CHECK ("unit" = 'PIECE'),
  CONSTRAINT "ProductStockBinding_product_fkey" FOREIGN KEY ("productId", "cafeId")
    REFERENCES "Product" ("id", "cafeId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "ProductStockBinding_variant_fkey" FOREIGN KEY ("variantId", "productId")
    REFERENCES "ProductVariant" ("id", "productId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "ProductStockBinding_branch_fkey" FOREIGN KEY ("branchId", "cafeId")
    REFERENCES "Branch" ("id", "cafeId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProductStockBinding_inventory_fkey" FOREIGN KEY ("inventoryItemId", "cafeId", "branchId", "unit")
    REFERENCES "InventoryItem" ("id", "cafeId", "branchId", "unit") ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- Prisma cannot express these partial uniques. NULL means the exact unvaried configuration.
CREATE UNIQUE INDEX "ProductStockBinding_base_key" ON "ProductStockBinding" ("cafeId", "branchId", "productId") WHERE "variantId" IS NULL;
CREATE UNIQUE INDEX "ProductStockBinding_variant_key" ON "ProductStockBinding" ("cafeId", "branchId", "productId", "variantId") WHERE "variantId" IS NOT NULL;
CREATE INDEX "ProductStockBinding_inventory_idx" ON "ProductStockBinding" ("inventoryItemId");
CREATE INDEX "ProductStockBinding_variant_idx" ON "ProductStockBinding" ("variantId", "productId");
CREATE INDEX "ProductStockBinding_branch_idx" ON "ProductStockBinding" ("branchId", "cafeId");

ALTER TABLE "OrderItem"
  ADD COLUMN "stockModeSnapshot" "ProductStockMode",
  ADD COLUMN "stockAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "stockProductIdSnapshot" TEXT,
  ADD COLUMN "stockVariantIdSnapshot" TEXT,
  ADD COLUMN "finishedStockCafeId" TEXT,
  ADD COLUMN "finishedStockBranchId" TEXT,
  ADD COLUMN "finishedStockItemId" TEXT,
  ADD COLUMN "finishedStockUnit" "InventoryUnit",
  ADD COLUMN "finishedStockQuantity" INTEGER,
  ADD COLUMN "finishedStockDeductedAt" TIMESTAMP(3),
  ADD COLUMN "finishedStockTransactionId" TEXT;
-- There is deliberately NO snapshot backfill and NO deduction backfill.
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sale_snapshot_check" CHECK ((
  (
    ("stockModeSnapshot" IS NULL AND "stockAcceptedAt" IS NULL)
    OR "stockModeSnapshot" = 'RECIPE'
    OR ("stockModeSnapshot" = 'FINISHED_GOOD' AND "stockAcceptedAt" IS NULL)
  ) AND "finishedStockCafeId" IS NULL AND "finishedStockBranchId" IS NULL
    AND "finishedStockItemId" IS NULL AND "finishedStockUnit" IS NULL
    AND "finishedStockQuantity" IS NULL AND "finishedStockDeductedAt" IS NULL
    AND "finishedStockTransactionId" IS NULL
  OR (
    "stockModeSnapshot" = 'FINISHED_GOOD' AND "stockAcceptedAt" IS NOT NULL
    AND "finishedStockCafeId" IS NOT NULL AND "finishedStockBranchId" IS NOT NULL
    AND "finishedStockItemId" IS NOT NULL AND "finishedStockUnit" IS NOT NULL
    AND "finishedStockUnit" = 'PIECE' AND "finishedStockQuantity" IS NOT NULL
    AND "finishedStockQuantity" = "quantity" AND "finishedStockQuantity" BETWEEN 1 AND 999999999
    AND (("finishedStockDeductedAt" IS NULL) = ("finishedStockTransactionId" IS NULL))
  )
) IS TRUE AND (
  ("stockModeSnapshot" IS NULL AND "stockProductIdSnapshot" IS NULL AND "stockVariantIdSnapshot" IS NULL)
  OR ("stockModeSnapshot" IS NOT NULL AND "stockProductIdSnapshot" IS NOT NULL)
));
CREATE UNIQUE INDEX "OrderItem_finished_identity_key" ON "OrderItem" ("id", "orderId", "finishedStockCafeId", "finishedStockBranchId", "finishedStockItemId", "finishedStockUnit");
CREATE INDEX "OrderItem_finished_pending_idx" ON "OrderItem" ("orderId", "stockModeSnapshot", "finishedStockDeductedAt");
CREATE INDEX "OrderItem_finished_inventory_idx" ON "OrderItem" ("finishedStockItemId");
CREATE INDEX "OrderItem_finished_transaction_idx" ON "OrderItem" ("finishedStockTransactionId");
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_finished_order_fkey"
  FOREIGN KEY ("orderId", "finishedStockCafeId", "finishedStockBranchId")
  REFERENCES "Order" ("id", "cafeId", "branchId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_finished_inventory_fkey"
  FOREIGN KEY ("finishedStockItemId", "finishedStockCafeId", "finishedStockBranchId", "finishedStockUnit")
  REFERENCES "InventoryItem" ("id", "cafeId", "branchId", "unit") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_finished_usage_fkey"
  FOREIGN KEY ("finishedStockTransactionId", "finishedStockCafeId", "finishedStockBranchId", "finishedStockItemId", "orderId")
  REFERENCES "InventoryTransaction" ("id", "cafeId", "branchId", "inventoryItemId", "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "FinishedGoodsReturn" (
  "id" TEXT NOT NULL,
  "cafeId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "unit" "InventoryUnit" NOT NULL DEFAULT 'PIECE',
  "quantity" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "idempotencyScope" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  "inventoryTransactionId" TEXT,
  "deferredFreezeId" TEXT,
  "deferredHandoverId" TEXT,
  CONSTRAINT "FinishedGoodsReturn_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinishedGoodsReturn_input_check" CHECK (
    "unit" = 'PIECE' AND "quantity" BETWEEN 1 AND 999999999
    AND char_length(btrim("reason")) BETWEEN 3 AND 500
    AND char_length("idempotencyKey") BETWEEN 8 AND 128
    AND "requestHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "FinishedGoodsReturn_state_check" CHECK (
    ("deferredFreezeId" IS NULL) = ("deferredHandoverId" IS NULL)
    AND (("appliedAt" IS NOT NULL AND "inventoryTransactionId" IS NOT NULL)
      OR ("appliedAt" IS NULL AND "inventoryTransactionId" IS NULL
        AND "deferredFreezeId" IS NOT NULL AND "deferredHandoverId" IS NOT NULL))
  ),
  CONSTRAINT "FinishedGoodsReturn_line_fkey" FOREIGN KEY ("orderItemId", "orderId", "cafeId", "branchId", "inventoryItemId", "unit")
    REFERENCES "OrderItem" ("id", "orderId", "finishedStockCafeId", "finishedStockBranchId", "finishedStockItemId", "finishedStockUnit") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "FinishedGoodsReturn_actor_fkey" FOREIGN KEY ("createdById")
    REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "FinishedGoodsReturn_ledger_fkey" FOREIGN KEY ("inventoryTransactionId", "cafeId", "branchId", "inventoryItemId", "orderId")
    REFERENCES "InventoryTransaction" ("id", "cafeId", "branchId", "inventoryItemId", "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "FinishedGoodsReturn_freeze_fkey" FOREIGN KEY ("deferredFreezeId", "deferredHandoverId", "cafeId", "branchId")
    REFERENCES "InventoryFreeze" ("id", "handoverId", "cafeId", "branchId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "FinishedGoodsReturn_request_key" ON "FinishedGoodsReturn" ("idempotencyScope", "idempotencyKey");
CREATE UNIQUE INDEX "FinishedGoodsReturn_ledger_key" ON "FinishedGoodsReturn" ("inventoryTransactionId") WHERE "inventoryTransactionId" IS NOT NULL;
CREATE INDEX "FinishedGoodsReturn_line_idx" ON "FinishedGoodsReturn" ("orderItemId");
CREATE INDEX "FinishedGoodsReturn_branch_pending_idx" ON "FinishedGoodsReturn" ("branchId", "appliedAt");
CREATE INDEX "FinishedGoodsReturn_handover_pending_idx" ON "FinishedGoodsReturn" ("deferredHandoverId", "appliedAt");
CREATE INDEX "FinishedGoodsReturn_ledger_idx" ON "FinishedGoodsReturn" ("inventoryTransactionId");

CREATE FUNCTION "resale_guard_order_item"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement "InventoryTransaction"%ROWTYPE; linked bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."stockAcceptedAt" IS NOT NULL AND OLD."stockModeSnapshot" = 'FINISHED_GOOD' THEN
      RAISE EXCEPTION 'Accepted sale lines must be retained; use approved void/cancel' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."stockModeSnapshot" IS NOT NULL AND (
      NEW."stockModeSnapshot" IS NULL OR
      ROW(NEW."stockProductIdSnapshot", NEW."stockVariantIdSnapshot") IS DISTINCT FROM
      ROW(OLD."stockProductIdSnapshot", OLD."stockVariantIdSnapshot")
    ) THEN
      RAISE EXCEPTION 'Provisional mode and original catalog identity cannot be erased' USING ERRCODE = '23514';
    END IF;
    IF OLD."stockModeSnapshot" IS NULL AND
      (NEW."stockModeSnapshot" IS NOT NULL OR NEW."stockAcceptedAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'Legacy lines must retain legacy consumption' USING ERRCODE = '23514';
    END IF;
    IF OLD."stockAcceptedAt" IS NOT NULL AND (
      ROW(NEW."stockModeSnapshot", NEW."stockAcceptedAt", NEW."stockProductIdSnapshot", NEW."stockVariantIdSnapshot", NEW."orderId", NEW."quantity",
          NEW."finishedStockCafeId", NEW."finishedStockBranchId", NEW."finishedStockItemId", NEW."finishedStockUnit", NEW."finishedStockQuantity")
      IS DISTINCT FROM
      ROW(OLD."stockModeSnapshot", OLD."stockAcceptedAt", OLD."stockProductIdSnapshot", OLD."stockVariantIdSnapshot", OLD."orderId", OLD."quantity",
          OLD."finishedStockCafeId", OLD."finishedStockBranchId", OLD."finishedStockItemId", OLD."finishedStockUnit", OLD."finishedStockQuantity")
      OR (NEW."productId" IS DISTINCT FROM OLD."productId" AND NEW."productId" IS NOT NULL)
      OR (NEW."variantId" IS DISTINCT FROM OLD."variantId" AND NEW."variantId" IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Accepted consumption identity and quantity are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD."finishedStockTransactionId" IS NOT NULL AND
      ROW(NEW."finishedStockTransactionId", NEW."finishedStockDeductedAt") IS DISTINCT FROM
      ROW(OLD."finishedStockTransactionId", OLD."finishedStockDeductedAt") THEN
      RAISE EXCEPTION 'Consumption evidence cannot be cleared or replaced' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."finishedStockTransactionId" IS NOT NULL AND
    (TG_OP = 'INSERT' OR OLD."finishedStockTransactionId" IS DISTINCT FROM NEW."finishedStockTransactionId") THEN
    -- Application already holds the order. Fence direct concurrent link assignments too.
    PERFORM "id" FROM "Order" WHERE "id" = NEW."orderId" FOR UPDATE;
    SELECT * INTO movement FROM "InventoryTransaction" WHERE "id" = NEW."finishedStockTransactionId" FOR UPDATE;
    SELECT COALESCE(SUM("finishedStockQuantity"), 0) INTO linked FROM "OrderItem"
      WHERE "finishedStockTransactionId" = NEW."finishedStockTransactionId" AND "id" <> NEW."id";
    IF NOT FOUND OR movement."type" <> 'USAGE' OR movement."quantity" >= 0
      OR movement."id" IS NULL OR abs(movement."quantity") < linked + NEW."finishedStockQuantity" THEN
      RAISE EXCEPTION 'Finished consumption must reference a sufficient USAGE movement' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OrderItem_resale_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OrderItem"
  FOR EACH ROW EXECUTE FUNCTION "resale_guard_order_item"();

CREATE FUNCTION "resale_guard_return"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sale "Order"%ROWTYPE; line "OrderItem"%ROWTYPE;
  movement "InventoryTransaction"%ROWTYPE; usage "InventoryTransaction"%ROWTYPE;
  received bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Physical return receipts cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW."id", NEW."cafeId", NEW."branchId", NEW."orderId", NEW."orderItemId", NEW."inventoryItemId", NEW."unit", NEW."quantity",
        NEW."reason", NEW."createdById", NEW."idempotencyScope", NEW."idempotencyKey", NEW."requestHash", NEW."receivedAt", NEW."deferredFreezeId", NEW."deferredHandoverId")
    IS DISTINCT FROM
    ROW(OLD."id", OLD."cafeId", OLD."branchId", OLD."orderId", OLD."orderItemId", OLD."inventoryItemId", OLD."unit", OLD."quantity",
        OLD."reason", OLD."createdById", OLD."idempotencyScope", OLD."idempotencyKey", OLD."requestHash", OLD."receivedAt", OLD."deferredFreezeId", OLD."deferredHandoverId")
    OR (OLD."appliedAt" IS NOT NULL AND ROW(NEW."appliedAt", NEW."inventoryTransactionId") IS DISTINCT FROM ROW(OLD."appliedAt", OLD."inventoryTransactionId"))
  ) THEN
    RAISE EXCEPTION 'Physical receipt identity is immutable; application may post it once' USING ERRCODE = '23514';
  END IF;
  -- Order lock serializes distinct keys/operators as well as request retries.
  SELECT * INTO sale FROM "Order" WHERE "id" = NEW."orderId" FOR UPDATE;
  SELECT * INTO line FROM "OrderItem" WHERE "id" = NEW."orderItemId";
  IF sale."status" IS DISTINCT FROM 'SERVED'::"OrderStatus"
    OR line."stockModeSnapshot" IS DISTINCT FROM 'FINISHED_GOOD'::"ProductStockMode"
    OR line."stockAcceptedAt" IS NULL OR line."voidedAt" IS NOT NULL
    OR line."kitchenStatus" IS DISTINCT FROM 'SERVED'::"KitchenStatus" THEN
    RAISE EXCEPTION 'Return requires a served nonvoided finished sale line' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM("quantity"), 0) INTO received FROM "FinishedGoodsReturn"
    WHERE "orderItemId" = NEW."orderItemId" AND "id" <> NEW."id";
  IF received + NEW."quantity" > line."finishedStockQuantity" THEN
    RAISE EXCEPTION 'Cumulative physical receipts exceed served quantity' USING ERRCODE = '23514';
  END IF;
  IF NEW."inventoryTransactionId" IS NOT NULL THEN
    SELECT * INTO usage FROM "InventoryTransaction" WHERE "id" = line."finishedStockTransactionId" FOR SHARE;
    SELECT * INTO movement FROM "InventoryTransaction" WHERE "id" = NEW."inventoryTransactionId" FOR SHARE;
    IF movement."id" IS NULL OR usage."id" IS NULL
      OR movement."type" <> 'RETURN' OR movement."quantity" <> NEW."quantity"
      OR movement."unitCost" IS DISTINCT FROM usage."unitCost"
      OR movement."totalCost" IS DISTINCT FROM round(NEW."quantity" * usage."unitCost", 2) THEN
      RAISE EXCEPTION 'RETURN must preserve the original USAGE valuation and exact received quantity' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "FinishedGoodsReturn_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FinishedGoodsReturn"
  FOR EACH ROW EXECUTE FUNCTION "resale_guard_return"();

CREATE FUNCTION "resale_guard_referenced_ledger"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "OrderItem" WHERE "finishedStockTransactionId" = OLD."id")
    OR EXISTS (SELECT 1 FROM "FinishedGoodsReturn" WHERE "inventoryTransactionId" = OLD."id") THEN
    RAISE EXCEPTION 'Referenced finished-goods ledger history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "InventoryTransaction_resale_history_guard" BEFORE UPDATE OR DELETE ON "InventoryTransaction"
  FOR EACH ROW EXECUTE FUNCTION "resale_guard_referenced_ledger"();
COMMIT;
