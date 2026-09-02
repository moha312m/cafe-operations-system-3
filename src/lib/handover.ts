// A handover exists because a shift closed into one.
//
// ── WHY THERE IS NO `startHandover` ──
//
// R1 had three commits where there should have been one: close the shift,
// then create the handover, then acquire the freeze. Between them the shelf
// was live. A sale, a stock transfer or a purchase confirm landing in either
// gap moved inventory AFTER the custodian had been told their drawer was
// settled, and every count taken afterwards described a shelf that had
// already drifted past the boundary it claimed to measure.
//
// The fix is not a lock around the second and third commits. It is removing
// the API that could sit in the gap: nothing in this module is routable. The
// only way to create a `HandoverSession` is to close a shift whose branch
// policy requires one, and `closeShiftWithSettlement` calls
// `createHandoverInClose` inside the transaction that settles the money. The
// handover, its required-item snapshot and the durable freeze become facts in
// the same commit as the cash, or none of them do.
//
// ── WHAT THIS MODULE DOES NOT DECIDE ──
//
// It does not write `target`. SH-14's `persistRequiredItems` is the single
// writer of the immutable target, and it claims the row with a `target: null`
// guard so a second writer cannot exist. This module creates the session with
// a null target and hands the intent to SH-14 — which is why the ordering
// below is create-then-snapshot and not the other way round.
//
// It does not write `resolvedTarget` or `acceptedStockCountSessionId`. Those
// are answers about how the handover ENDED, and it has not started yet.
//
// It does not build a stock boundary. SH-15 can price a shelf, but the
// boundary that matters is the accepted one, and acceptance is SH-20's.
//
// ── CUSTODY ──
//
// The handover binds the custody the CLOSING SHIFT actually held, read from
// its own `ShiftCustody` links, not "whatever is open at the branch right
// now". Those are different facts whenever a branch has more than one shift,
// and only the first one names who is being discharged.
//
// `BRANCH_CUSTODY` is the one target that ends employee custody of the
// drawer, so it discharges the outgoing CASH period with the reconciled
// figure and opens NO successor: nobody has been appointed to hold it, and
// inventing a holder is exactly the invention this whole milestone exists to
// prevent. `SHIFT_TO_SHIFT` leaves CASH open, because SH-20's accept moves it
// to the arriving custodian atomically. STOCK is untouched by either: the
// shelf changes hands when the count is accepted, not when the money is.
//
// A legacy shift with no custody link gets none invented. An unattributable
// drawer is a fact about a shift that closed before custody existed, and
// writing a plausible answer over it would be a worse record than the gap.

import type { HandoverTarget, Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import type { HandoverBlocker } from "@/lib/handover-blockers";
import {
  persistRequiredItems,
  planRequiredItems,
} from "@/lib/handover-required-items";
import { acquireInventoryFreeze } from "@/lib/inventory-freeze";

export const HANDOVER_STARTED_AUDIT_ACTION = "HANDOVER_STARTED";

/**
 * A 409 that carries its evidence.
 *
 * `ApiError` deliberately holds nothing but a status and a message, and it is
 * shared by every route in the application — widening it so one feature can
 * attach a payload would change the error contract everywhere. The close
 * route unwraps this subclass itself and serialises `blockers` beside the
 * ordinary `{ error }` body, so the global shape is untouched.
 *
 * The list is every reason at once, never the first one found: a café told to
 * fix one blocker, then another, then another, learns to distrust the answer.
 */
export class HandoverBlockedError extends ApiError {
  readonly blockers: HandoverBlocker[];

  constructor(blockers: HandoverBlocker[]) {
    super(409, "لا يمكن بدء تسليم العهدة: في حاجات لسه مفتوحة");
    this.name = "HandoverBlockedError";
    this.blockers = blockers;
  }
}

/** What the outgoing shift was actually holding when it closed. */
export type OutgoingCustody = {
  cashCustodyId: string | null;
  stockCustodyId: string | null;
};

/** The CASH discharge a `BRANCH_CUSTODY` close performs, or its absence. */
export type CashCustodyFinalization = {
  closedCashCustodyId: string | null;
  closingCashAmount: number | null;
  /** Always false. Named rather than implied, because it is the decision. */
  successorOpened: boolean;
};

/**
 * The custody periods this shift is linked to, whatever their status.
 *
 * Resolution is by link, not by "currently OPEN at the branch": a shift that
 * is being discharged right now may already have had its CASH period closed
 * earlier in this same transaction, and the handover still has to name it.
 */
export async function resolveOutgoingCustodyForShift(
  tx: Prisma.TransactionClient,
  outgoingShiftId: string
): Promise<OutgoingCustody> {
  const links = await tx.shiftCustody.findMany({
    where: { shiftId: outgoingShiftId },
    select: { scope: true, custodyPeriodId: true },
  });
  return {
    cashCustodyId: links.find((l) => l.scope === "CASH")?.custodyPeriodId ?? null,
    stockCustodyId: links.find((l) => l.scope === "STOCK")?.custodyPeriodId ?? null,
  };
}

/**
 * Close the outgoing CASH custody at financial close, with no successor.
 *
 * `BRANCH_CUSTODY` only. The period is verified to belong to this café, this
 * branch, this scope and this shift before anything is written — a custody
 * period is the record of who was answerable for money, and closing the wrong
 * one would discharge somebody who is still holding a drawer.
 *
 * No audit row is written here. The discharge is part of one act, and the act
 * is recorded once, in the `SHIFT_CLOSED` details the caller writes. A second
 * action name for the same event would let the two disagree.
 */
export async function finalizeCashCustodyAtFinancialClose(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    outgoingShiftId: string;
    actualCash: number;
  }
): Promise<CashCustodyFinalization> {
  const { cashCustodyId } = await resolveOutgoingCustodyForShift(
    tx,
    args.outgoingShiftId
  );
  const absent: CashCustodyFinalization = {
    closedCashCustodyId: null,
    closingCashAmount: null,
    successorOpened: false,
  };
  // A shift that never held a CASH custody has nothing to discharge, and one
  // must not be conjured so the record looks complete.
  if (!cashCustodyId) return absent;

  const period = await tx.custodyPeriod.findFirst({
    where: {
      id: cashCustodyId,
      cafeId: args.cafeId,
      branchId: args.branchId,
      scope: "CASH",
    },
    select: { id: true, status: true },
  });
  if (!period) {
    throw new ApiError(409, "عهدة الخزنة المرتبطة بالشيفت مش تابعة للفرع");
  }
  if (period.status !== "OPEN") return absent;

  await tx.custodyPeriod.update({
    where: { id: period.id },
    data: {
      status: "CLOSED",
      endedAt: new Date(),
      // What was counted, not what was expected. The variance is a separate
      // finding on the shift; the drawer closes at the figure that was there.
      closingCashAmount: args.actualCash,
    },
  });

  return {
    closedCashCustodyId: period.id,
    closingCashAmount: args.actualCash,
    successorOpened: false,
  };
}

