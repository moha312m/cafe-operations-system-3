// P1 · «إصلاح عهدة الفرع» — the manager's way out of a branch whose custody
// records no longer make a whole, so nobody can open a shift.
//
// The shift open refuses CASH_WITHOUT_STOCK / STOCK_WITHOUT_CASH on purpose
// (`ensureCustodyForShift`): opening on top of a half-recorded custody would
// make the new cashier answerable for something nobody handed them. Before
// this action that refusal had no exit short of a database edit, because
// every manager act on the handover screen needs a live handover and these
// branches have none.
//
// What the repair does, in ONE transaction under the branch's exclusive
// inventory lock, and only when the open would really refuse:
//
//   CASH_WITHOUT_STOCK  The branch takes the shelf as it stands in the books —
//                       a BRANCH stock custody, NOT counted. A drawer still in
//                       use by one open shift stays that shift's, and that
//                       shift waits on the ordinary morning count before it
//                       sells. A drawer nobody's open shift uses is closed at
//                       the figure its last shift counted at close (or no
//                       figure, said so, when there is none).
//   STOCK_WITHOUT_CASH  The open shift trading on the shelf gets the drawer
//                       custody it is missing, at its own opening amount.
//
// Nothing is deleted or rewritten in place: periods are closed and opened,
// the gate change is recorded, and the act carries a HANDOVER reason, a note,
// the actor, an OpeningException (MANAGER_ADJUSTMENT) and one audit row with
// the whole before/after. A repeat with the same idempotency key answers with
// the first result instead of a refusal.

import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import {
  incompleteOpeningCustody,
  LIVE_HANDOVER_STATUSES,
  openCustodyPeriod,
  reconcileStrandedShifts,
  transferCustody,
} from "@/lib/custody";
import { assertHandoverReason } from "@/lib/handover";
import { acquireInventoryExclusiveLock } from "@/lib/inventory-freeze";

export const BRANCH_CUSTODY_REPAIRED_AUDIT_ACTION = "BRANCH_CUSTODY_REPAIRED";

const NOTE_REQUIRED = "لازم تكتب اللي حصل قبل إصلاح عهدة الفرع";
const REASON_SUBJECT = "إصلاح عهدة الفرع";
const LIVE_HANDOVER = "في تسليم عهدة شغال في الفرع — اتعامل معاه من صفحة «التسليم والاستلام» (إنهاء أو اعتماد)، مش من هنا";
const NOTHING_TO_REPAIR = "عهدة الفرع سليمة — مفيش حاجة تتصلح، والشيفت يقدر يتفتح عادي";
const INCONSISTENT = "عهدة الدرج مسجلة باسم الفرع — ده وضع قديم محتاج مراجعة فنية، مش هيتصلح من هنا";
const SHARED_DRAWER = "أكتر من شيفت مفتوح على الدرج ده — اقفل الشيفتات الزيادة الأول وبعدين أصلح العهدة";
const NO_STOCK_HOLDER = "عهدة المخزن مفتوحة باسم موظف مفيش له شيفت مفتوح — حاول تاني";

export type BranchCustodyRepairResult = {
  repaired: "CASH_WITHOUT_STOCK" | "STOCK_WITHOUT_CASH";
  branchStockCustodyId: string | null;
  openedCashCustodyId: string | null;
  closedCashCustodyId: string | null;
  closingCashAmount: number | null;
  waitingShiftId: string | null;
  openingExceptionId: string;
  alreadyRepaired: boolean;
};

