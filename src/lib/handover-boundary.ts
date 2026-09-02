// The closing position of a branch at a handover — the whole shelf, not the
// part of it somebody counted.
//
// `StockCountLine` only exists for an item that was IN SCOPE. Under a
// SELECTED count most items have no line at all, and reading "no line" as
// "no variance" is the silent zero this module exists to prevent. So the
// boundary is the artifact rather than the count: one row per active,
// non-archived branch item, counted or not.
//
// Two kinds of row, and the difference between them is the point:
//
//   PHYSICAL_COUNT  somebody looked at the shelf. `verified: true`, and the
//                   figure and cursor are the accepted evidence's own.
//   SYSTEM_CARRIED  nobody did. The book figure is carried forward,
//                   `verified: false`, and it produces no variance and names
//                   nobody — an unverified boundary must have nowhere to
//                   record a difference it cannot know.
//
// THE PAIRING RULE, inherited from `effectiveCountEvidence` and enforced
// again here: a boundary's `quantity` and its `itemVersion` must describe the
// same instant. The rebase a later count performs is "quantity + every
// movement above that cursor", so a counted figure paired with a later ledger
// cursor replays movements the counter already saw on the shelf. That is why
// a counted line whose count point was never locked is REFUSED rather than
// repaired: substituting the item's current `ledgerVersion` would produce a
// row that looks like evidence and is not, and silently downgrading it to
// SYSTEM_CARRIED would throw away a real observation. Both are worse than
// failing, so neither is done.
//
// Cost follows the same logic. A counted row copies the cost evidence SH-13
// captured when the count was judged; it is never repriced from today's
// shelf, because a historical judgement repriced later is no longer that
// judgement. A carried row prices from the item it just locked, through the
// same `captureUnitCost` rule the rest of the system uses, so "unpriced"
// means one thing everywhere.
//
// CALLER PRECONDITION: `buildStockBoundary` is designed to run inside the
// accepting transaction while the branch's inventory is frozen, so that every
// cursor it reads describes one still instant. It does not acquire that
// freeze itself — SH-20 owns the acceptance transaction and the freeze that
// wraps it. Nothing here writes handover status, `resolvedTarget` or
// `acceptedStockCountSessionId`.

