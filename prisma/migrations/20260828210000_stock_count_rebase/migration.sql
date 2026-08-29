-- A ledger movement that means the shelf was counted.
--
-- An earlier revision declared confirmed counts to be the operational
-- baseline and then never wrote them anywhere. "currentStock" kept the
-- pre-count figure, the next count rediscovered the same variance, and the
-- handover baseline was fiction.
--
-- "ADJUSTMENT" is deliberately not reused. Spec section 7 says a count
-- records EVIDENCE and an adjustment records a CORRECTION, and a manager
-- tweaking a figure must stay distinguishable from a team physically
-- recounting a shelf. Reusing ADJUSTMENT would merge the two at the moment of
-- writing, and no later query could take them apart.
--
-- NOTE ON REVERSIBILITY: the enum value cannot be dropped without recreating
-- the type, which would be destructive. This is the one step in the milestone
-- that is not cleanly reversible; the rollback drops the table and leaves the
-- value, which is inert while nothing writes it. Stated rather than glossed.

-- Added here, USED at runtime only. PostgreSQL forbids using a new enum value
-- in the transaction that adds it, so no statement below references it.
ALTER TYPE "InventoryTransactionType" ADD VALUE IF NOT EXISTS 'COUNT_REBASE';

-- ─────────────────────────── The rebase record ───────────────────────────
-- Every figure that produced the new balance is kept, so a rebase can be
-- re-derived later rather than taken on trust: what was counted, what the
-- shelf said beforehand, what moved during the count, and where it landed.
CREATE TABLE "StockCountRebase" (
  "id"              TEXT NOT NULL,
  "sessionId"       TEXT NOT NULL,
  "lineId"          TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,

  -- The figure acted on: effectiveCountedQuantity at rebase time, which is
  -- the approved correction when one supersedes the original count.
  "countedQuantity" DECIMAL(12,3) NOT NULL,
  -- currentStock immediately before, read under the item lock.
  "stockBefore"     DECIMAL(12,3) NOT NULL,
  -- Movements above the line's itemVersion, replayed so nothing is lost.
  "replayedDelta"   DECIMAL(12,3) NOT NULL,
  "replayedMovementCount" INTEGER NOT NULL,
  "stockAfter"      DECIMAL(12,3) NOT NULL,
  -- The itemVersion the COUNT_REBASE row itself was written at.
  "rebaseItemVersion" BIGINT NOT NULL,

  "ledgerTransactionId" TEXT NOT NULL,
  "rebasedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rebasedById" TEXT NOT NULL,

  CONSTRAINT "StockCountRebase_pkey" PRIMARY KEY ("id")
);

-- Idempotency, in the database rather than in a flag: one confirmed count
-- rebases one item exactly once, and a retry collides instead of applying a
-- second delta to a balance.
CREATE UNIQUE INDEX "StockCountRebase_sessionId_inventoryItemId_key"
  ON "StockCountRebase"("sessionId", "inventoryItemId");
CREATE UNIQUE INDEX "StockCountRebase_lineId_key" ON "StockCountRebase"("lineId");
-- One ledger row is the effect of one rebase; sharing it would make the
-- effect ambiguous.
CREATE UNIQUE INDEX "StockCountRebase_ledgerTransactionId_key"
  ON "StockCountRebase"("ledgerTransactionId");
CREATE INDEX "StockCountRebase_sessionId_idx" ON "StockCountRebase"("sessionId");

-- Cascade where the rebase is OWNED by the count it came from: deleting the
-- count leaves the record nothing to explain.
ALTER TABLE "StockCountRebase"
  ADD CONSTRAINT "StockCountRebase_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StockCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockCountRebase"
  ADD CONSTRAINT "StockCountRebase_lineId_fkey"
  FOREIGN KEY ("lineId") REFERENCES "StockCountLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict where the rebase points OUT at something that must survive it. A
-- rebase's whole value is that it explains a movement, so deleting the
-- movement while keeping the explanation would leave a record of an effect
-- that is no longer visible anywhere.
ALTER TABLE "StockCountRebase"
  ADD CONSTRAINT "StockCountRebase_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountRebase"
  ADD CONSTRAINT "StockCountRebase_ledgerTransactionId_fkey"
  FOREIGN KEY ("ledgerTransactionId") REFERENCES "InventoryTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCountRebase"
  ADD CONSTRAINT "StockCountRebase_rebasedById_fkey"
  FOREIGN KEY ("rebasedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
