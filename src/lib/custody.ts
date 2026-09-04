// Opening, linking, and transferring custody.
//
// Every mutator here takes a `Prisma.TransactionClient` rather than opening
// its own transaction, and that is the substance of this module rather than a
// style choice. A handover (T39) must close the outgoing custody, open the
// incoming one, rebase stock and write exceptions as ONE act. If closing and
// opening were separate transactions there would be an observable moment when
// a branch had no custodian — and a shortage found afterwards would have
// nobody to attribute it to. A function that opened its own transaction could
// not take part in that guarantee.
//
// The database enforces the same rule independently: T10's partial unique
// index permits at most one OPEN period per branch per scope. So even a
// caller that bypassed this module could not create the second custodian.
// The check below exists to produce a legible message, not to be the
// guarantee.

import type {
  Prisma,
  CustodyHolderType,
  CustodyPeriod,
  CustodyRole,
  CustodyScope,
  ShiftCustodyGate,
} from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";

type Participant = { userId: string; role: CustodyRole };

export type CustodyBootstrapVerdict = {
  cashCustodyPeriodId: string | null;
  stockCustodyPeriodId: string | null;
  opened: CustodyScope[];
  joined: CustodyScope[];
  withheld: CustodyScope[];
  operational: boolean;
  gate: ShiftCustodyGate | null;
};

const SCOPE_LABEL: Record<CustodyScope, string> = {
  CASH: "الخزنة",
  STOCK: "المخزن",
};

/**
 * Open a custody period, record who holds it, and optionally link the shift
 * that opened it — all inside the caller's transaction.
 */
