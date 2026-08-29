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

import type { Prisma, CustodyPeriod, CustodyRole, CustodyScope } from "@prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";

type Participant = { userId: string; role: CustodyRole };

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
  }
): Promise<{ custodyPeriodId: string }> {
  if (args.participants.length === 0) {
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
      previousPeriodId: args.previousPeriodId ?? null,
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
 */
export async function transferCustody(
  tx: Prisma.TransactionClient,
  args: {
    outgoingPeriodId: string;
    scope: CustodyScope;
    incoming: { participants: Participant[]; shiftId: string | null };
    closingCashAmount?: number | null;
    actorId: string;
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

  const endedAt = new Date();

  // Close first, so the partial unique index sees the slot free when the
  // successor is created a moment later in this same transaction.
  await tx.custodyPeriod.update({
    where: { id: outgoing.id },
    data: {
      status: "TRANSFERRED",
      endedAt,
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