/**
 * Create the DRAFT session. Internal to the close; never routed on its own.
 *
 * `target` is accepted and recorded in the audit, but deliberately NOT
 * written to the row: SH-14's `persistRequiredItems` is the only writer of
 * the immutable target, and it claims the session with a `target: null`
 * guard. Writing it here would create a second writer of the one column this
 * milestone promises can never be rewritten.
 */
export async function createHandoverSession(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    outgoingShiftId: string;
    outgoingUserId: string;
    target: HandoverTarget;
    outgoingCashCustodyId: string | null;
    outgoingStockCustodyId: string | null;
  }
): Promise<{ handoverId: string }> {
  const created = await tx.handoverSession.create({
    data: {
      cafeId: args.cafeId,
      branchId: args.branchId,
      status: "DRAFT",
      outgoingShiftId: args.outgoingShiftId,
      outgoingUserId: args.outgoingUserId,
      outgoingCashCustodyId: args.outgoingCashCustodyId,
      outgoingStockCustodyId: args.outgoingStockCustodyId,
    },
    select: { id: true },
  });
  return { handoverId: created.id };
}

/**
 * The handover half of the atomic close.
 *
 * Runs on the CALLER's transaction and opens none of its own — a nested
 * transaction here would be a fourth commit boundary and would reintroduce
 * exactly the gap this module exists to remove.
 *
 * The order is load-bearing:
 *
 *   1. plan the required items against the STATED target, before anything is
 *      written, so a configuration that cannot produce a scope refuses while
 *      the shift is still open;
 *   2. read the closing shift's own custody links;
 *   3. create the DRAFT session with a null target;
 *   4. let SH-14 persist the snapshot, which is what writes the target;
 *   5. acquire the durable freeze, inside the EXCLUSIVE branch lock the
 *      caller already holds.
 *
 * Step 5 last is deliberate: the freeze names the handover, so the handover
 * has to exist, and every earlier step is still inside this transaction if it
 * throws.
 */
export async function createHandoverInClose(
  tx: Prisma.TransactionClient,
  args: {
    cafeId: string;
    branchId: string;
    outgoingShiftId: string;
    outgoingUserId: string;
    at: Date;
    target: HandoverTarget;
  }
): Promise<{ handoverId: string; freezeId: string; requiredItemCount: number }> {
  const plan = await planRequiredItems(tx, {
    cafeId: args.cafeId,
    branchId: args.branchId,
    at: args.at,
    target: args.target,
  });

  const custody = await resolveOutgoingCustodyForShift(tx, args.outgoingShiftId);

  const { handoverId } = await createHandoverSession(tx, {
    cafeId: args.cafeId,
    branchId: args.branchId,
    outgoingShiftId: args.outgoingShiftId,
    outgoingUserId: args.outgoingUserId,
    target: args.target,
    outgoingCashCustodyId: custody.cashCustodyId,
    outgoingStockCustodyId: custody.stockCustodyId,
  });

  const { requiredItemCount } = await persistRequiredItems(tx, {
    handoverId,
    plan,
  });

  const { freezeId } = await acquireInventoryFreeze(tx, {
    cafeId: args.cafeId,
    branchId: args.branchId,
    handoverId,
    startedById: args.outgoingUserId,
  });

  await auditInTransaction(tx, {
    cafeId: args.cafeId,
    userId: args.outgoingUserId,
    action: HANDOVER_STARTED_AUDIT_ACTION,
    entity: "HandoverSession",
    entityId: handoverId,
    details: {
      branchId: args.branchId,
      outgoingShiftId: args.outgoingShiftId,
      target: args.target,
      stockMode: plan.mode,
      requiredItemTrigger: plan.trigger,
      requiredItemCount,
      businessDate: plan.businessDate,
      outgoingCashCustodyId: custody.cashCustodyId,
      outgoingStockCustodyId: custody.stockCustodyId,
      freezeId,
    },
  });

  return { handoverId, freezeId, requiredItemCount };
}
