-- M23 — a span may close on accepted opening evidence.
--
-- `StockVarianceSpan.toBoundaryId` was NOT NULL because, until now, the only
-- thing that could close a span was a handover's `HandoverStockBoundary`.
-- A branch opening verification produces no boundary: the gap is found by the
-- accepted opening count itself, against the position the branch was left
-- holding. Writing a synthetic boundary so the column could stay NOT NULL
-- would put a handover's artifact on a record no handover produced, and every
-- later reader of "which handover closed this?" would get an answer that is
-- not true.
--
-- So the closing evidence becomes a TYPED arm rather than an untyped id.
-- Two nullable columns, exactly one of which must be present, and which one
-- is filled says what kind of evidence found the difference. A single
-- polymorphic `toEvidenceId` would have been shorter and would have made the
-- referent unknowable without reading a second column anyway — and it could
-- not carry a foreign key.
--
-- `toStockCountLineId` IS a real foreign key, and RESTRICT, which is the
-- opposite choice from `toBoundaryId` and deliberately so. Boundaries cascade
-- away with their handover while `VarianceCase.acceptedHandoverId` is SET
-- NULL, so a key there would contradict the case's own survival. A count line
-- has no such cascade above it: it is evidence in its own right, it outlives
-- the ingredient it counted (`StockCountLine_inventoryItemId_fkey` is already
-- RESTRICT for the same reason), and a span pointing at a deleted line would
-- be a record of a gap with nothing that found it.
--
-- ADDITIVE AND EMPTY-HANDED. No backfill, no UPDATE, no row invented. Every
-- existing row already has `toBoundaryId` non-null, so it satisfies the new
-- CHECK the moment the constraint is added and keeps `toStockCountLineId`
-- NULL forever. The unique index tolerates that: PostgreSQL's B-tree unique
-- indexes do not consider NULLs equal, so any number of boundary-armed rows
-- coexist under it.

-- AlterTable
ALTER TABLE "StockVarianceSpan" ADD COLUMN     "toStockCountLineId" TEXT;

-- AlterTable
ALTER TABLE "StockVarianceSpan" ALTER COLUMN "toBoundaryId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "StockVarianceSpan_toStockCountLineId_key" ON "StockVarianceSpan"("toStockCountLineId");

-- AddForeignKey
ALTER TABLE "StockVarianceSpan" ADD CONSTRAINT "StockVarianceSpan_toStockCountLineId_fkey" FOREIGN KEY ("toStockCountLineId") REFERENCES "StockCountLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The invariant the two nullable columns exist to carry: exactly one closing
-- arm. Neither leaves a span that records a gap nothing found; both would
-- leave a span claiming two different pieces of evidence closed it.
ALTER TABLE "StockVarianceSpan" ADD CONSTRAINT "StockVarianceSpan_one_closing_evidence" CHECK (
  (
    (CASE WHEN "toBoundaryId"       IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "toStockCountLineId" IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);