export async function openCustodyPeriod(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    scope: CustodyScope;
    participants: Participant[];
    shiftId?: string | null;
    previousPeriodId?: string | null;
    openingCashAmount?: number | null;
    holderType?: CustodyHolderType;
    openedById?: string | null;
    responsibleShiftId?: string | null;
  }
): Promise<{ custodyPeriodId: string }> {
  const holderType = args.holderType ?? "USER";
  if (holderType === "BRANCH" && args.scope !== "STOCK") {
    throw new ApiError(400, "Branch custody is stock-only");
  }
  if (holderType === "USER" && args.participants.length === 0) {
    throw new ApiError(400, "لازم تحدد مين مسؤول عن العهدة");
  }

  // Legibility, not enforcement — the partial unique index is the guarantee.
  const existing = await tx.custodyPeriod.findFirst({
    where: { branchId: args.branchId, scope: args.scope, status: "OPEN" },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(
      409,
      `في عهدة ${SCOPE_LABEL[args.scope]} مفتوحة بالفعل في الفرع — لازم تتسلّم الأول`
    );
  }

  const period = await tx.custodyPeriod.create({
    data: {
      cafeId: args.cafeId,
      branchId: args.branchId,
      scope: args.scope,
      holderType,
      previousPeriodId: args.previousPeriodId ?? null,
      openedById: args.openedById ?? null,
      responsibleShiftId: args.responsibleShiftId ?? null,
      // A stock custody has no drawer, so the column stays NULL for it.
      openingCashAmount:
        args.scope === "CASH" ? args.openingCashAmount ?? null : null,
      participants: {
        create: args.participants.map((p) => ({ userId: p.userId, role: p.role })),
      },
    },
    select: { id: true },
  });

  if (args.shiftId) {
    await linkShiftCustody(tx, {
      shiftId: args.shiftId,
      custodyPeriodId: period.id,
      scope: args.scope,
    });
  }

  return { custodyPeriodId: period.id };
}

const LIVE_HANDOVER_STATUSES = ["DRAFT", "OUTGOING_SUBMITTED", "INCOMING_REVIEW"] as const;

/** Whether a live handover already names outgoing stock custody for this branch. */
export async function branchIsMidHandover(
  tx: Prisma.TransactionClient,
  branchId: string
): Promise<boolean> {
  return Boolean(await tx.handoverSession.findFirst({
    where: {
      branchId,
      status: { in: [...LIVE_HANDOVER_STATUSES] },
      outgoingStockCustodyId: { not: null },
    },
    select: { id: true },
  }));
}

/**
 * Establish the custody a newly-opened shift may use. This deliberately
 * records a gate rather than trying to invent a handover acceptance.
 */
export async function ensureCustodyForShift(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    shiftId: string;
    userId: string;
    openingCashAmount: number;
  }
): Promise<CustodyBootstrapVerdict> {
  const [cash, stock, midHandover] = await Promise.all([
    tx.custodyPeriod.findFirst({
      where: { branchId: args.branchId, scope: "CASH", status: "OPEN" },
      include: { participants: { select: { userId: true } } },
    }),
    tx.custodyPeriod.findFirst({
      where: { branchId: args.branchId, scope: "STOCK", status: "OPEN" },
      include: { participants: { select: { userId: true } } },
    }),
    branchIsMidHandover(tx, args.branchId),
  ]);

  const result: CustodyBootstrapVerdict = {
    cashCustodyPeriodId: null,
    stockCustodyPeriodId: null,
    opened: [],
    joined: [],
    withheld: [],
    operational: false,
    gate: null,
  };

  if (midHandover) {
    if (cash) result.withheld.push("CASH");
    if (stock) result.withheld.push("STOCK");
    result.gate = "AWAITING_CUSTODY_TRANSFER";
  } else if (stock?.holderType === "BRANCH") {
    if (cash?.holderType === "USER") {
      if (!cash.participants.some((p) => p.userId === args.userId)) {
        await tx.custodyParticipant.create({
          data: { custodyPeriodId: cash.id, userId: args.userId, role: "SHARED" },
        });
        result.joined.push("CASH");
      }
      await linkShiftCustody(tx, { shiftId: args.shiftId, custodyPeriodId: cash.id, scope: "CASH" });
      result.cashCustodyPeriodId = cash.id;
    } else if (!cash) {
      const opened = await openCustodyPeriod(tx, {
        cafeId: args.cafeId,
        branchId: args.branchId,
        scope: "CASH",
        participants: [{ userId: args.userId, role: "PRIMARY" }],
        shiftId: args.shiftId,
        holderType: "USER",
        openedById: args.userId,
        openingCashAmount: args.openingCashAmount,
      });
      result.cashCustodyPeriodId = opened.custodyPeriodId;
      result.opened.push("CASH");
    }
    result.withheld.push("STOCK");
    result.gate = "AWAITING_OPENING_VERIFICATION";
  } else if (!cash && !stock) {
    const openedCash = await openCustodyPeriod(tx, {
      cafeId: args.cafeId,
      branchId: args.branchId,
      scope: "CASH",
      participants: [{ userId: args.userId, role: "PRIMARY" }],
      shiftId: args.shiftId,
      holderType: "USER",
      openedById: args.userId,
      openingCashAmount: args.openingCashAmount,
    });
    const openedStock = await openCustodyPeriod(tx, {
      cafeId: args.cafeId,
      branchId: args.branchId,
      scope: "STOCK",
      participants: [{ userId: args.userId, role: "PRIMARY" }],
      shiftId: args.shiftId,
      holderType: "USER",
      openedById: args.userId,
      responsibleShiftId: args.shiftId,
    });
    result.cashCustodyPeriodId = openedCash.custodyPeriodId;
    result.stockCustodyPeriodId = openedStock.custodyPeriodId;
    result.opened.push("CASH", "STOCK");
    result.operational = true;
  } else if (cash?.holderType === "USER" && stock?.holderType === "USER") {
    for (const [scope, period] of [["CASH", cash], ["STOCK", stock]] as const) {
      if (!period.participants.some((p) => p.userId === args.userId)) {
        await tx.custodyParticipant.create({
          data: { custodyPeriodId: period.id, userId: args.userId, role: "SHARED" },
        });
        result.joined.push(scope);
      }
      await linkShiftCustody(tx, { shiftId: args.shiftId, custodyPeriodId: period.id, scope });
      if (scope === "CASH") result.cashCustodyPeriodId = period.id;
      else result.stockCustodyPeriodId = period.id;
    }
    result.operational = true;
  } else {
    throw new ApiError(409, "Open custody state is incomplete for this branch");
  }

  await tx.shift.update({
    where: { id: args.shiftId },
    data: result.gate
      ? { custodyGateReason: result.gate, custodyReadyAt: null }
      : { custodyGateReason: null, custodyReadyAt: new Date() },
  });
  return result;
}

/**
 * Link a shift to a custody period.
 *
 * `scope` is denormalised onto the row so the per-shift unique can exist:
 * one shift may hold one CASH and one STOCK custody, and no more of either.
 */
export async function linkShiftCustody(
  tx: Prisma.TransactionClient,
  args: { shiftId: string; custodyPeriodId: string; scope: CustodyScope }
): Promise<void> {
  await tx.shiftCustody.create({
    data: {
      shiftId: args.shiftId,
      custodyPeriodId: args.custodyPeriodId,
      scope: args.scope,
    },
  });
}

/**
 * Close one custody and open its successor, atomically.
 *
 * Deliberately does NOT touch variance cases. A variance belongs to the
 * custody under which it arose; carrying it forward would make the incoming
 * custodian answerable for a shortage created before they held anything.
 *
 * Two things the transfer records, both of which are the substance of an
 * acceptance rather than bookkeeping around it:
 *
 * `acceptedById`/`acceptedAt` land on the PREDECESSOR. Acceptance is an act
 * performed upon the custody being handed over — somebody looked at what was
 * there and took it on. The successor has not itself been accepted by anyone,
 * and stamping it would claim an event that has not happened.
 *
 * `responsibleShiftId` lands on a STOCK successor, because
 * `resolveStockAttribution` reads it and stamps it on every subsequent stock
 * movement. A successor without one makes each later sale unattributable and
 * SERVE refuses outright, so where a shift is named at all it is used: the
 * caller's explicit answer first, then the shift the successor is attached to
 * — the same rule `openShiftCustody` applies at its own STOCK open. A
 * successor attached to no shift stays shift-less, which is the state that
 * already existed and that SERVE already refuses; refusing to create it here
 * would be a new restriction rather than a repair.
 *
 * Cash carries none of that: responsibility for stock movement is a stock
 * concept, and a drawer has no shelf. Neither does a BRANCH holder — the point
 * of branch custody is that no shift was answerable, and inventing one to fill
 * the column would be the exact false attribution it exists to avoid.
 */