export async function repairBranchCustody(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    actorId: string;
    reasonCodeId: string | null | undefined;
    note: string | null | undefined;
    idempotencyKey: string;
  },
): Promise<BranchCustodyRepairResult> {
  const note = args.note?.trim() ?? "";
  if (!note) throw new ApiError(400, NOTE_REQUIRED);

  // Every custody writer at the branch waits for this, and this waits for
  // them: the state read below cannot change until the repair commits.
  await acquireInventoryExclusiveLock(tx, args.branchId);

  const replay = await tx.auditLog.findFirst({
    where: {
      cafeId: args.cafeId, action: BRANCH_CUSTODY_REPAIRED_AUDIT_ACTION, entity: "Branch", entityId: args.branchId,
      details: { path: ["idempotencyKey"], equals: args.idempotencyKey },
    },
    select: { details: true },
  });
  if (replay) {
    const result = (replay.details as { result: BranchCustodyRepairResult }).result;
    return { ...result, alreadyRepaired: true };
  }

  await assertHandoverReason(tx, args.reasonCodeId, args.cafeId, REASON_SUBJECT);

  const live = await tx.handoverSession.count({ where: { branchId: args.branchId, status: { in: [...LIVE_HANDOVER_STATUSES] } } });
  if (live > 0) throw new ApiError(409, LIVE_HANDOVER);

  // What the open does first; an orphaned employee shelf is not this act's.
  await reconcileStrandedShifts(tx, args.branchId);

  const [cash, stock] = await Promise.all([
    tx.custodyPeriod.findFirst({ where: { branchId: args.branchId, scope: "CASH", status: "OPEN" } }),
    tx.custodyPeriod.findFirst({ where: { branchId: args.branchId, scope: "STOCK", status: "OPEN" }, include: { participants: { select: { userId: true } } } }),
  ]);
  const verdict = incompleteOpeningCustody(cash?.holderType, stock?.holderType);
  if (!verdict) throw new ApiError(409, NOTHING_TO_REPAIR);
  if (verdict === "INCONSISTENT_CUSTODY") throw new ApiError(409, INCONSISTENT);

  const now = new Date();
  const result: Omit<BranchCustodyRepairResult, "openingExceptionId" | "alreadyRepaired"> = {
    repaired: verdict,
    branchStockCustodyId: null,
    openedCashCustodyId: null,
    closedCashCustodyId: null,
    closingCashAmount: null,
    waitingShiftId: null,
  };
  let previousGate: string | null = null;

  if (verdict === "CASH_WITHOUT_STOCK") {
    const drawer = cash!;
    const users = await tx.shiftCustody.findMany({
      where: { custodyPeriodId: drawer.id, shift: { status: "OPEN" } },
      select: { shift: { select: { id: true, custodyGateReason: true } } },
    });
    if (users.length > 1) throw new ApiError(409, SHARED_DRAWER);

    if (users.length === 1) {
      // The drawer is in use: it stays that shift's. Stock handover v2: the
      // shift is not held back by stock — it takes the shelf below (recorded,
      // uncounted) and keeps working.
      const shift = users[0].shift;
      previousGate = shift.custodyGateReason;
      result.waitingShiftId = shift.id;
    } else {
      // Nobody working holds it. Closed at what its last shift counted at
      // close — evidence from that night, not a figure invented now.
      const last = await tx.shiftCustody.findFirst({
        where: { custodyPeriodId: drawer.id, shift: { status: "CLOSED" } },
        orderBy: { shift: { closedAt: "desc" } },
        select: { shift: { select: { actualCashAmount: true } } },
      });
      const counted = last?.shift.actualCashAmount ?? null;
      await tx.custodyPeriod.update({
        where: { id: drawer.id },
        data: { status: "CLOSED", endedAt: now, closingCashAmount: counted },
      });
      result.closedCashCustodyId = drawer.id;
      result.closingCashAmount = counted === null ? null : Number(counted);
    }

    const opened = await openCustodyPeriod(tx, {
      cafeId: args.cafeId,
      branchId: args.branchId,
      scope: "STOCK",
      participants: [],
      shiftId: null,
      holderType: "BRANCH",
      openedById: args.actorId,
      responsibleShiftId: null,
    });
    result.branchStockCustodyId = opened.custodyPeriodId;
    if (result.waitingShiftId) {
      const holder = await tx.shift.findUniqueOrThrow({ where: { id: result.waitingShiftId }, select: { cashierId: true } });
      const taken = await transferCustody(tx, {
        outgoingPeriodId: opened.custodyPeriodId,
        scope: "STOCK",
        incoming: { participants: [{ userId: holder.cashierId, role: "PRIMARY" }], shiftId: result.waitingShiftId, responsibleShiftId: result.waitingShiftId, holderType: "USER", openedById: args.actorId },
        actorId: args.actorId,
      });
      await tx.shift.update({ where: { id: result.waitingShiftId }, data: { custodyGateReason: null, custodyReadyAt: now } });
      result.branchStockCustodyId = taken.incomingPeriodId;
    }
  } else {
    // STOCK_WITHOUT_CASH: someone is trading on the shelf with no drawer
    // custody recorded. Reconciliation already moved an orphaned shelf, so a
    // USER shelf still open here is answered for by an open shift.
    const shelf = stock!;
    const holder = await tx.shift.findFirst({
      where: {
        branchId: args.branchId, status: "OPEN",
        OR: [
          ...(shelf.responsibleShiftId ? [{ id: shelf.responsibleShiftId }] : []),
          ...(shelf.participants.length ? [{ cashierId: { in: shelf.participants.map((p) => p.userId) } }] : []),
        ],
      },
      orderBy: { openedAt: "asc" },
      select: { id: true, cashierId: true, openingCashAmount: true },
    });
    if (!holder) throw new ApiError(409, NO_STOCK_HOLDER);
    const opened = await openCustodyPeriod(tx, {
      cafeId: args.cafeId,
      branchId: args.branchId,
      scope: "CASH",
      participants: [{ userId: holder.cashierId, role: "PRIMARY" }],
      shiftId: holder.id,
      holderType: "USER",
      openedById: args.actorId,
      openingCashAmount: Number(holder.openingCashAmount),
    });
    result.openedCashCustodyId = opened.custodyPeriodId;
  }

  const exception = await tx.openingException.create({
    data: {
      cafeId: args.cafeId,
      branchId: args.branchId,
      shiftId: result.waitingShiftId,
      custodyPeriodId: result.branchStockCustodyId ?? result.openedCashCustodyId,
      kind: "MANAGER_ADJUSTMENT",
      reasonCodeId: args.reasonCodeId!,
      note,
      authorizedById: args.actorId,
    },
    select: { id: true },
  });

  const full: BranchCustodyRepairResult = { ...result, openingExceptionId: exception.id, alreadyRepaired: false };
  await auditInTransaction(tx, {
    cafeId: args.cafeId,
    userId: args.actorId,
    action: BRANCH_CUSTODY_REPAIRED_AUDIT_ACTION,
    entity: "Branch",
    entityId: args.branchId,
    details: {
      idempotencyKey: args.idempotencyKey,
      reasonCodeId: args.reasonCodeId,
      note,
      before: {
        cash: cash ? { id: cash.id, holderType: cash.holderType } : null,
        stock: stock ? { id: stock.id, holderType: stock.holderType } : null,
      },
      previousGate,
      shelfCounted: false,
      result: full,
    },
  });
  return full;
}
