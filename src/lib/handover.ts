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

import type {
  HandoverStockMode,
  HandoverTarget,
  Prisma,
  RequiredItemTrigger,
  StockCountStatus,
  StockCountType,
} from "@prisma/client";
import { ApiError } from "@/lib/api";
import { audit, auditInTransaction } from "@/lib/audit";
import { db } from "@/lib/db";
import type { HandoverBlocker } from "@/lib/handover-blockers";
import {
  persistRequiredItems,
  planRequiredItems,
} from "@/lib/handover-required-items";
import {
  EFFECTIVE_EVIDENCE_SELECT,
  effectiveCountEvidence,
} from "@/lib/count-evidence";
import { acquireInventoryFreeze, activeFreezeFor } from "@/lib/inventory-freeze";
import { ACTIVE_COUNT_STATUSES, COUNT_STARTED_AUDIT_ACTION } from "@/lib/stock-count";

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

// ─────────────────── SH-18 · the count that answers to a handover ────────
//
// SH-17 built deferred accountability — a count whose `accountabilityContext`
// is HANDOVER confirms without opening a single generic variance case,
// because nobody has accepted the figure yet. Nothing could reach it. The
// ordinary `POST /api/stock-counts` derives its scope from TODAY's branch
// configuration and creates `accountabilityContext = NONE`, and widening it
// to sometimes mean something else would have made every ordinary count a
// question about whether a handover happened to be open.
//
// So the handover-bound start lives here, in the module that owns the
// handover, and it takes the handover's id explicitly. It never creates a
// `HandoverSession` — the close is still the only writer of those — and it
// never asks the branch what should be counted. The answer to that was fixed
// at close time, in `HandoverRequiredItem`, and re-deriving it now would let
// an owner flipping a policy at 2 a.m. silently change what the custodian who
// closed an hour ago is answerable for.

const HANDOVER_NOT_FOUND = "التسليم مش موجود";
const FOREIGN_BRANCH = "ليس لديك صلاحية على فرع تاني";

/** Postgres unique-violation, however it reaches us. */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return code === "P2002" || code === "23505";
}

/**
 * Take the handover's row lock for the rest of the transaction.
 *
 * The same idiom `lockShift` uses (`src/lib/cash-close.ts`), and for the same
 * reason: the caller re-reads through Prisma once the lock is held, so the
 * state it validates is the state it is about to write rather than one read a
 * moment earlier that a concurrent request may already have moved.
 */
