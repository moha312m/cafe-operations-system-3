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
  HandoverStatus,
  HandoverStockMode,
  HandoverTarget,
  InventoryUnit,
  Prisma,
  RequiredItemTrigger,
  StockAckDecision,
  StockCountStatus,
  StockCountType,
} from "@prisma/client";
import { ApiError } from "@/lib/api";
import { audit, auditInTransaction } from "@/lib/audit";
import { round3 } from "@/lib/costing";
import { db } from "@/lib/db";
import { ledgerDeltaAbove } from "@/lib/ledger";
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
import {
  ACTIVE_COUNT_STATUSES,
  BLIND_LINE_FIELDS,
  COUNT_STARTED_AUDIT_ACTION,
  redactCountTargets,
} from "@/lib/stock-count";

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

// ────────────────── SH-19 · the reason a refusal has to carry ─────────────

/**
 * A HANDOVER-domain reason code of this café's, active, or a refusal that
 * says which of those it failed.
 *
 * Takes a client rather than reaching for `db`, because both callers run
 * inside the handover row lock and a validation read outside that transaction
 * could pass against a reason another request is deactivating.
 * `assertStockReason` (`src/lib/stock-count.ts`) is the shape being followed;
 * it takes no client only because its one caller needs none.
 *
 * `subject` is the Arabic noun phrase the three messages are built from, so
 * one gate serves both callers — the recount request and the line dispute —
 * without either of them borrowing the other's wording.
 *
 * "No such reason", "another café's reason" and "wrong domain" share ONE
 * message on purpose: three distinguishable answers would let a caller probe
 * whether an id exists in a café that is not theirs. "Stopped" gets its own,
 * because it is the only one of the four the caller can act on.
 */