import type { BoundarySource, Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { EFFECTIVE_EVIDENCE_SELECT, effectiveCountEvidence } from "@/lib/count-evidence";
import { round3 } from "@/lib/costing";
import { lockItemForUpdate } from "@/lib/ledger";
import { captureUnitCost } from "@/lib/variance-confidence";

export type BoundaryLine = {
  inventoryItemId: string;
  source: BoundarySource;
  verified: boolean;
  quantity: number;
  itemVersion: bigint;
  stockCountLineId: string | null;
  unitCostSnapshot: number | null;
  unitCostSource: string | null;
};

export type StockBoundary = {
  lines: BoundaryLine[];
  verifiedCount: number;
  carriedCount: number;
};

export type AcceptedBoundary = {
  boundaryId: string;
  verified: boolean;
  quantity: number;
  itemVersion: bigint;
  acceptedAt: Date;
};

function conflict(message: string): never {
  throw new ApiError(409, message);
}

/** The accepted session's lines, with everything the pairing rule needs. */
const ACCEPTED_LINE_SELECT = {
  ...EFFECTIVE_EVIDENCE_SELECT,
  inventoryItemId: true,
  unitCostSnapshot: true,
  unitCostSource: true,
} satisfies Prisma.StockCountLineSelect;

/**
 * The complete closing position of a branch at this handover: one entry per
 * ACTIVE, non-archived inventory item, whether or not it was counted.
 *
 * `acceptedSessionId` rather than "the handover's count session" is
 * deliberate. After a recount a handover carries more than one session in its
 * history, and only the accepted one may become the boundary; a sibling
 * session of the same handover is not evidence merely because it shares a
 * parent. Pass `null` and the whole shelf is carried.
 */
export async function buildStockBoundary(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    handoverId: string;
    acceptedSessionId: string | null;
  }
): Promise<StockBoundary> {
  if (!args.cafeId || !args.branchId || !args.handoverId) {
    throw new ApiError(400, "cafeId, branchId and handoverId are required");
  }

  const evidence = await acceptedEvidence(tx, args);

  // Ordered by id so concurrent acceptances at different branches take their
  // row locks in one agreed order rather than deadlocking against each other.
  const items = await tx.inventoryItem.findMany({
    where: {
      cafeId: args.cafeId,
      branchId: args.branchId,
      isActive: true,
      archivedAt: null,
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const lines: BoundaryLine[] = [];
  for (const item of items) {
    const line = evidence.get(item.id);
    lines.push(
      line
        ? countedBoundary(line)
        : await carriedBoundary(tx, item.id)
    );
  }

  return {
    lines,
    verifiedCount: lines.filter((l) => l.verified).length,
    carriedCount: lines.filter((l) => !l.verified).length,
  };
}

/** The accepted session's lines by item, or an empty map when there is none. */
async function acceptedEvidence(
  tx: Prisma.TransactionClient,
  args: { cafeId: string; branchId: string; acceptedSessionId: string | null }
): Promise<Map<string, Prisma.StockCountLineGetPayload<{ select: typeof ACCEPTED_LINE_SELECT }>>> {
  if (!args.acceptedSessionId) return new Map();

  const session = await tx.stockCountSession.findUnique({
    where: { id: args.acceptedSessionId },
    select: { id: true, cafeId: true, branchId: true },
  });
  if (!session) throw new ApiError(404, "الجرد المعتمد مش موجود");
  if (session.cafeId !== args.cafeId || session.branchId !== args.branchId) {
    conflict("الجرد المعتمد بتاع فرع تاني");
  }

  const lines = await tx.stockCountLine.findMany({
    where: { sessionId: session.id },
    select: ACCEPTED_LINE_SELECT,
  });
  return new Map(lines.map((line) => [line.inventoryItemId, line]));
}

/**
 * A counted item's boundary: the evidence in force, taken whole.
 *
 * `effectiveCountEvidence` already resolves recount and approved-correction
 * precedence and hands back the quantity and the cursor together. Refusing a
 * null cursor here is the same rule stated at the boundary layer — see the
 * pairing rule at the top of this file for why no repair is acceptable.
 */
function countedBoundary(
  line: Prisma.StockCountLineGetPayload<{ select: typeof ACCEPTED_LINE_SELECT }>
): BoundaryLine {
  const evidence = effectiveCountEvidence(line);
  if (evidence.itemVersion === null) {
    conflict(
      "الجرد المعتمد فيه صنف متعدّ من غير نقطة جرد — مينفعش يتسجل كحد معتمد"
    );
  }
  return {
    inventoryItemId: line.inventoryItemId,
    source: "PHYSICAL_COUNT",
    verified: true,
    quantity: evidence.quantity,
    itemVersion: evidence.itemVersion,
    stockCountLineId: line.id,
    // SH-13's judgement, copied rather than recomputed: a historical count
    // repriced from today's shelf is no longer that count.
    unitCostSnapshot: line.unitCostSnapshot === null ? null : Number(line.unitCostSnapshot),
    unitCostSource: line.unitCostSource,
  };
}

/**
 * An uncounted item's boundary: the book figure, carried, flagged unverified.
 *
 * Balance and cursor come from one locked read, because reading them
 * separately would let a movement land between the two and make the quantity
 * and the cursor describe different instants — the same defect the pairing
 * rule forbids on the counted side.
 */
async function carriedBoundary(
  tx: Prisma.TransactionClient,
  inventoryItemId: string
): Promise<BoundaryLine> {
  const locked = await lockItemForUpdate(tx, inventoryItemId);
  const cost = captureUnitCost(locked.costPerUnit, new Date());
  return {
    inventoryItemId,
    source: "SYSTEM_CARRIED",
    verified: false,
    quantity: round3(locked.currentStock),
    itemVersion: locked.ledgerVersion,
    stockCountLineId: null,
    unitCostSnapshot: cost.available ? cost.unitCost : null,
    unitCostSource: cost.available ? cost.source : null,
  };
}

/**
 * Write the boundary, inside the caller's transaction.
 *
 * No upsert and no `skipDuplicates`: `@@unique(handoverId, inventoryItemId)`
 * refusing a second write is the guarantee that one handover has one closing
 * position, and a caller that retried into a different answer should hear
 * about it rather than have it quietly absorbed.
 */
export async function persistStockBoundary(
  tx: Prisma.TransactionClient,
  args: { handoverId: string; lines: BoundaryLine[] }
): Promise<{ written: number }> {
  if (!args.handoverId) throw new ApiError(400, "handoverId is required");
  if (args.lines.length === 0) return { written: 0 };

  const result = await tx.handoverStockBoundary.createMany({
    data: args.lines.map((line) => ({
      handoverId: args.handoverId,
      inventoryItemId: line.inventoryItemId,
      source: line.source,
      verified: line.verified,
      quantity: line.quantity,
      itemVersion: line.itemVersion,
      stockCountLineId: line.stockCountLineId,
      unitCostSnapshot: line.unitCostSnapshot,
      unitCostSource: line.unitCostSource,
    })),
  });
  return { written: result.count };
}

/**
 * The accepted boundary a later count measures against.
 *
 * Only a COMPLETED handover leaves one: a rejected handover's boundary is a
 * position nobody accepted, and treating it as the opening figure would make
 * the incoming custodian answerable for a shelf that was never handed over.
 * `null` means there has never been a boundary here — which is not the same
 * statement as a boundary of zero.
 */
export async function lastAcceptedBoundary(args: {
  branchId: string;
  inventoryItemId: string;
  before: Date;
}): Promise<AcceptedBoundary | null> {
  const row = await db.handoverStockBoundary.findFirst({
    where: {
      inventoryItemId: args.inventoryItemId,
      handover: {
        branchId: args.branchId,
        status: "COMPLETED",
        acceptedAt: { lt: args.before },
      },
    },
    select: {
      id: true,
      verified: true,
      quantity: true,
      itemVersion: true,
      handover: { select: { acceptedAt: true } },
    },
    orderBy: { handover: { acceptedAt: "desc" } },
  });
  if (!row || !row.handover.acceptedAt) return null;

  return {
    boundaryId: row.id,
    verified: row.verified,
    quantity: round3(Number(row.quantity)),
    itemVersion: row.itemVersion,
    acceptedAt: row.handover.acceptedAt,
  };
}
