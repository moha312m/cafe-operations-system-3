// ── Ending an unfinished handover into branch custody, on the record ──────
//
// The remediation layer needed a way out of a handover nobody will finish:
// the outgoing employee left, the receiver never came, or the count is
// stuck. The first version of that door ("cancel") completed the handover
// with nothing behind it — no boundary, no custody transfer on one path, the
// custodian allowed to press it on their own handover, and every count of
// the shift locked. This module is the same door with the rules kept:
//
//   * a MANAGER act (owner / `handover.exception` / `handover.cancel`), never
//     the custodian being measured;
//   * a HANDOVER reason code and a written note, recorded as an
//     `OpeningException` in the manager's name;
//   * the shelf is CARRIED, not counted: a SYSTEM_CARRIED / `verified: false`
//     boundary for every active item, so the next count still has a boundary
//     to measure against and nobody is named for a gap nobody observed;
//   * STOCK custody is TRANSFERRED to the branch (close + successor + audit),
//     never rewritten in place, and refused when the period is not open or is
//     still shared with another working shift;
//   * only the handover's own bound count is locked; other counts of the
//     shift are not this handover's to close;
//   * waiting shifts are re-decided through `ensureCustodyForShift`, the same
//     way a branch acceptance re-decides them.
//
// Everything runs on the caller's transaction and opens none of its own.

import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { ensureCustodyForShift, transferCustody } from "@/lib/custody";
import { assertHandoverReason, finalizeCashCustodyAtFinancialClose, HANDOVER_MANAGER_EXCEPTION_AUDIT_ACTION } from "@/lib/handover";
import { buildStockBoundary, persistStockBoundary } from "@/lib/handover-boundary";
import { acquireInventoryExclusiveLock, invalidateFreeze } from "@/lib/inventory-freeze";

export const HANDOVER_CANCELLED_AUDIT_ACTION = "HANDOVER_CANCELLED";

const CANCELLABLE_STATUSES = ["DRAFT", "OUTGOING_SUBMITTED", "INCOMING_REVIEW", "REJECTED"] as const;

export const CANCEL_REASON_SUBJECT = "سبب إنهاء التسليم";
export const CANCEL_NOTE_REQUIRED = "لازم تكتب سبب إنهاء التسليم بالتفصيل";
export const CANCEL_BY_CUSTODIAN = "مينفعش المُسلّم ينهي تسليمه بنفسه — ده إجراء مدير أو مالك";
export const CANCEL_NOT_OPEN = "التسليم ده مش في حالة تسمح بإنهائه";
export const CANCEL_STOCK_NOT_OPEN = "عهدة المخزن المرتبطة بالتسليم مش مفتوحة — راجع التسليم من صفحة التسليمات قبل إنهائه";
export const CANCEL_STOCK_SHARED = "فيه شيفت تاني لسه شغال على نفس عهدة المخزن — اقفله أو خليه يستلم بدل الإنهاء";
const WAITING_SHIFT_NOT_REDECIDED = "في وردية مستنية العهدة ومقدرتش تتحول للتحقق من العهدة الافتتاحية — راجع حالة العهدة في الفرع";

export type CancelHandoverArgs = {
  handoverId: string;
  /** The authenticated manager. Never the outgoing custodian. */
  actorId: string;
  cafeId: string;
  viewerBranchId: string | null;
  reasonCodeId: string;
  note: string;
};

export type CancelHandoverResult = {
  handoverId: string;
  status: "COMPLETED";
  resolvedTarget: "BRANCH_CUSTODY";
  /** The BRANCH-held stock period the shelf now sits in; null on a replay. */
  branchCustodyPeriodId: string | null;
  boundaryLines: number;
  lockedCountSessionId: string | null;
  redecidedShiftIds: string[];
  freezeReleased: boolean;
  /** True when the handover had already finished and nothing was written. */
  alreadyCompleted: boolean;
};