export async function assertHandoverReason(
  client: Prisma.TransactionClient | typeof db,
  reasonCodeId: string | null | undefined,
  cafeId: string,
  subject: string
): Promise<void> {
  // The empty string takes this arm too. A body carrying `""` that slipped
  // past a truthiness check would reach `findUnique` on an empty id and be
  // refused as somebody else's rather than as missing.
  if (!reasonCodeId) throw new ApiError(400, `لازم تحدد ${subject}`);

  const reason = await client.reasonCode.findUnique({
    where: { id: reasonCodeId },
    select: { cafeId: true, domain: true, isActive: true },
  });
  if (!reason || reason.cafeId !== cafeId || reason.domain !== "HANDOVER") {
    throw new ApiError(400, `${subject} مش من أسباب التسليم بتاعة الكافيه`);
  }
  if (!reason.isActive) throw new ApiError(400, `${subject} ده متوقف`);
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

// ─────────────────────── SH-18 · the incoming blind review ───────────────
//
// The arriving custodian is about to sign for a shelf. If they can read the
// outgoing hand's figures first, the count they take is not evidence — it is
// a transcription, and the whole accountability chain rests on it.
//
// THE TRAP, stated plainly because it is the one a careful implementation
// walks into. `redactCountTargets` is the project's blindness primitive and
// it is EXACTLY WRONG here. It only removes anything when `countIsBlindTo` is
// true, which needs the session to be `BLIND` mode, in `DRAFT`/`IN_PROGRESS`,
// and the viewer to be its initiator or one of its counters. The incoming
// reviewer is none of those: the session they review is CONFIRMED, and they
// neither started it nor counted a line. Called here it returns the session
// untouched, so a view built on it would pass a blindness test while handing
// over every target in the response.
//
// So the pre-acknowledgement blindness is STRUCTURAL. The projection names no
// quantity column at all, which is `getCountSessionForViewer`'s own stated
// principle — "a field that is never selected cannot be forgotten by a
// redactor" — applied one step further out. `BLIND_LINE_FIELDS` is imported
// and asserted against the projection at module load, so the two cannot drift
// apart silently.
//
// Once the reviewer HAS looked — at least one `HandoverStockAcknowledgement`
// row for this handover — the count is disclosed through the one existing
// rule, applied unconditionally exactly as the count route applies it. There
// is no second redaction shape in the codebase after this file.
//
// This function writes NOTHING. It creates no acknowledgement, stamps no
// `reviewedAt`, and moves no status: `OUTGOING_SUBMITTED → INCOMING_REVIEW`
// is SH-19's transition, and acknowledgement rows are SH-19's to create.

/**
 * The pre-acknowledgement line projection: identity and progress, no figures.
 *
 * `countedQuantity`, `effectiveCountedQuantity`, `expectedQuantity`,
 * `varianceQuantity`, `costImpact`, `costImpactAvailable`,
 * `costUnavailableReason`, `itemVersion` and `expectedBasis` are absent from
 * the QUERY. Nothing downstream has to remember to remove them.
 */
const BLIND_HANDOVER_LINE_SELECT = {
  id: true,
  inventoryItemId: true,
  unit: true,
  disposition: true,
  countedAt: true,
  counterId: true,
  reasonCodeId: true,
  inventoryItem: { select: { id: true, name: true, category: true, unit: true } },
} satisfies Prisma.StockCountLineSelect;

// The drift guard, at module load. If somebody adds a blind field to
// `BLIND_LINE_FIELDS` and this projection ever grows it, the application
// refuses to start rather than quietly leaking it to a reviewer.
for (const field of BLIND_LINE_FIELDS) {
  if (field in BLIND_HANDOVER_LINE_SELECT) {
    throw new Error(`blind handover projection leaks ${field}`);
  }
}

/** The post-acknowledgement projection — the count route's own line shape. */
const DISCLOSED_HANDOVER_LINE_SELECT = {
  ...BLIND_HANDOVER_LINE_SELECT,
  countedQuantity: true,
  effectiveCountedQuantity: true,
  expectedQuantity: true,
  varianceQuantity: true,
  costImpact: true,
  costImpactAvailable: true,
  costUnavailableReason: true,
  expectedBasis: true,
  confidence: true,
  reasonNote: true,
} satisfies Prisma.StockCountLineSelect;

export type IncomingHandoverView = {
  handoverId: string;
  status: HandoverStatus;
  branchId: string;
  target: HandoverTarget | null;
  mode: HandoverStockMode | null;
  requiredItemTrigger: RequiredItemTrigger | null;
  outgoingUserId: string;
  submittedAt: Date | null;
  acknowledged: boolean;
  requiredItems: {
    inventoryItemId: string;
    itemNameSnapshot: string;
    unitSnapshot: InventoryUnit;
    isCriticalSnapshot: boolean;
  }[];
  count: {
    sessionId: string;
    status: StockCountStatus;
    type: StockCountType;
    confirmedAt: Date | null;
    /** Pre-acknowledgement, no quantity key exists on these objects at all. */
    lines: unknown[];
  } | null;
};

/** The statuses there is something to review in. */
const REVIEWABLE_HANDOVER_STATUSES: readonly HandoverStatus[] = [
  "OUTGOING_SUBMITTED",
  "INCOMING_REVIEW",
];

/**
 * What the arriving custodian may see, which is blind until they have taken
 * their own look.
 *
 * "Taken their own look" is defined exactly: at least one
 * `HandoverStockAcknowledgement` row naming this handover. Nothing else is
 * consulted — not `reviewedAt`, not the `INCOMING_REVIEW` status — because
 * SH-19 sets both of those FROM the first acknowledgement, and a view keyed
 * on a derived signal could disclose before the reviewer had actually counted.
 */
export async function incomingHandoverView(
  handoverId: string,
  viewerId: string,
  scope: { cafeId: string; viewerBranchId: string | null }
): Promise<IncomingHandoverView> {
  const handover = await db.handoverSession.findUnique({
    where: { id: handoverId },
    select: {
      id: true,
      cafeId: true,
      branchId: true,
      status: true,
      target: true,
      stockMode: true,
      requiredItemTrigger: true,
      outgoingUserId: true,
      submittedAt: true,
      stockCountSessionId: true,
      requiredItems: {
        select: {
          inventoryItemId: true,
          itemNameSnapshot: true,
          unitSnapshot: true,
          isCriticalSnapshot: true,
        },
        orderBy: { itemNameSnapshot: "asc" },
      },
      // Existence, not content. One row is enough to answer the question.
      stockAcknowledgements: { select: { id: true }, take: 1 },
    },
  });
  if (!handover || handover.cafeId !== scope.cafeId) {
    throw new ApiError(404, HANDOVER_NOT_FOUND);
  }
  if (scope.viewerBranchId !== null && handover.branchId !== scope.viewerBranchId) {
    throw new ApiError(403, FOREIGN_BRANCH);
  }
  if (!REVIEWABLE_HANDOVER_STATUSES.includes(handover.status)) {
    throw new ApiError(409, "التسليم مش في مرحلة مراجعة");
  }

  const acknowledged = handover.stockAcknowledgements.length > 0;

  const session =
    handover.stockCountSessionId === null
      ? null
      : await db.stockCountSession.findUnique({
          where: { id: handover.stockCountSessionId },
          select: {
            id: true,
            status: true,
            type: true,
            mode: true,
            confirmedAt: true,
            initiatedById: true,
            handoverId: true,
            lines: {
              select: acknowledged
                ? DISCLOSED_HANDOVER_LINE_SELECT
                : BLIND_HANDOVER_LINE_SELECT,
              orderBy: { inventoryItem: { name: "asc" } },
            },
          },
        });
  // Evidence that answers to another handover is not this review's subject.
  const bound = session && session.handoverId === handover.id ? session : null;

  // Applied unconditionally on the disclosed path, exactly as the count route
  // applies it: the residual case — a reviewer who is also the counter of a
  // still-blind session — is handled by the one existing rule rather than by
  // a second copy of it here.
  const lines =
    bound === null
      ? []
      : acknowledged
        ? redactCountTargets(bound, viewerId).lines
        : bound.lines;

  return {
    handoverId: handover.id,
    status: handover.status,
    branchId: handover.branchId,
    target: handover.target,
    mode: handover.stockMode,
    requiredItemTrigger: handover.requiredItemTrigger,
    outgoingUserId: handover.outgoingUserId,
    submittedAt: handover.submittedAt,
    acknowledged,
    // From the immutable snapshot columns. An item renamed or archived since
    // the close is still the item this handover was planned around.
    requiredItems: handover.requiredItems,
    count:
      bound === null
        ? null
        : {
            sessionId: bound.id,
            status: bound.status,
            type: bound.type,
            confirmedAt: bound.confirmedAt,
            lines,
          },
  };
}

/**
 * The branch's handovers, as a list with no figure in it.
 *
 * The same rule `COUNT_SESSION_SUMMARY` follows: a list is read by whoever is
 * about to count or about to review, so the safe shape is one that has no
 * target in it to leak rather than one a redactor is trusted to clean.
 * `requiredItemCount` is a count of items, not a quantity of anything.
 */
export async function listHandoversForViewer(args: {
  cafeId: string;
  branchId: string;
  status?: HandoverStatus;
}) {
  return db.handoverSession.findMany({
    where: {
      cafeId: args.cafeId,
      branchId: args.branchId,
      ...(args.status ? { status: args.status } : {}),
    },
    select: {
      id: true,
      branchId: true,
      status: true,
      target: true,
      outgoingShiftId: true,
      outgoingUserId: true,
      stockCountSessionId: true,
      requiredItemCount: true,
      submittedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

// ─────────────────── SH-19 · the incoming acknowledgement ────────────────
//
// The arriving custodian signs for one line at a time, and the signature is
// the thing SH-18's blindness was protecting: until the first acknowledgement
// exists, `incomingHandoverView` shows no figure at all. This function
// CREATES that first row and therefore causes the disclosure; it does not
// redesign it, and it touches neither the projection nor the redactor.
//
// What is signed for is not what was written down. `handedOverQuantity` is
// the effective counted figure PLUS every ledger movement above that figure's
// own cursor, which is the same arithmetic `rebaseFromCount` uses to land a
// count on the shelf. A count is taken at a moment; a shelf is handed over
// now, and the gap between the two is real stock.
//
// Three answers, and they are not interchangeable:
//
//   no spot count       → ACCEPTED, incomingCountedQuantity NULL, variance NULL
//   spot count, equal   → ACCEPTED, variance 0
//   spot count, differs → DISPUTED, and only with a HANDOVER reason
//
// NULL is not zero. "I signed for it without counting" and "I counted it and
// we agree" are different claims about what the reviewer actually did.
//
// NOTHING here writes to `StockCountLine`, `StockCountSession`, custody, the
// freeze or the shift. A dispute records disagreement with the outgoing
// hand's figure; it never edits it. And `HandoverSession.incomingUserId` is
// deliberately untouched — the actor is recorded on the acknowledgement row,
// and the handover-level incoming party is set when custody actually moves,
// which is SH-20's.

export const HANDOVER_LINE_ACKNOWLEDGED_AUDIT_ACTION = "HANDOVER_LINE_ACKNOWLEDGED";

export type AcknowledgeStockLineResult = {
  /** effectiveCountedQuantity + ledgerDeltaAbove(evidence.itemVersion). */
  handedOverQuantity: number;
  /** NULL when no spot count was taken. NULL is not zero. */
  varianceQuantity: number | null;
  decision: StockAckDecision;
};

/** The statuses an incoming custodian may sign in. */
const ACKNOWLEDGEABLE_STATUSES: readonly HandoverStatus[] = [
  "OUTGOING_SUBMITTED",
  "INCOMING_REVIEW",
];

const NOT_IN_REVIEW = "التسليم مش في مرحلة مراجعة";
const NO_BOUND_COUNT = "مفيش جرد مربوط بالتسليم ده";
const OLD_SESSION_LINE = "السطر ده من جرد قديم — الجرد الحالي هو اللي بيتراجع";
const ALREADY_ACKNOWLEDGED = "السطر ده متسجل استلامه قبل كده";

export async function acknowledgeStockLine(args: {
  handoverId: string;
  stockCountLineId: string;
  acknowledgedById: string;
  incomingCountedQuantity?: number | null;
  disputeReasonCodeId?: string;
  disputeNote?: string;
  cafeId: string;
  viewerBranchId: string | null;
}): Promise<AcknowledgeStockLineResult> {
  return db.$transaction(async (tx) => {
    if (!(await lockHandover(tx, args.handoverId))) {
      throw new ApiError(404, HANDOVER_NOT_FOUND);
    }

    // Re-read under the lock, so the state validated is the state written to.
    const handover = await tx.handoverSession.findUniqueOrThrow({
      where: { id: args.handoverId },
      select: {
        id: true,
        cafeId: true,
        branchId: true,
        status: true,
        stockCountSessionId: true,
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

    if (!ACKNOWLEDGEABLE_STATUSES.includes(handover.status)) {
      throw new ApiError(409, NOT_IN_REVIEW);
    }
    if (handover.stockCountSessionId === null) {
      throw new ApiError(409, NO_BOUND_COUNT);
    }

    const line = await tx.stockCountLine.findUnique({
      where: { id: args.stockCountLineId },
      select: {
        sessionId: true,
        inventoryItemId: true,
        ...EFFECTIVE_EVIDENCE_SELECT,
      },
    });
    if (!line) throw new ApiError(404, "سطر الجرد غير موجود");

    // ONE predicate, three of the stage's refusals: a line belonging to a
    // different handover, a line from a session this handover has superseded,
    // and a stale acknowledgement arriving after a recount. The current-count
    // pointer is the single source of "which count is being reviewed", so a
    // line the pointer does not name is not this review's subject.
    if (line.sessionId !== handover.stockCountSessionId) {
      throw new ApiError(409, OLD_SESSION_LINE);
    }

    // The quantity and its cursor come from ONE call, because they are only
    // correct together: a recount's figure measured from the first count's
    // cursor would replay the movements between them a second time.
    const evidence = effectiveCountEvidence(line);

    // Evaluated BEFORE any arithmetic. An uncounted line has no figure to
    // hand over, and letting a null reach the sum would surface either as a
    // NOT NULL violation on `handedOverQuantity` or as a silent zero — a
    // claim that the shelf was empty, which nobody made. It is the same
    // predicate `rebaseFromCount` uses to decide a line has nothing to act on.
    if (line.countedQuantity === null && evidence.recountId === null) {
      throw new ApiError(409, "السطر ده لسه ماتعدش — مش ينفع تستلمه");
    }

    const replay = await ledgerDeltaAbove(
      tx,
      line.inventoryItemId,
      // `BigInt(0)`, never the literal `0n`: tsconfig targets ES2017 and a
      // BigInt literal is TS2737.
      evidence.itemVersion ?? BigInt(0)
    );
    const handedOverQuantity = round3(evidence.quantity + replay.delta);

    let decision: StockAckDecision = "ACCEPTED";
    let incomingCountedQuantity: number | null = null;
    let varianceQuantity: number | null = null;
    let disputeReasonCodeId: string | null = null;
    let disputeNote: string | null = null;

    if (
      args.incomingCountedQuantity !== undefined &&
      args.incomingCountedQuantity !== null
    ) {
      incomingCountedQuantity = round3(args.incomingCountedQuantity);
      varianceQuantity = round3(incomingCountedQuantity - handedOverQuantity);
      if (varianceQuantity !== 0) {
        // Inside the lock, so the reason cannot be deactivated between the
        // check and the write. A missing one raises 400 and the whole
        // transaction rolls back, leaving no row and no transition.
        await assertHandoverReason(
          tx,
          args.disputeReasonCodeId,
          handover.cafeId,
          "سبب الاختلاف"
        );
        decision = "DISPUTED";
        disputeReasonCodeId = args.disputeReasonCodeId ?? null;
        disputeNote = args.disputeNote ?? null;
      }
      // variance === 0 stays ACCEPTED. A dispute reason may have been sent
      // and is ignored: there is nothing to disagree about.
    }

    // A courtesy check under the lock; the database's own
    // `@@unique([handoverId, stockCountLineId])` is what actually decides,
    // and the catch below converts the losing racer into the same refusal.
    // An acknowledgement is a SIGNATURE — answering "yes, that is signed" to
    // a second, possibly different, spot count would let a reviewer believe
    // their figure was recorded when the first one stands.
    const existing = await tx.handoverStockAcknowledgement.findUnique({
      where: {
        handoverId_stockCountLineId: {
          handoverId: handover.id,
          stockCountLineId: args.stockCountLineId,
        },
      },
      select: { id: true },
    });
    if (existing) throw new ApiError(409, ALREADY_ACKNOWLEDGED);

    let created: { id: string };
    try {
      created = await tx.handoverStockAcknowledgement.create({
        data: {
          handoverId: handover.id,
          stockCountLineId: args.stockCountLineId,
          acknowledgedById: args.acknowledgedById,
          incomingCountedQuantity,
          handedOverQuantity,
          varianceQuantity,
          decision,
          disputeReasonCodeId,
          disputeNote,
        },
        select: { id: true },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, ALREADY_ACKNOWLEDGED);
      throw e;
    }

    // Guard and write in ONE statement, so two racers cannot both observe
    // `OUTGOING_SUBMITTED` and both stamp the moment the review opened.
    // Matching zero rows is the correct no-op for a later acknowledgement:
    // the status is already INCOMING_REVIEW and `reviewedAt` is left
    // byte-identical. `reviewedAt` is never written outside this `where`.
    await tx.handoverSession.updateMany({
      where: { id: handover.id, status: "OUTGOING_SUBMITTED" },
      data: { status: "INCOMING_REVIEW", reviewedAt: new Date() },
    });

    // Figures ARE recorded here, unlike `HANDOVER_SUBMITTED`, which withholds
    // them: by the time this row exists the reviewer has been disclosed the
    // whole session, so there is nothing left to leak — and the figure signed
    // for is the entire point of the record.
    await auditInTransaction(tx, {
      cafeId: handover.cafeId,
      userId: args.acknowledgedById,
      action: HANDOVER_LINE_ACKNOWLEDGED_AUDIT_ACTION,
      entity: "HandoverStockAcknowledgement",
      entityId: created.id,
      details: {
        branchId: handover.branchId,
        handoverId: handover.id,
        stockCountLineId: args.stockCountLineId,
        inventoryItemId: line.inventoryItemId,
        sessionId: line.sessionId,
        decision,
        handedOverQuantity,
        varianceQuantity,
        disputeReasonCodeId,
      },
    });

    return { handedOverQuantity, varianceQuantity, decision };
  });
}

// ────────────────────────── SH-19 · the recount request ──────────────────
//
// Disagreeing sends the count back. It never rewrites it, and it never leaves
// a case behind.
//
// This function writes to `HandoverSession` and to NOTHING else. Not to a
// `StockCountLine`, not to the `StockCountSession`, not to a `Shift`, a
// `CustodyPeriod`, an `InventoryItem`, an `InventoryFreeze`, a `VarianceCase`
// or a `TenderReconciliation`. Custody does not move. The freeze is retained
// by omission — the shelf must stay still between the disputed count and its
// replacement, and releasing it here would let the room change under a count
// that has been asked for and not yet taken.
//
// The pointer is deliberately NOT moved either. It still names the superseded
// session until the outgoing hand starts the replacement, which is what keeps
// the prior evidence readable and what lets a stale acknowledgement be
// refused by the current-session predicate rather than accepted against a
// count nobody is reviewing any more.
//
// And because §2.5 gave a handover-bound confirmation deferred accountability,
// the superseded session carries no `VarianceCase` at all — so there is
// nothing here to retract, which is the R1 defect meeting its fix.

export const HANDOVER_RECOUNT_REQUESTED_AUDIT_ACTION = "HANDOVER_RECOUNT_REQUESTED";

export type RequestRecountResult = {
  status: "REJECTED";
  /** Line ids of this handover's DISPUTED acknowledgements, ascending. */
  disputedLineIds: string[];
  /** The session the pointer named when the rejection committed. */
  supersededSessionId: string;
};

/** The statuses a recount may be asked for from. */
const RECOUNTABLE_STATUSES: readonly HandoverStatus[] = [
  "OUTGOING_SUBMITTED",
  "INCOMING_REVIEW",
];

const NOT_RECOUNTABLE = "التسليم مش في حالة تسمح بطلب إعادة الجرد";

export async function requestRecount(args: {
  handoverId: string;
  /**
   * The actor for the audit row, and nothing else.
   *
   * `HandoverSession.incomingUserId` — the column of the same name — is NOT
   * written here. The handover-level incoming party is recorded when custody
   * actually moves, which is SH-20's; somebody who asked for a recount has
   * not taken the shelf.
   */
  incomingUserId: string;
  reasonCodeId: string;
  note?: string;
  cafeId: string;
  viewerBranchId: string | null;
}): Promise<RequestRecountResult> {
  return db.$transaction(async (tx) => {
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
        stockCountSessionId: true,
      },
    });

    if (handover.cafeId !== args.cafeId) {
      throw new ApiError(404, HANDOVER_NOT_FOUND);
    }
    if (args.viewerBranchId !== null && handover.branchId !== args.viewerBranchId) {
      throw new ApiError(403, FOREIGN_BRANCH);
    }

    if (!RECOUNTABLE_STATUSES.includes(handover.status)) {
      throw new ApiError(409, NOT_RECOUNTABLE);
    }
    if (handover.stockCountSessionId === null) {
      throw new ApiError(409, NO_BOUND_COUNT);
    }
    // Captured before any write, so the answer names the session that was
    // current when the rejection committed rather than whatever the pointer
    // says by the time the caller reads it.
    const supersededSessionId = handover.stockCountSessionId;

    // Inside the lock, so the reason cannot be deactivated between the check
    // and the write.
    await assertHandoverReason(tx, args.reasonCodeId, handover.cafeId, "سبب إعادة الجرد");

    // Restricted to the session being superseded. An acknowledgement against
    // an EARLIER session is not evidence about the count being sent back, and
    // listing it would tell the outgoing hand to re-examine a line that is no
    // longer part of what they are being asked to count again.
    const disputed = await tx.handoverStockAcknowledgement.findMany({
      where: {
        handoverId: handover.id,
        decision: "DISPUTED",
        line: { sessionId: supersededSessionId },
      },
      select: { stockCountLineId: true },
      orderBy: { stockCountLineId: "asc" },
    });
    const disputedLineIds = disputed.map((row) => row.stockCountLineId);

    // Status and reason move in ONE statement, which is what keeps the
    // migration's CHECK — status <> 'REJECTED' OR rejectionReasonCodeId IS
    // NOT NULL — satisfied at every instant rather than only between two
    // writes. The guard in the same `where` is what makes two simultaneous
    // requests produce exactly one rejection.
    const moved = await tx.handoverSession.updateMany({
      where: {
        id: handover.id,
        status: { in: ["OUTGOING_SUBMITTED", "INCOMING_REVIEW"] },
      },
      data: {
        status: "REJECTED",
        rejectionReasonCodeId: args.reasonCodeId,
        rejectionNote: args.note ?? null,
        rejectedAt: new Date(),
      },
    });
    if (moved.count === 0) throw new ApiError(409, NOT_RECOUNTABLE);

    // Ids and counts. The figures that were disagreed about live on the
    // acknowledgement rows, which are the record of the disagreement itself.
    await auditInTransaction(tx, {
      cafeId: handover.cafeId,
      userId: args.incomingUserId,
      action: HANDOVER_RECOUNT_REQUESTED_AUDIT_ACTION,
      entity: "HandoverSession",
      entityId: handover.id,
      details: {
        branchId: handover.branchId,
        supersededSessionId,
        reasonCodeId: args.reasonCodeId,
        disputedLineIds,
        disputedCount: disputedLineIds.length,
      },
    });

    return { status: "REJECTED" as const, disputedLineIds, supersededSessionId };
  });
}
