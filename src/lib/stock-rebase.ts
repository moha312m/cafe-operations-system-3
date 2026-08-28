// What was counted becomes what the shelf holds.
//
// The naive rebase is `currentStock = countedQuantity`, and it is wrong in a
// shop that stays open. A sale made while the count was in progress got a
// ledger version ABOVE the line's captured `itemVersion`, so it was excluded
// from that line's expected figure — correctly, because the counter never saw
// it on the shelf. But it did leave the shelf. Setting the balance to the
// counted figure would silently put that coffee back, and the next count
// would find it missing all over again.
//
// So the rebase replays:
//
//   evidence   = effectiveCountEvidence(line)   → quantity AND its own cursor
//   stockAfter = evidence.quantity + ledgerDeltaAbove(evidence.itemVersion)
//   delta      = stockAfter − stockBefore        → via applyStockMutation
//
// The quantity and the cursor are taken from ONE call because they are only
// correct together. When a recount supersedes the first count, its figure
// already includes every movement made before it — measuring that figure from
// the FIRST count's cursor would replay those movements a second time and
// leave the shop holding stock it does not have.
//
// Every movement lands on exactly one side of the cursor: inside the physical
// baseline the counter observed, or in the replay. Never both, never neither.
// The cursor is the item-local `itemVersion` rather than a timestamp, because
// two movements in the same millisecond have distinct versions and wall-clock
// ordering does not.
//
// The figure acted on is the evidence in force, not necessarily the first
// observation: a recount or an approved correction supersedes it. Neither
// rewrites it — the first count is evidence of what was first seen, and
// editing it to match a later figure would destroy the thing a recount or a
// correction exists to record. A rebase is a separate, audited operational
// effect, not an edit to the count.
//
// Everything goes through `applyStockMutation`, so the rebase takes the
// item's row lock, advances the version and writes its own ledger row under
// that lock, exactly like a sale. There is no second stock writer here and
// there must never be one: the COUNT_REBASE row's version being exactly one
// above the item's prior version is what proves it went through the door.
//
// The audit row is written INSIDE that same transaction, not after it. A
// COUNT_REBASE that moved a shelf and left no record of who moved it or what
// arithmetic produced it is not a successful write with a missing note — it
// is stock changing for reasons nobody can reconstruct. So the three
// evidence layers (the rebase record, the ledger movement and the audit row)
// commit together or not at all, and `auditInTransaction` throws where the
// ordinary fire-and-forget `audit` would swallow.
//
// Idempotency is the unique on `(sessionId, inventoryItemId)`, in the
// database rather than in a flag. Two callers racing produce one winner and
// one collision, and the loser reports the existing work rather than adding a
// second delta to a balance. Rebasing is not the kind of operation that gets
// a second chance to be wrong.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { round3 } from "@/lib/costing";
import { isTerminal } from "@/lib/count-disposition";
import { applyStockMutation, ledgerDeltaAbove, lockItemForUpdate } from "@/lib/ledger";
import {
  EFFECTIVE_EVIDENCE_SELECT,
  effectiveCountEvidence,
  type EffectiveEvidenceSource,
} from "@/lib/count-evidence";

export type RebaseResult = {
  sessionId: string;
  itemsRebased: number;
  itemsSkipped: number;
  lines: {
    inventoryItemId: string;
    stockBefore: number;
    replayedDelta: number;
    stockAfter: number;
  }[];
  alreadyRebased: boolean;
};

/**
 * The one persisted audit action for this operation.
 *
 * Named once, here, so there is a single canonical string rather than two
 * that drift. `TXN_AUDIT_ACTION.COUNT_REBASE` in `inventory.ts` deliberately
 * carries the same value: that map exists so no transaction type is missing
 * an entry, and if a future path ever audits a rebase through it, it must
 * write the same action this one does.
 */
export const REBASE_AUDIT_ACTION = "STOCK_REBASED";

/** Postgres unique-violation, however it reaches us. */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return code === "P2002" || code === "23505";
}

