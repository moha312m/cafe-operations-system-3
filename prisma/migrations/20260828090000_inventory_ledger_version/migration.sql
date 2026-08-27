-- Item-local ledger version.
--
-- Physical counting needs a cursor: a point such that everything at or below
-- it is committed and reflected in InventoryItem.currentStock, and nothing
-- above it has been assigned. A global sequence cannot be that cursor —
-- nextval() assigns at INSERT, not at COMMIT, so a slow transaction can hold
-- a LOW number and commit AFTER a capture that already read past it. That
-- movement would be excluded from the rebase replay and absent from the
-- expected figure at the same time: silently lost, and read later as
-- somebody's shortage.
--
-- The counter therefore lives in the item row and is advanced only under
-- that row's FOR UPDATE lock. The lock serialises every mutator of the item,
-- so version N+1 cannot be assigned until N is committed and visible —
-- version order IS commit order, per item, by construction. A rolled-back
-- increment rolls back with the row, so there are no gaps either.
--
-- Rollback (additive, and no ledger row is altered or removed):
--   DROP INDEX "InventoryTransaction_inventoryItemId_itemVersion_key";
--   ALTER TABLE "InventoryTransaction" DROP COLUMN "itemVersion";
--   ALTER TABLE "InventoryItem" DROP COLUMN "ledgerVersion";

ALTER TABLE "InventoryItem"        ADD COLUMN "ledgerVersion" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "InventoryTransaction" ADD COLUMN "itemVersion"   BIGINT;

-- Existing rows are numbered per item in their own history order. Physical
-- scan order would not be history, so it is not used.
WITH ordered AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "inventoryItemId"
                            ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "InventoryTransaction"
)
UPDATE "InventoryTransaction" t
   SET "itemVersion" = ordered.rn
  FROM ordered WHERE t."id" = ordered."id";

ALTER TABLE "InventoryTransaction" ALTER COLUMN "itemVersion" SET NOT NULL;

-- Each item's counter starts where its history ends, so the next write
-- cannot reuse a number the ledger already holds.
UPDATE "InventoryItem" i
   SET "ledgerVersion" = COALESCE(
     (SELECT MAX(t."itemVersion") FROM "InventoryTransaction" t
       WHERE t."inventoryItemId" = i."id"), 0);

-- Independent proof of the invariant. If two transactions ever did assign
-- the same version to one item, the second INSERT fails here — the guarantee
-- is enforced by the database, not by the discipline of the code.
CREATE UNIQUE INDEX "InventoryTransaction_inventoryItemId_itemVersion_key"
  ON "InventoryTransaction"("inventoryItemId", "itemVersion");