export async function cancelHandoverIntoBranchCustody(
  tx: Prisma.TransactionClient,
  args: CancelHandoverArgs,
): Promise<CancelHandoverResult> {
  const note = args.note?.trim() ?? "";
  if (!note) throw new ApiError(400, CANCEL_NOTE_REQUIRED);

  // 1. The handover row, locked for the rest of the transaction. Tenancy is
  //    in the WHERE so another café's id is indistinguishable from none.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "HandoverSession" WHERE "id" = ${args.handoverId} AND "cafeId" = ${args.cafeId} FOR UPDATE
  `;
  if (rows.length === 0) throw new ApiError(404, "جلسة التسليم غير موجودة");

  const handover = await tx.handoverSession.findUniqueOrThrow({
    where: { id: args.handoverId },
    select: {
      id: true, cafeId: true, branchId: true, status: true, target: true,
      outgoingShiftId: true, outgoingUserId: true, outgoingStockCustodyId: true, stockCountSessionId: true,
      outgoingShift: { select: { actualCashAmount: true } },
    },
  });
  if (args.viewerBranchId && handover.branchId !== args.viewerBranchId) {
    throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
  }
  if (handover.status === "COMPLETED") {
    return {
      handoverId: handover.id, status: "COMPLETED", resolvedTarget: "BRANCH_CUSTODY",
      branchCustodyPeriodId: null, boundaryLines: 0, lockedCountSessionId: null,
      redecidedShiftIds: [], freezeReleased: false, alreadyCompleted: true,
    };
  }
  if (!(CANCELLABLE_STATUSES as readonly string[]).includes(handover.status)) {
    throw new ApiError(409, CANCEL_NOT_OPEN);
  }
  // Defence in depth: the route refuses the custodian too, but the service is
  // the rule.
  if (handover.outgoingUserId === args.actorId) throw new ApiError(403, CANCEL_BY_CUSTODIAN);

  // 2. The reason, from this café's HANDOVER domain, under the lock.
  await assertHandoverReason(tx, args.reasonCodeId, handover.cafeId, CANCEL_REASON_SUBJECT);

  // 3. The branch's inventory, exclusively: the carried boundary below reads
  //    every item's balance and cursor, and they must describe one instant.
  await acquireInventoryExclusiveLock(tx, handover.branchId);

  // 4. The STOCK custody being ended: named on the handover, OPEN, and not
  //    still in use by another working shift.
  //
  //    A handover that names NO stock custody was opened by a shift that never
  //    received the shelf (a morning shift closed before its opening
  //    verification, before P1 made such a close money-only). There is no
  //    shelf of the outgoing employee's to carry or transfer, and refusing
  //    left the branch frozen with no way out. It ends like any other — drawer
  //    discharged, shift closed, freeze released, exception and audit — with
  //    the stock custody left exactly as it is.
  //
  //    The same holds when the period it names has already moved on — passed
  //    to someone else or closed — as happens when a cashier who shared a
  //    colleague's shelf walks away after the colleague handed over (simulation
  //    F-065). The shelf is with whoever holds it now; this handover can only
  //    be ended, not used to move it. Owner decision 2026-11-11: end it and
  //    keep the stock as it is. A period of another branch or scope is still
  //    refused: that is a broken record, not a stale one.
  let stockless = !handover.outgoingStockCustodyId;
  let stock: { id: string } | null = null;
  if (!stockless) {
    const period = await tx.custodyPeriod.findUnique({
      where: { id: handover.outgoingStockCustodyId! },
      select: { id: true, branchId: true, scope: true, status: true },
    });
    if (!period || period.branchId !== handover.branchId || period.scope !== "STOCK") {
      throw new ApiError(409, CANCEL_STOCK_NOT_OPEN);
    }
    if (period.status !== "OPEN") stockless = true;
  }
  if (!stockless) {
    const period = { id: handover.outgoingStockCustodyId! };
    const sharing = await tx.shiftCustody.count({
      where: {
        custodyPeriodId: period.id,
        shiftId: { not: handover.outgoingShiftId },
        shift: { status: { in: ["OPEN", "AWAITING_HANDOVER"] } },
      },
    });
    if (sharing > 0) throw new ApiError(409, CANCEL_STOCK_SHARED);
    stock = { id: period.id };
  }

  const now = new Date();

  // 5. The bound count, and only it. A superseded round, or an ordinary
  //    count of the same shift, is not this handover's to lock.
  let lockedCountSessionId: string | null = null;
  if (handover.stockCountSessionId) {
    const locked = await tx.stockCountSession.updateMany({
      where: { id: handover.stockCountSessionId, status: { not: "LOCKED" } },
      data: { status: "LOCKED", lockedAt: now, lockedByHandoverId: handover.id },
    });
    if (locked.count > 0) lockedCountSessionId = handover.stockCountSessionId;
    await tx.stockCountCorrection.updateMany({
      where: { line: { sessionId: handover.stockCountSessionId }, status: "PENDING_APPROVAL" },
      data: { status: "REJECTED", rejectedReason: `أُنهي التسليم لعهدة الفرع بقرار مدير: ${note}` },
    });
  }

  // 6. The closing position: the whole shelf, carried. Nothing here was
  //    counted and accepted, so every row is SYSTEM_CARRIED / unverified.
  //    Not for a stockless handover: it held no shelf, and a boundary in its
  //    name would become the "last accepted position" of a shelf it never had.
  const boundary = stockless
    ? { lines: [], carriedCount: 0 }
    : await buildStockBoundary(tx, {
        cafeId: handover.cafeId, branchId: handover.branchId, handoverId: handover.id, acceptedSessionId: null,
      });
  const written = stockless
    ? { written: 0 }
    : await persistStockBoundary(tx, { handoverId: handover.id, lines: boundary.lines });

  // 7. STOCK custody moves to the BRANCH: close + successor + audit, through
  //    the one transfer primitive, never an in-place rewrite.
  const transfer = stock
    ? await transferCustody(tx, {
        outgoingPeriodId: stock.id,
        scope: "STOCK",
        incoming: { participants: [], shiftId: null, responsibleShiftId: null, holderType: "BRANCH", openedById: args.actorId },
        actorId: args.actorId,
        acceptedById: args.actorId,
        acceptedAt: now,
      })
    : null;
  const branchStockId = transfer?.incomingPeriodId ?? null;

  // 8. The drawer, discharged at the figure the close counted when nobody
  //    else is still trading on it (the helper keeps a shared drawer open).
  await finalizeCashCustodyAtFinancialClose(tx, {
    cafeId: handover.cafeId, branchId: handover.branchId, outgoingShiftId: handover.outgoingShiftId,
    actualCash: Number(handover.outgoingShift?.actualCashAmount ?? 0),
  });

  // 9. The outgoing shift finishes.
  await tx.shift.updateMany({
    where: { id: handover.outgoingShiftId, status: "AWAITING_HANDOVER" },
    data: { status: "CLOSED", stockClosedAt: now, closedAt: now, closedById: args.actorId },
  });

  // 10. The record. Guarded on status so two managers racing produce one end.
  const moved = await tx.handoverSession.updateMany({
    where: { id: handover.id, status: { in: [...CANCELLABLE_STATUSES] } },
    data: {
      status: "COMPLETED",
      resolvedTarget: "BRANCH_CUSTODY",
      acceptedAt: now,
      completedAt: now,
      incomingUserId: null,
      incomingShiftId: null,
      incomingStockCustodyId: branchStockId,
      incomingCashCustodyId: null,
      exceptionById: args.actorId,
      exceptionReason: note,
      exceptionAt: now,
      idempotencyKey: `cancel:${handover.id}`,
    },
  });
  if (moved.count === 0) throw new ApiError(409, CANCEL_NOT_OPEN);

  const exception = await tx.openingException.create({
    data: {
      cafeId: handover.cafeId, branchId: handover.branchId, handoverId: handover.id,
      kind: "NO_INCOMING", reasonCodeId: args.reasonCodeId, note, authorizedById: args.actorId,
    },
    select: { id: true },
  });

  // 11. This handover's freeze, and only this one's.
  const freeze = await tx.inventoryFreeze.findUnique({
    where: { handoverId: handover.id },
    select: { id: true, releasedAt: true },
  });
  let freezeReleased = false;
  if (freeze && !freeze.releasedAt) {
    await tx.inventoryFreeze.update({ where: { id: freeze.id }, data: { releasedAt: now, releasedById: args.actorId } });
    invalidateFreeze(tx, handover.branchId);
    freezeReleased = true;
    await auditInTransaction(tx, {
      cafeId: handover.cafeId, userId: args.actorId, action: "INVENTORY_FREEZE_RELEASED",
      entity: "InventoryFreeze", entityId: freeze.id,
      details: { branchId: handover.branchId, handoverId: handover.id, releasedAt: now.toISOString(), cancelledHandover: true },
    });
  }

  // 12. Shifts that were waiting are re-decided, exactly as a branch
  //     acceptance re-decides them: the branch now holds the shelf, so the
  //     verdict is the opening verification, and anything else rolls back.
  const waiting = await tx.shift.findMany({
    where: { branchId: handover.branchId, status: "OPEN", custodyGateReason: "AWAITING_CUSTODY_TRANSFER" },
    select: { id: true, cashierId: true, openingCashAmount: true },
    orderBy: { shiftNumber: "asc" },
  });
  const redecidedShiftIds: string[] = [];
  for (const shift of waiting) {
    const verdict = await ensureCustodyForShift(tx, {
      cafeId: handover.cafeId, branchId: handover.branchId, shiftId: shift.id,
      userId: shift.cashierId, openingCashAmount: Number(shift.openingCashAmount),
    });
    // When this cancel moved the shelf to the branch, the only right verdict is
    // the opening verification. When it left the shelf where it was (a
    // stockless or moved-on handover), the waiting shift is decided exactly
    // as a fresh open would be against whoever holds it now — joining that
    // custody, a branch opening verification, or still waiting on another
    // live handover. Refusing those verdicts made the cancel itself a dead end
    // whenever somebody had opened in the meantime.
    if (!stockless && verdict.gate !== "AWAITING_OPENING_VERIFICATION") throw new ApiError(409, WAITING_SHIFT_NOT_REDECIDED);
    await auditInTransaction(tx, {
      cafeId: handover.cafeId, userId: args.actorId, action: "SHIFT_CUSTODY_GATE_REDECIDED",
      entity: "Shift", entityId: shift.id,
      details: { handoverId: handover.id, from: "AWAITING_CUSTODY_TRANSFER", to: verdict.gate ?? "OPERATIONAL", stockless, branchCustodyPeriodId: branchStockId, cashCustodyPeriodId: verdict.cashCustodyPeriodId },
    });
    redecidedShiftIds.push(shift.id);
  }

  // 13. Two audit rows: the end of the handover, and who authorised it.
  await auditInTransaction(tx, {
    cafeId: handover.cafeId, userId: args.actorId, action: HANDOVER_CANCELLED_AUDIT_ACTION,
    entity: "HandoverSession", entityId: handover.id,
    details: {
      branchId: handover.branchId, previousStatus: handover.status, target: handover.target,
      resolvedTarget: "BRANCH_CUSTODY", reasonCodeId: args.reasonCodeId, note,
      outgoingShiftId: handover.outgoingShiftId, outgoingUserId: handover.outgoingUserId,
      outgoingStockCustodyId: stock?.id ?? null, incomingStockCustodyId: branchStockId, stockless,
      boundary: { written: written.written, verified: 0, carried: boundary.carriedCount },
      lockedCountSessionId, freezeReleased, redecidedShiftIds, openingExceptionId: exception.id,
      cancelledAt: now.toISOString(),
    },
  });
  await auditInTransaction(tx, {
    cafeId: handover.cafeId, userId: args.actorId, action: HANDOVER_MANAGER_EXCEPTION_AUDIT_ACTION,
    entity: "HandoverSession", entityId: handover.id,
    details: {
      branchId: handover.branchId, kind: "NO_INCOMING", reasonCodeId: args.reasonCodeId, note,
      openingExceptionId: exception.id, resolvedTarget: "BRANCH_CUSTODY", cancelled: true,
      exceptionAt: now.toISOString(),
    },
  });

  return {
    handoverId: handover.id, status: "COMPLETED", resolvedTarget: "BRANCH_CUSTODY",
    branchCustodyPeriodId: branchStockId, boundaryLines: written.written,
    lockedCountSessionId, redecidedShiftIds, freezeReleased, alreadyCompleted: false,
  };
}