/**
 * Turn a confirmed count into the operational stock baseline.
 *
 * Called by handover accept and by an explicit owner action. Refuses unless
 * the session is CONFIRMED: only a count somebody confirmed is a trusted
 * starting point, and a DRAFT or SUBMITTED one is still being argued about.
 *
 * Lines not in a terminal disposition are skipped and counted, never guessed
 * at — an unsettled line has no figure anybody has agreed to act on.
 */
export async function rebaseFromCount(args: {
  sessionId: string;
  actorId: string;
  idempotencyKey: string;
}): Promise<RebaseResult> {
  const session = await db.stockCountSession.findUnique({
    where: { id: args.sessionId },
    select: {
      id: true, cafeId: true, branchId: true, status: true,
      lines: {
        select: {
          inventoryItemId: true, disposition: true,
          ...EFFECTIVE_EVIDENCE_SELECT,
        },
      },
    },
  });
  if (!session) throw new ApiError(404, "جلسة الجرد غير موجودة");

  if (session.status !== "CONFIRMED") {
    throw new ApiError(
      400,
      "مينفعش تعتمد المخزون من جرد لسه متأكدش — الجلسة لازم تكون CONFIRMED"
    );
  }

  // The actor must belong to the café whose shelf is about to move. A key
  // proves the session exists; it does not make it ours.
  const actor = await db.user.findUnique({
    where: { id: args.actorId },
    select: { cafeId: true, role: true },
  });
  if (!actor) throw new ApiError(404, "المستخدم غير موجود");
  if (actor.role !== "SUPER_ADMIN" && actor.cafeId !== session.cafeId) {
    throw new ApiError(403, "مينفعش تعتمد جرد كافيه تاني");
  }

  const lines = session.lines;
  const result: RebaseResult = {
    sessionId: session.id,
    itemsRebased: 0,
    itemsSkipped: 0,
    lines: [],
    alreadyRebased: false,
  };

  let appliedSomething = false;

  for (const line of lines) {
    if (!isTerminal(line.disposition)) {
      result.itemsSkipped += 1;
      continue;
    }
    // An effective figure is required to act. A terminal line without one is
    // skipped rather than treated as zero — "nothing on the shelf" and "no
    // figure recorded" are different claims.
    //
    // The quantity and the cursor come from ONE call, because they are only
    // correct together: a recount's figure measured from the first count's
    // cursor would replay every movement between the two counts a second
    // time, on top of a figure that already includes them.
    const evidence = effectiveCountEvidence(line);
    if (line.countedQuantity === null && evidence.recountId === null) {
      result.itemsSkipped += 1;
      continue;
    }

    const applied = await applyOneLine({
      cafeId: session.cafeId,
      branchId: session.branchId,
      sessionId: session.id,
      lineId: line.id,
      inventoryItemId: line.inventoryItemId,
      effectiveCounted: evidence.quantity,
      originalCounted: line.countedQuantity === null ? null : Number(line.countedQuantity),
      countCursor: evidence.itemVersion ?? BigInt(0),
      evidenceSource: evidence.source,
      actorId: args.actorId,
    });

    if (applied === "ALREADY") {
      result.alreadyRebased = true;
      continue;
    }

    appliedSomething = true;
    result.itemsRebased += 1;
    result.lines.push({
      inventoryItemId: line.inventoryItemId,
      stockBefore: applied.stockBefore,
      replayedDelta: applied.replayedDelta,
      stockAfter: applied.stockAfter,
    });

  }

  // A call that applied nothing but found existing work is a retry, and says
  // so. A call that applied nothing because every line was skipped is not.
  if (!appliedSomething && result.alreadyRebased) result.alreadyRebased = true;

  return result;
}

/**
 * One item, in one transaction holding that item's lock.
 *
 * The rebase record is written inside the same transaction as the stock
 * mutation, so a failure leaves neither: a rebase row with no movement, or a
 * movement with no rebase row, would each be a permanent lie about what
 * happened to the shelf.
 */
async function applyOneLine(args: {
  cafeId: string;
  branchId: string;
  sessionId: string;
  lineId: string;
  inventoryItemId: string;
  effectiveCounted: number;
  originalCounted: number | null;
  countCursor: bigint;
  /** Which observation supplied the figure AND the cursor above. */
  evidenceSource: EffectiveEvidenceSource;
  actorId: string;
}): Promise<
  | "ALREADY"
  | {
      stockBefore: number;
      replayedDelta: number;
      replayedMovementCount: number;
      stockAfter: number;
      appliedDelta: number;
    }
