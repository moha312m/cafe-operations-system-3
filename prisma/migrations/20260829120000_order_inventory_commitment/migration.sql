-- What an accepted order has already promised of the branch's stock.
--
-- `InventoryItem.currentStock` does not move until SERVED, and that is the
-- right place for it: the deduction is a locked, ledgered, audited mutation
-- and it belongs at the moment the drink is handed over. But it means the
-- shelf balance on its own overstates what the branch can still make. Three
-- milkshakes accepted two minutes ago are three milkshakes' worth of ice
-- cream that is spoken for and still counted as available.
--
-- So acceptance now records what it will consume, and available-to-sell is
-- `currentStock` MINUS the live rows in this table. The same rows are what
-- makes acceptance concurrency-safe: order creation takes the branch rows'
-- FOR UPDATE locks, re-reads stock and live commitments under them, and
-- writes the order together with its commitment or writes neither — so two
-- tills cannot both take the last four portions of a five-portion ingredient.
--
-- Additive by construction: one new enum, one new table, one nullable column.
-- Nothing existing is altered, dropped or rewritten, and no historical row is
-- assigned a consumption figure (see the backfill note at the bottom, which
-- is a note about why there is NO backfill).

CREATE TYPE "InventoryCommitmentRelease" AS ENUM (
  -- Reached SERVED; the quantity moved into `currentStock` through the
  -- locked stock writer, in the same transaction as this release.
  'DEDUCTED',
  -- Cancelled or rejected before deduction; it was never going to leave.
  'CANCELLED'
);

CREATE TABLE "OrderInventoryCommitment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    -- Denormalised from the order so a branch's live commitments can be
    -- aggregated without a join, and so tenancy is expressible on this table
    -- alone rather than borrowed from another one.
    "cafeId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    -- The BRANCH stock row that will actually be deducted, not the café-level
    -- ingredient the recipe names. That resolution (name + unit) is the same
    -- rule the deduction uses, and it is done ONCE, here, at acceptance.
    "inventoryItemId" TEXT NOT NULL,
    -- Positive magnitude in "unit". Decimal(12,3) to match InventoryItem
    -- .currentStock exactly: 18 g of coffee is 0.018 kg, and a commitment
    -- rounded to two places would not subtract cleanly from the balance it
    -- is measured against.
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" "InventoryUnit" NOT NULL,
    -- NULL while live. Written exactly once, inside the transaction that
    -- deducts or cancels, so there is never an instant where both the stock
    -- movement and the commitment apply — nor one where neither does.
    "releasedAt" TIMESTAMP(3),
    "releaseReason" "InventoryCommitmentRelease",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderInventoryCommitment_pkey" PRIMARY KEY ("id")
);

-- One row per ingredient per order. Two rows for the same item would double
-- that order's claim on the shelf, exactly as two recipe lines for one
-- ingredient would double its deduction — which is why RecipeItem carries the
-- same constraint.
CREATE UNIQUE INDEX "OrderInventoryCommitment_orderId_inventoryItemId_key"
    ON "OrderInventoryCommitment"("orderId", "inventoryItemId");

CREATE INDEX "OrderInventoryCommitment_orderId_idx"
    ON "OrderInventoryCommitment"("orderId");
CREATE INDEX "OrderInventoryCommitment_cafeId_idx"
    ON "OrderInventoryCommitment"("cafeId");
-- The availability read's own index: this branch's live commitments.
CREATE INDEX "OrderInventoryCommitment_branchId_releasedAt_idx"
    ON "OrderInventoryCommitment"("branchId", "releasedAt");
CREATE INDEX "OrderInventoryCommitment_inventoryItemId_releasedAt_idx"
    ON "OrderInventoryCommitment"("inventoryItemId", "releasedAt");

ALTER TABLE "OrderInventoryCommitment"
    ADD CONSTRAINT "OrderInventoryCommitment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderInventoryCommitment"
    ADD CONSTRAINT "OrderInventoryCommitment_cafeId_fkey"
    FOREIGN KEY ("cafeId") REFERENCES "Cafe"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderInventoryCommitment"
    ADD CONSTRAINT "OrderInventoryCommitment_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderInventoryCommitment"
    ADD CONSTRAINT "OrderInventoryCommitment_inventoryItemId_fkey"
    FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Whether an order HAS been through the snapshot step.
--
-- Not the same question as "does it have commitment rows". An order whose
-- consumption legitimately resolves to nothing — a bottled drink recorded as
-- NOT_APPLICABLE, or a sale OVERRIDE_ALL let through against a recipe nobody
-- has written — has no rows and is nevertheless fully accounted for.
ALTER TABLE "Order" ADD COLUMN "inventoryCommittedAt" TIMESTAMP(3);

-- ── Historical orders: deliberately NOT backfilled ──
--
-- Every existing row keeps NULL here, and no commitment row is created for
-- any of them. That is the entire migration strategy, and it is a decision
-- rather than an omission:
--
--   FINALISED orders (SERVED, CANCELLED, REJECTED) need no commitment. A
--   served order's consumption is already in `currentStock` and in the
--   InventoryTransaction ledger; a cancelled one never had a claim. Writing
--   released rows for them would add no fact and would invent a `releasedAt`
--   nobody observed.
--
--   OPEN orders (CONFIRMED / PREPARING / READY, not yet deducted) genuinely
--   are unaccounted for, and there is no honest way to fix that here.
--   OrderItem records product, variant, add-ons and quantity — what was SOLD
--   — but never what it consumed. Recomputing from today's recipe would
--   produce a number that looks like history and is not: if the owner edited
--   the recipe this morning, the figure would be one the order was never
--   accepted under, and this whole feature exists to stop exactly that
--   substitution. Inventing one would also be indistinguishable, afterwards,
--   from a measured one.
--
-- So they are left NULL and counted. `inventoryCommittedAt IS NULL` on an
-- open order is a positive statement — "accepted before the ledger existed,
-- draw unknown" — and the availability service reports how many such orders a
-- branch has alongside its numbers, rather than folding a guess into them.
-- The condition is self-clearing: those orders reach SERVED or CANCELLED in
-- the ordinary course of a shift, and every order accepted from now on
-- carries its own snapshot.
--
-- Note what this means for the numbers in the meantime: with a legacy open
-- order outstanding, available-to-sell can be HIGHER than the truth by that
-- order's unrecorded draw. That is precisely the behaviour the branch had
-- yesterday, when open orders reduced availability by nothing at all — so
-- nothing regresses; the gap is simply now visible and counted instead of
-- silent.