async function lockHandover(
  tx: Prisma.TransactionClient,
  handoverId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "HandoverSession" WHERE "id" = ${handoverId} FOR UPDATE
  `;
  return rows.length > 0;
}

export type StartHandoverCountResult = {
  countSessionId: string;
  type: StockCountType;
  scopeItemIds: string[];
  /** True when a retry found the count already open and created nothing. */
  reused: boolean;
};

/**
 * Open the stock count this handover is answerable for, or return the one
 * that is already open.
 *
 * Idempotent by design rather than by idempotency key: the handover already
 * carries a single-count pointer, and the retry answer is "here is the count
 * you started", not a second count. Two simultaneous callers serialise on the
 * row lock; the loser re-reads the pointer under the lock it now holds and
 * receives the winner's session. The branch's partial unique index
 * (`StockCountSession_one_active_per_branch`) is the backstop, and a
 * violation that still escapes is answered by re-reading the pointer rather
 * than by surfacing a 409 to somebody who asked for a state that now exists.
 */
export async function startHandoverCount(args: {
  handoverId: string;
  actorId: string;
  cafeId: string;
  viewerBranchId: string | null;
}): Promise<StartHandoverCountResult> {
  const outcome = await db.$transaction(async (tx) => {
    if (!(await lockHandover(tx, args.handoverId))) {
      throw new ApiError(404, HANDOVER_NOT_FOUND);
    }

    const handover = await tx.handoverSession.findUniqueOrThrow({
      where: { id: args.handoverId },
      select: {
        id: true,
        cafeId: true,
        branchId: true,
        status: true,
        target: true,
        stockMode: true,
        requiredItemTrigger: true,
        outgoingShiftId: true,
        outgoingStockCustodyId: true,
        stockCountSessionId: true,
        requiredItems: {
          select: { inventoryItemId: true, unitSnapshot: true, omitted: true },
          orderBy: { itemNameSnapshot: "asc" },
        },
        outgoingShift: {
          select: {
            status: true,
            financiallyClosedAt: true,
            stockClosedAt: true,
          },
        },
      },
    });

    // Another tenant's handover is not confirmed to exist. A 403 here would
    // tell one café that an id belonging to another one is real.
    if (handover.cafeId !== args.cafeId) {
      throw new ApiError(404, HANDOVER_NOT_FOUND);
    }
    if (args.viewerBranchId !== null && handover.branchId !== args.viewerBranchId) {
      throw new ApiError(403, FOREIGN_BRANCH);
    }

    // DRAFT alone. `REJECTED → DRAFT` is SH-19's transition, and every later
    // status has already consumed or discarded the evidence.
    if (handover.status !== "DRAFT") {
      throw new ApiError(409, "التسليم مش في حالة تسمح ببدء الجرد");
    }

    // The snapshot is the scope. Without it there is nothing to count that is
    // not a fresh reading of today's configuration.
    if (
      handover.target === null ||
      handover.stockMode === null ||
      handover.requiredItemTrigger === null
    ) {
      throw new ApiError(409, "لقطة التسليم ناقصة — مش ينفع نبدأ جرد عليها");
    }

    // The SH-16 boundary, exactly: money settled, shelf not yet handed over.
    // The shift is read and never written — re-closing it here would move the
    // boundary this count exists to measure.
    const shift = handover.outgoingShift;
    if (
      shift.status !== "AWAITING_HANDOVER" ||
      shift.financiallyClosedAt === null ||
      shift.stockClosedAt !== null
    ) {
      throw new ApiError(409, "الشيفت مش في حالة تسليم عهدة");
    }

    // The freeze is what makes a count of this shelf meaningful. One that
    // names a different handover means the shelf is being held for somebody
    // else, and this count would describe a boundary it does not own.
    const freeze = await activeFreezeFor(tx, handover.branchId);
    if (!freeze || freeze.handoverId !== handover.id) {
      throw new ApiError(409, "تجميد المخزون مش مفتوح لهذا التسليم");
    }

    // Scope from the snapshot and nowhere else, in its recorded order.
    const scope = handover.requiredItems.filter((item) => !item.omitted);
    const scopeItemIds = scope.map((item) => item.inventoryItemId);

    // A retry, under the lock. The pointer is the single source of "which
    // count is current", so the answer comes from it rather than from a
    // search that could find a session belonging to a different handover.
    if (handover.stockCountSessionId !== null) {
      const existing = await tx.stockCountSession.findUnique({
        where: { id: handover.stockCountSessionId },
        select: { id: true, status: true, type: true, handoverId: true },
      });
      if (
        existing &&
        existing.handoverId === handover.id &&
        (ACTIVE_COUNT_STATUSES as readonly string[]).includes(existing.status)
      ) {
        return {
          countSessionId: existing.id,
          type: existing.type,
          scopeItemIds,
          reused: true,
          started: null,
        };
      }
      // CONFIRMED evidence is replaced by SH-19's `requestRecount`, not by
      // starting a second count behind it, and LOCKED is closed history.
      throw new ApiError(409, "في جرد متسجل للتسليم ده بالفعل");
    }

    // A session with no lines would submit and confirm vacuously, and read
    // afterwards as a branch that had been counted — `startCountSession`'s
    // own stated reason for the same refusal.
    if (scopeItemIds.length === 0) {
      throw new ApiError(400, "مفيش أصناف في لقطة التسليم ينفع تتعد");
    }

    const type: StockCountType = handover.stockMode === "FULL" ? "FULL" : "CRITICAL";
    const scopeDerivation =
      handover.stockMode === "FULL" ? "ALL_ELIGIBLE" : "CRITICAL_ONLY";

    let created: { id: string };
    try {
      created = await tx.stockCountSession.create({
        data: {
          cafeId: handover.cafeId,
          branchId: handover.branchId,
          // The shift being discharged and the STOCK custody it held — not
          // "whatever is open at the branch now", which is a different fact
          // the moment a branch runs more than one shift.
          shiftId: handover.outgoingShiftId,
          custodyPeriodId: handover.outgoingStockCustodyId,
          type,
          status: "DRAFT",
          scopeDerivation,
          initiatedById: args.actorId,
          // The whole point of SH-17, finally reachable from an application.
          accountabilityContext: "HANDOVER",
          handoverId: handover.id,
          // `mode` is deliberately omitted so the schema default BLIND
          // applies. Resolving the live blindness policy would be a second
          // read of current configuration inside a function whose contract
          // forbids one, and BLIND is the conservative answer either way.
          lines: {
            create: scope.map((item) => ({
              inventoryItemId: item.inventoryItemId,
              // The unit the handover was planned in, never today's.
              unit: item.unitSnapshot,
              disposition: "PENDING" as const,
            })),
          },
        },
        select: { id: true },
      });
    } catch (e) {
      // Somebody else's count claimed the branch's partial unique index. If
      // it was this handover's, the pointer now names it, and that is the
      // answer this caller asked for.
      if (isUniqueViolation(e)) {
        const raced = await tx.handoverSession.findUniqueOrThrow({
          where: { id: handover.id },
          select: { stockCountSessionId: true },
        });
        if (raced.stockCountSessionId) {
          const session = await tx.stockCountSession.findUniqueOrThrow({
            where: { id: raced.stockCountSessionId },
            select: { id: true, type: true },
          });
          return {
            countSessionId: session.id,
            type: session.type,
            scopeItemIds,
            reused: true,
            started: null,
          };
        }
      }
      throw e;
    }

    // The current-count pointer, and nothing else. No earlier session row is
    // edited or removed, which is what preserves recount history.
    await tx.handoverSession.update({
      where: { id: handover.id },
      data: { stockCountSessionId: created.id },
    });

    return {
      countSessionId: created.id,
      type,
      scopeItemIds,
      reused: false,
      // Everything the audit row needs, resolved where it is known to be
      // true. A reuse produced none of it and carries none of it.
      started: { branchId: handover.branchId, scopeDerivation },
    };
  });

  // Fire-and-forget, exactly as `startCountSession` audits its own start: the
  // session row is its own evidence, so losing the note would be worse than
  // losing the thing it describes. A reuse writes nothing and says nothing.
  if (outcome.started) {
    await audit({
      cafeId: args.cafeId,
      userId: args.actorId,
      action: COUNT_STARTED_AUDIT_ACTION,
      entity: "StockCountSession",
      entityId: outcome.countSessionId,
      details: {
        branchId: outcome.started.branchId,
        handoverId: args.handoverId,
        accountabilityContext: "HANDOVER",
        type: outcome.type,
        scopeDerivation: outcome.started.scopeDerivation,
        lineCount: outcome.scopeItemIds.length,
        // The derivation and the ids. An audit row is not a place to publish
        // a blind count's targets.
        inventoryItemIds: outcome.scopeItemIds,
      },
    });
  }

  return {
    countSessionId: outcome.countSessionId,
    type: outcome.type,
    scopeItemIds: outcome.scopeItemIds,
    reused: outcome.reused,
  };
}

// ──────────────────────── SH-18 · the closing position ───────────────────
//
// What the outgoing hand is SAYING about the shelf, read fresh from the
// evidence every time it is asked. Nothing here is written down.
//
// The temptation is to persist it — a `satisfied` flag on the required item,
// a `nonZeroVariances` count on the handover — and the reason not to is that
// a persisted position stops being a reading of the evidence and becomes a
// second claim that has to be kept in step with it. A correction approved
// after the flag was written would leave the two disagreeing, with nothing to
// say which one the business meant. `HandoverRequiredItem.satisfiedByLineId`
// is real and stays empty here: SH-20's `settleRequiredItems` writes it at
// ACCEPTANCE, when the answer stops changing.
//
// Historical intent comes from the immutable snapshot columns, never from the
// live `InventoryItem`. An item renamed, re-unitted or archived after the
// close is still the item this handover owes a count of, under the name it
// had when the custodian was told what they were answerable for.
//
// No tolerance is resolved and no blocking policy is read. Both are answers
// to "is this worth investigating", and a closing position asks the earlier
// question — "what do you say is on the shelf".

/** The outgoing hand's stated closing position. Derived, never persisted. */
export type ClosingPosition = {
  handoverId: string;
  mode: HandoverStockMode;
  requiredItemTrigger: RequiredItemTrigger;
  required: { total: number; satisfied: number; missingItemIds: string[] };
  stock: {
    countSessionId: string | null;
    countStatus: StockCountStatus | null;
    countedLines: number;
    nonZeroVarianceLines: number;
    linesMissingReason: string[];
    uncountedActiveItems: number;
  };
  prospectiveVariances: {
    lineId: string;
    quantityVariance: number;
    /** NULL when the impact is unavailable. Never 0 — VAR-007's wire rule. */
    amountVariance: number | null;
    reasonPresent: boolean;
  }[];
  /** Pre-existing cases at the branch. Never this count's, and never blocking. */
  openVarianceCaseIds: string[];
};

/** Everything the derivation reads from a bound count's lines. */
const CLOSING_POSITION_LINE_SELECT = {
  ...EFFECTIVE_EVIDENCE_SELECT,
  inventoryItemId: true,
  disposition: true,
  reasonCodeId: true,
  costImpact: true,
  costImpactAvailable: true,
} satisfies Prisma.StockCountLineSelect;

/**
 * Read the position off the evidence. Runs on the caller's transaction and
 * opens none of its own, so a submit can evaluate it under the same row lock
 * it is about to write under.
 */
export async function deriveClosingPosition(
  tx: Prisma.TransactionClient,
  handoverId: string
): Promise<ClosingPosition> {
  const handover = await tx.handoverSession.findUnique({
    where: { id: handoverId },
    select: {
      id: true,
      branchId: true,
      stockMode: true,
      requiredItemTrigger: true,
      stockCountSessionId: true,
      requiredItems: {
        select: { inventoryItemId: true, itemNameSnapshot: true, omitted: true },
        orderBy: { itemNameSnapshot: "asc" },
      },
    },
  });
  if (!handover) throw new ApiError(404, HANDOVER_NOT_FOUND);
  // A position has no meaning without the snapshot it is measured against.
  if (handover.stockMode === null || handover.requiredItemTrigger === null) {
    throw new ApiError(409, "لقطة التسليم ناقصة — مفيش موقف إقفال ينفع يتقرا");
  }

  const session =
    handover.stockCountSessionId === null
      ? null
      : await tx.stockCountSession.findUnique({
          where: { id: handover.stockCountSessionId },
          select: {
            id: true,
            status: true,
            handoverId: true,
            lines: {
              select: CLOSING_POSITION_LINE_SELECT,
              orderBy: { inventoryItem: { name: "asc" } },
            },
          },
        });
  // Evidence must be BOUND to be counted as this handover's. A session the
  // pointer names but that answers to another handover is not this one's word.
  const bound = session && session.handoverId === handover.id ? session : null;
  const lines = bound?.lines ?? [];

  // One resolution per line, reused by every figure below, so satisfaction
  // and variance can never disagree about which observation is in force.
  const resolved = lines.map((line) => ({
    line,
    evidence: effectiveCountEvidence(line),
  }));
  const counted = resolved.filter((r) => r.evidence.countedAt !== null);
  // One line per item is a schema guarantee (`@@unique([sessionId,
  // inventoryItemId])`), so the two readings below cannot disagree.
  const countedItemIds = new Set(counted.map((r) => r.line.inventoryItemId));

  const missingItemIds = handover.requiredItems
    .filter((item) => !countedItemIds.has(item.inventoryItemId))
    .map((item) => item.inventoryItemId);

  const nonZero = resolved.filter((r) => r.evidence.varianceQuantity !== 0);

  // Pre-existing cases at the branch, as information. A case whose evidence
  // is one of THIS count's lines is not pre-existing, it is this count's own
  // finding. `stockCountLineId` is nullable — a cash difference raises a case
  // with no line at all — and `NOT IN` would silently drop those to SQL's
  // three-valued logic, so the two arms are named explicitly.
  const ownLineIds = lines.map((line) => line.id);
  const cases = await tx.varianceCase.findMany({
    where: {
      branchId: handover.branchId,
      status: { in: ["OPEN", "UNDER_INVESTIGATION"] },
      ...(ownLineIds.length === 0
        ? {}
        : {
            OR: [
              { stockCountLineId: null },
              { stockCountLineId: { notIn: ownLineIds } },
            ],
          }),
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  return {
    handoverId: handover.id,
    mode: handover.stockMode,
    requiredItemTrigger: handover.requiredItemTrigger,
    required: {
      total: handover.requiredItems.length,
      satisfied: handover.requiredItems.length - missingItemIds.length,
      missingItemIds,
    },
    stock: {
      countSessionId: bound?.id ?? null,
      countStatus: bound?.status ?? null,
      countedLines: counted.length,
      nonZeroVarianceLines: nonZero.length,
      linesMissingReason: nonZero
        .filter((r) => r.line.reasonCodeId === null)
        .map((r) => r.line.id),
      uncountedActiveItems: resolved.length - counted.length,
    },
    prospectiveVariances: nonZero.map((r) => ({
      lineId: r.line.id,
      quantityVariance: r.evidence.varianceQuantity,
      // Unavailable is null, never zero: a shortage nobody can price is not
      // a shortage that cost nothing.
      amountVariance: r.line.costImpactAvailable ? Number(r.line.costImpact) : null,
      reasonPresent: r.line.reasonCodeId !== null,
    })),
    openVarianceCaseIds: cases.map((c) => c.id),
  };
}

// ───────────────────────── SH-18 · the outgoing submit ───────────────────
//
// `DRAFT → OUTGOING_SUBMITTED`, and the three questions that gate it.
//
// THE RULE THAT IS EASY TO GET WRONG. Every non-zero variance requires a
// reason, regardless of the tolerance verdict. Tolerance is the answer to "is
// this worth investigating" — it decides whether a case opens, and a café
// sets it precisely so small drifts do not generate paperwork. A handover
// asks the earlier and different question: "what do you say happened to the
// shelf you are handing over". "It was within tolerance" is not an answer to
// that, it is a statement that nobody needs to hear the answer. Wiring the
// reason requirement to tolerance would mean a custodian could hand over a
// shelf that had quietly drifted every single day, each drift individually
// unremarkable, with nothing on the record about any of them.
//
// For the same reason the predicate never asks whether an existing case is a
// blocking one, and never reads the café's variance blocking policy. Those
// govern whether an OPEN CASE stops the shop; they are about findings that
// already exist. A submit that
// consulted them would refuse a custodian for somebody else's unresolved
// investigation — including one raised on a different count entirely — and
// leave them with no action that could clear it. Pre-existing cases travel in
// `position.openVarianceCaseIds` as information, and never as a refusal.
//
// The refusal is the whole list, never the first one found. A café told to
// fix one thing, then another, then another, learns to distrust the answer —
// which is the reasoning `HandoverBlockedError` already applies to the close.

export const HANDOVER_SUBMITTED_AUDIT_ACTION = "HANDOVER_SUBMITTED";

export type HandoverSubmitRefusalCode =
  | "COUNT_NOT_CONFIRMED"
  | "REQUIRED_ITEMS_MISSING"
  | "VARIANCE_REASON_MISSING";

export type HandoverSubmitRefusal = {
  code: HandoverSubmitRefusalCode;
  count: number;
  message: string;
  /** The rows the code is about — item ids, or line ids. Empty when neither. */
  ids: string[];
};

/**
 * A 409 carrying EVERY applicable refusal, and the position that produced
 * them.
 *
 * A sibling of `HandoverBlockedError` and for the same stated reason:
 * `ApiError` holds nothing but a status and a message, and widening it so one
 * feature can attach a payload would change the error contract everywhere.
 * The route unwraps this subclass itself.
 */
export class HandoverSubmitRefusedError extends ApiError {
  readonly refusals: HandoverSubmitRefusal[];
  readonly position: ClosingPosition;

  constructor(refusals: HandoverSubmitRefusal[], position: ClosingPosition) {
    super(409, "مش ينفع تسلّم العهدة: في حاجات لسه ناقصة");
    this.name = "HandoverSubmitRefusedError";
    this.refusals = refusals;
    this.position = position;
  }
}

export type SubmitHandoverResult = {
  status: "OUTGOING_SUBMITTED";
  position: ClosingPosition;
  /** True when somebody had already submitted and this call wrote nothing. */
  alreadySubmitted: boolean;
};

/**
 * State the closing position, or refuse with every reason at once.
 *
 * The predicate is evaluated inside the same transaction and under the same
 * row lock as the transition, so a refusal cannot be computed against one
 * state and applied to another. A refusal rolls the transaction back, which
 * is what makes "a refused submit writes nothing" a property of the database
 * rather than of the ordering of the code.
 */
export async function submitHandover(args: {
  handoverId: string;
  outgoingUserId: string;
  cafeId: string;
  viewerBranchId: string | null;
}): Promise<SubmitHandoverResult> {
  return db.$transaction(async (tx) => {
    if (!(await lockHandover(tx, args.handoverId))) {
      throw new ApiError(404, HANDOVER_NOT_FOUND);
    }

    const handover = await tx.handoverSession.findUniqueOrThrow({
      where: { id: args.handoverId },
      select: { id: true, cafeId: true, branchId: true, status: true },
    });
    if (handover.cafeId !== args.cafeId) {
      throw new ApiError(404, HANDOVER_NOT_FOUND);
    }
    if (args.viewerBranchId !== null && handover.branchId !== args.viewerBranchId) {
      throw new ApiError(403, FOREIGN_BRANCH);
    }

    // Already stated. Saying so is the truthful answer to somebody asking for
    // a state that exists; what must never happen is a second transition.
    if (handover.status === "OUTGOING_SUBMITTED") {
      return {
        status: "OUTGOING_SUBMITTED" as const,
        position: await deriveClosingPosition(tx, handover.id),
        alreadySubmitted: true,
      };
    }
    if (handover.status !== "DRAFT") {
      throw new ApiError(409, "التسليم مش في حالة تسمح بالتسليم");
    }

    const position = await deriveClosingPosition(tx, handover.id);

    // Every predicate is evaluated. None of them returns early, because the
    // list is the feature.
    const refusals: HandoverSubmitRefusal[] = [];

    if (position.stock.countSessionId === null || position.stock.countStatus !== "CONFIRMED") {
      refusals.push({
        code: "COUNT_NOT_CONFIRMED",
        count: 1,
        message: "لازم تأكد جرد التسليم الأول",
        ids: [],
      });
    }

    if (position.required.missingItemIds.length > 0) {
      // Named from the immutable snapshot, so a custodian reads the names the
      // handover was planned with rather than whatever the shelf calls them
      // today.
      const missing = await tx.handoverRequiredItem.findMany({
        where: {
          handoverId: handover.id,
          inventoryItemId: { in: position.required.missingItemIds },
        },
        select: { itemNameSnapshot: true },
        orderBy: { itemNameSnapshot: "asc" },
      });
      refusals.push({
        code: "REQUIRED_ITEMS_MISSING",
        count: position.required.missingItemIds.length,
        message: `في أصناف مطلوبة لسه ماتعدتش (${missing.length}): ${missing
          .map((item) => item.itemNameSnapshot)
          .join("، ")}`,
        ids: position.required.missingItemIds,
      });
    }

    if (position.stock.linesMissingReason.length > 0) {
      refusals.push({
        code: "VARIANCE_REASON_MISSING",
        count: position.stock.linesMissingReason.length,
        message: `في فروقات من غير سبب (${position.stock.linesMissingReason.length}) — كل فرق لازم يتقال سببه`,
        ids: position.stock.linesMissingReason,
      });
    }

    if (refusals.length > 0) {
      refusals.sort((a, b) => a.code.localeCompare(b.code));
      throw new HandoverSubmitRefusedError(refusals, position);
    }

    // The guard and the write are one statement, so two callers racing cannot
    // both see DRAFT and both transition.
    const moved = await tx.handoverSession.updateMany({
      where: { id: handover.id, status: "DRAFT" },
      data: { status: "OUTGOING_SUBMITTED", submittedAt: new Date() },
    });
    if (moved.count === 0) {
      // Somebody else moved it between the lock being released upstream and
      // this write. Their transition stands; this call wrote nothing.
      return {
        status: "OUTGOING_SUBMITTED" as const,
        position,
        alreadySubmitted: true,
      };
    }

    await auditInTransaction(tx, {
      cafeId: handover.cafeId,
      userId: args.outgoingUserId,
      action: HANDOVER_SUBMITTED_AUDIT_ACTION,
      entity: "HandoverSession",
      entityId: handover.id,
      details: {
        branchId: handover.branchId,
        countSessionId: position.stock.countSessionId,
        requiredTotal: position.required.total,
        requiredSatisfied: position.required.satisfied,
        nonZeroVarianceLines: position.stock.nonZeroVarianceLines,
        // Counts and ids. A submit record is not a place to publish figures
        // the incoming reviewer has not been shown yet.
        openVarianceCaseIds: position.openVarianceCaseIds,
      },
    });

    return {
      status: "OUTGOING_SUBMITTED" as const,
      position,
      alreadySubmitted: false,
    };
  });
}