> {
  // Cheap pre-check so an ordinary retry does not have to provoke a
  // constraint violation. The unique index below is what actually decides.
  const existing = await db.stockCountRebase.findUnique({
    where: {
      sessionId_inventoryItemId: {
        sessionId: args.sessionId,
        inventoryItemId: args.inventoryItemId,
      },
    },
    select: { id: true },
  });
  if (existing) return "ALREADY";

  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const replay = await ledgerDeltaAbove(tx, args.inventoryItemId, args.countCursor);
      const stockAfter = round3(args.effectiveCounted + replay.delta);

      // Take the lock through the ledger module's own helper rather than
      // hand-rolling the same SELECT ... FOR UPDATE. Holding it from here
      // means the balance the delta is computed against cannot move before
      // `applyStockMutation` re-reads it under the same lock, in the same
      // transaction.
      const locked = await lockItemForUpdate(tx, args.inventoryItemId);
      const stockBefore = round3(locked.currentStock);
      const appliedDelta = round3(stockAfter - stockBefore);

      const mutation = await applyStockMutation(tx, {
        inventoryItemId: args.inventoryItemId,
        type: "COUNT_REBASE",
        quantity: appliedDelta,
        cafeId: args.cafeId,
        branchId: args.branchId,
        createdById: args.actorId,
        note: `COUNT_REBASE session=${args.sessionId}`,
        // A confirmed physical count is what is actually on the shelf. If it
        // says zero, refusing to record zero would keep a figure everyone
        // knows is wrong.
        allowNegative: true,
      });

      await tx.stockCountRebase.create({
        data: {
          sessionId: args.sessionId,
          lineId: args.lineId,
          inventoryItemId: args.inventoryItemId,
          countedQuantity: args.effectiveCounted,
          stockBefore,
          replayedDelta: replay.delta,
          replayedMovementCount: replay.movementCount,
          stockAfter: mutation.stockAfter,
          rebaseItemVersion: mutation.itemVersion,
          ledgerTransactionId: mutation.transactionId,
          rebasedById: args.actorId,
        },
      });

      // The third evidence layer, in the same transaction as the other two.
      // Both the original and the effective figure are recorded: an audit
      // showing only what was acted on would hide that a correction was
      // involved at all.
      await auditInTransaction(tx, {
        cafeId: args.cafeId,
        userId: args.actorId,
        action: REBASE_AUDIT_ACTION,
        entity: "InventoryItem",
        entityId: args.inventoryItemId,
        details: {
          sessionId: args.sessionId,
          lineId: args.lineId,
          branchId: args.branchId,
          inventoryItemId: args.inventoryItemId,
          ledgerTransactionId: mutation.transactionId,
          originalCountedQuantity: args.originalCounted,
          effectiveCountedQuantity: args.effectiveCounted,
          // Which observation the figure and the cursor both came from, so a
          // reader can tell a rebase of a first count from one of a recount
          // without re-deriving it.
          evidenceSource: args.evidenceSource,
          countCursor: Number(args.countCursor),
          stockBefore,
          replayedDelta: replay.delta,
          replayedMovementCount: replay.movementCount,
          stockAfter: mutation.stockAfter,
          appliedDelta,
          rebaseItemVersion: Number(mutation.itemVersion),
        },
      });

      return {
        stockBefore,
        replayedDelta: replay.delta,
        stockAfter: mutation.stockAfter,
        appliedDelta,
        replayedMovementCount: replay.movementCount,
      };
    });
  } catch (e) {
    // Somebody else won the race. The unique index is what makes this a
    // reliable answer rather than a hopeful retry.
    if (isUniqueViolation(e)) {
      const winner = await db.stockCountRebase.findUnique({
        where: {
          sessionId_inventoryItemId: {
            sessionId: args.sessionId,
            inventoryItemId: args.inventoryItemId,
          },
        },
        select: { id: true },
      });
      if (winner) return "ALREADY";
    }
    throw e;
  }
}