export async function transferCustody(
  tx: Prisma.TransactionClient,
  args: {
    outgoingPeriodId: string;
    scope: CustodyScope;
    incoming: {
      participants: Participant[];
      shiftId: string | null;
      /** STOCK only — the shift answerable for the successor period. */
      responsibleShiftId?: string | null;
      /** Defaults to USER. BRANCH is stock-only, and SH-22 is its consumer. */
      holderType?: CustodyHolderType;
      openedById?: string | null;
    };
    closingCashAmount?: number | null;
    actorId: string;
    /** Written onto the PREDECESSOR: who accepted this custody, and when. */
    acceptedById?: string | null;
    acceptedAt?: Date | null;
  }
): Promise<{ outgoingPeriodId: string; incomingPeriodId: string }> {
  const outgoing = await tx.custodyPeriod.findUnique({
    where: { id: args.outgoingPeriodId },
    select: { id: true, cafeId: true, branchId: true, scope: true, status: true },
  });
  if (!outgoing) throw new ApiError(404, "العهدة مش موجودة");
  if (outgoing.scope !== args.scope) {
    throw new ApiError(400, "نوع العهدة مش مطابق");
  }
  if (outgoing.status !== "OPEN") {
    throw new ApiError(409, "العهدة دي اتسلّمت خلاص");
  }

  const holderType = args.incoming.holderType ?? "USER";
  // See the note above: a shift-owned stock custody names the shift that
  // answers for it, and nothing else ever does.
  const responsibleShiftId =
    args.scope === "STOCK" && holderType === "USER"
      ? args.incoming.responsibleShiftId ?? args.incoming.shiftId ?? null
      : null;

  const endedAt = new Date();
  const acceptedAt = args.acceptedById ? args.acceptedAt ?? endedAt : args.acceptedAt ?? null;

  // Close first, so the partial unique index sees the slot free when the
  // successor is created a moment later in this same transaction.
  await tx.custodyPeriod.update({
    where: { id: outgoing.id },
    data: {
      status: "TRANSFERRED",
      endedAt,
      acceptedById: args.acceptedById ?? null,
      acceptedAt,
      closingCashAmount:
        args.scope === "CASH" ? args.closingCashAmount ?? null : null,
    },
  });

  const { custodyPeriodId: incomingPeriodId } = await openCustodyPeriod(tx, {
    cafeId: outgoing.cafeId,
    branchId: outgoing.branchId,
    scope: args.scope,
    participants: args.incoming.participants,
    shiftId: args.incoming.shiftId,
    previousPeriodId: outgoing.id,
    holderType,
    openedById: args.incoming.openedById ?? null,
    responsibleShiftId,
    // The incoming custodian starts holding what the outgoing one closed at.
    openingCashAmount: args.scope === "CASH" ? args.closingCashAmount ?? null : null,
  });

  // Written through the transaction client rather than the fire-and-forget
  // `audit()` helper, on purpose: a custody transfer recorded when the
  // transfer rolled back would be a false statement about who was
  // answerable, which is exactly what this record exists to settle.
  await tx.auditLog.create({
    data: {
      cafeId: outgoing.cafeId,
      userId: args.actorId,
      action: "CUSTODY_TRANSFERRED",
      entity: "CustodyPeriod",
      entityId: outgoing.id,
      details: {
        scope: args.scope,
        branchId: outgoing.branchId,
        outgoingPeriodId: outgoing.id,
        incomingPeriodId,
        incomingParticipants: args.incoming.participants.map((p) => p.userId),
        closingCashAmount: args.closingCashAmount ?? null,
        // Who accepted the custody that closed, and what answers for the one
        // that opened — the two facts an accountability reader needs and
        // could not previously reconstruct from this row.
        acceptedById: args.acceptedById ?? null,
        acceptedAt: acceptedAt?.toISOString() ?? null,
        responsibleShiftId,
        holderType,
      },
    },
  });

  return { outgoingPeriodId: outgoing.id, incomingPeriodId };
}

/** The branch's currently open custody of one scope, if any. */
export async function activeCustody(
  branchId: string,
  scope: CustodyScope
): Promise<CustodyPeriod | null> {
  return db.custodyPeriod.findFirst({
    where: { branchId, scope, status: "OPEN" },
  });
}
