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
  OpeningExceptionKind,
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
import { rebaseFromCountInTransaction, type RebaseResult } from "@/lib/stock-rebase";
import type { HandoverBlocker } from "@/lib/handover-blockers";
import {
  persistRequiredItems,
  planRequiredItems,
  settleRequiredItems,
} from "@/lib/handover-required-items";
import {
  EFFECTIVE_EVIDENCE_SELECT,
  effectiveCountEvidence,
  hasAuthoritativeObservation,
} from "@/lib/count-evidence";
import {
  acquireInventoryFreeze,
  activeFreezeFor,
  releaseInventoryFreeze,
} from "@/lib/inventory-freeze";
import {
  ACTIVE_COUNT_STATUSES,
  BLIND_LINE_FIELDS,
  COUNT_STARTED_AUDIT_ACTION,
  lockCountSession,
  redactCountTargets,
} from "@/lib/stock-count";
import { buildStockBoundary, persistStockBoundary } from "@/lib/handover-boundary";
import { openHandoverVarianceCases } from "@/lib/stock-variance-attribution";
import { transferCustody } from "@/lib/custody";

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

/**
 * The statuses a handover-bound count may be started from.
 *
 * `REJECTED` is SH-19's addition: a handover sent back for a recount is
 * unfinished business rather than a closed record, and the partial unique
 * index already treats it as live.
 */
const RESTARTABLE_STATUSES: readonly HandoverStatus[] = ["DRAFT", "REJECTED"];

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

    // DRAFT, and REJECTED — the handover that was sent back to be counted
    // again. Every later status has already consumed or discarded the
    // evidence, so OUTGOING_SUBMITTED, INCOMING_REVIEW, ACCEPTED,
    // MANAGER_EXCEPTION and COMPLETED still refuse with the same message.
    if (!RESTARTABLE_STATUSES.includes(handover.status)) {
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
      // For a DRAFT handover this is still the refusal it always was:
      // CONFIRMED evidence is replaced by `requestRecount`, not by starting a
      // second count behind it, and LOCKED is closed history.
      if (handover.status !== "REJECTED") {
        throw new ApiError(409, "في جرد متسجل للتسليم ده بالفعل");
      }
      // REJECTED: the bound session IS the superseded evidence, and asking
      // for the replacement is exactly what the rejection invited. Fall
      // through to creation. The prior row is never read for update, never
      // edited and never deleted — only the pointer below stops naming it.
      //
      // An ACTIVE bound session short-circuits above even from REJECTED,
      // which is what makes two simultaneous restarts idempotent: the loser
      // re-reads the pointer under its own lock and receives the winner's
      // replacement.
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

    // The current-count pointer and the status, and nothing else. No earlier
    // session row is edited or removed, which is what preserves recount
    // history.
    //
    // `status` is written only because the row may be in REJECTED; writing
    // "DRAFT" when it is already DRAFT is a no-op on the same column.
    // `rejectionReasonCodeId`, `rejectionNote` and `rejectedAt` are
    // deliberately ABSENT from `data`: they are the record of why a second
    // count exists, and the migration's CHECK constrains only the REJECTED
    // direction, so retaining them in DRAFT is legal.
    await tx.handoverSession.update({
      where: { id: handover.id },
      data: { stockCountSessionId: created.id, status: "DRAFT" },
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
  /**
   * Two different absences, kept apart because they call for different acts.
   *
   * `missingItemIds` — a required item whose line exists and carries no
   * authoritative observation. The evidence gap: in scope, nobody reached it.
   * It stays in the position because it is the thing the incoming custodian,
   * SH-20's refusal and SH-21's manager exception are all reading.
   *
   * `unlinkedItemIds` — a required item with no line at all. Not an evidence
   * gap but an integrity one: `startHandoverCount` builds a line per required
   * item from the immutable snapshot, so an item with none means the bound
   * session is not the count this handover planned. Nobody can count their
   * way out of that, which is why the submit refusal moved onto it.
   */
  required: {
    total: number;
    satisfied: number;
    missingItemIds: string[];
    unlinkedItemIds: string[];
  };
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
  // Observed, not merely present. A handover count may carry a line for a
  // shelf nobody reached, and reading "has a line" as "was counted" is how an
  // unlooked-at shelf becomes a figure somebody answers for.
  const counted = resolved.filter((r) => hasAuthoritativeObservation(r.line));
  // One line per item is a schema guarantee (`@@unique([sessionId,
  // inventoryItemId])`), so the two readings below cannot disagree.
  const countedItemIds = new Set(counted.map((r) => r.line.inventoryItemId));
  const linkedItemIds = new Set(resolved.map((r) => r.line.inventoryItemId));

  const missingItemIds = handover.requiredItems
    .filter((item) => !countedItemIds.has(item.inventoryItemId))
    .map((item) => item.inventoryItemId);
  const unlinkedItemIds = handover.requiredItems
    .filter((item) => !linkedItemIds.has(item.inventoryItemId))
    .map((item) => item.inventoryItemId);

  // A shelf nobody reached has no variance, and the resolver's collapsed zero
  // must not be read as one. Excluded explicitly rather than left to that
  // zero: an unobserved line owes nobody a reason, and a malformed one should
  // not be able to demand one either.
  const nonZero = resolved.filter(
    (r) => hasAuthoritativeObservation(r.line) && r.evidence.varianceQuantity !== 0
  );

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
      unlinkedItemIds,
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

    // ON `unlinkedItemIds`, NOT ON `missingItemIds`.
    //
    // This refusal used to fire whenever a required item had no
    // AUTHORITATIVE OBSERVATION, which made an incomplete handover count
    // unsubmittable — and so made the whole of SH-20's step-5 refusal and
    // SH-21's manager exception unreachable from production. A branch whose
    // count could not be finished had a shift that could not close, and the
    // authorised way out could not be requested because the state it acts on
    // could not be produced.
    //
    // Stating a position with a gap in it is a legitimate act, so the gap
    // does not refuse here; it is NAMED here — `missingItemIds` survives
    // untouched, the incoming custodian reviews it, and SH-20 refuses the
    // ACCEPTANCE unless a manager waives it on the record. The refusal that
    // remains is the one nobody can count their way out of: a required item
    // with no line at all means the bound session is not the count this
    // handover planned.
    if (position.required.unlinkedItemIds.length > 0) {
      // Named from the immutable snapshot, so a custodian reads the names the
      // handover was planned with rather than whatever the shelf calls them
      // today.
      const missing = await tx.handoverRequiredItem.findMany({
        where: {
          handoverId: handover.id,
          inventoryItemId: { in: position.required.unlinkedItemIds },
        },
        select: { itemNameSnapshot: true },
        orderBy: { itemNameSnapshot: "asc" },
      });
      refusals.push({
        code: "REQUIRED_ITEMS_MISSING",
        count: position.required.unlinkedItemIds.length,
        message: `في أصناف مطلوبة مش موجودة في الجرد أصلاً (${missing.length}): ${missing
          .map((item) => item.itemNameSnapshot)
          .join("، ")}`,
        ids: position.required.unlinkedItemIds,
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

// ═══════════════════ SH-20 · the accepted evidence becomes the record ═════
//
// Acceptance is one transaction, from the handover's row lock to the freeze
// release. That is not a performance decision. A partial accept — stock
// rebased but custody not transferred, a boundary written but the arriving
// shift still gated — would leave the branch in a state no later operation
// could read: a shelf whose balance came from a count nobody accepted, or a
// custodian holding stock they are not recorded as answerable for.
//
// ── WHAT ACCEPTANCE IS JUDGED AGAINST ──
//
// The count in front of it, and nothing else. A handover that was sent back
// for a recount carries every round's acknowledgements forever — they are the
// record of what was disagreed about and when — so "does an acknowledgement
// exist on this handover?" is the wrong question in both directions. A
// signature on a superseded round must not satisfy a line of the replacement
// nobody has signed for; and a DISPUTED row on a round that was already sent
// back must not block the replacement, because that dispute can never be
// withdrawn and the handover would be permanently unacceptable.
//
// Both follow from ONE clause — `line: { sessionId: acceptedSessionId }` —
// which is the idiom `requestRecount` already reads acknowledgements through.
// A count of acknowledgements is never compared against a count of lines.
//
// ── WHICH LINES NEED A SIGNATURE ──
//
// The ones carrying a figure somebody recorded. `acknowledgeStockLine`
// refuses to sign for an uncounted line at all, so requiring one would make
// acceptance unreachable; the predicate here is the same one it and
// `rebaseFromCount` already share.
//
// ── WHAT THIS ROUTE DOES NOT DO ──
//
// It does not accept a `BRANCH_CUSTODY` target. That target ends employee
// custody rather than moving it, and the branch-held successor, the opening
// verification and the gate release that discharges it are SH-22's whole
// subject. Refusing it here is what keeps SH-20 from constructing half of a
// lifecycle it does not own.
//
// It writes no `omissionNote`, no exception authority and no override. A
// required item that was not counted refuses the acceptance; the audited way
// past is SH-21's, and it is not reachable from here.

/** The statuses an acceptance may be performed from. */
const ACCEPTABLE_STATUSES: readonly HandoverStatus[] = [
  "OUTGOING_SUBMITTED",
  "INCOMING_REVIEW",
];

const NOT_ACCEPTABLE = "التسليم مش في حالة تسمح بالاستلام";
const ALREADY_ACCEPTED = "التسليم ده اتقفل خلاص";
const BRANCH_TARGET_ELSEWHERE =
  "التسليم ده للعهدة المركزية — الاستلام العادي مش بيغطيه";
const COUNT_NOT_CONFIRMED = "الجرد المربوط لسه متأكدش";
const COUNT_NOT_OURS = "الجرد ده مش مربوط بالتسليم ده";
const LINES_UNACKNOWLEDGED = "في سطور من الجرد الحالي لسه ماتسجلش استلامها";
const LINES_DISPUTED = "في اعتراض على الجرد الحالي — لازم إعادة جرد";
const NO_OUTGOING_STOCK_CUSTODY = "مفيش عهدة مخزن مربوطة بالتسليم ده";
const NO_INCOMING_SHIFT = "مفيش وردية مستلمة مستنية العهدة";
const FREEZE_NOT_OURS = "تجميد المخزون مش تابع للتسليم ده";
const REQUIRED_ITEMS_OMITTED =
  "في أصناف مطلوبة ماتعدّتش — الاستلام العادي مش بيعدّي عليها";
const OUTGOING_NOT_AWAITING = "الوردية الخارجة مش مستنية تسليم";

/** The handover row this acceptance validated and is about to write. */
type LockedHandover = {
  id: string;
  cafeId: string;
  branchId: string;
  status: HandoverStatus;
  target: HandoverTarget | null;
  stockCountSessionId: string | null;
  outgoingShiftId: string;
  outgoingStockCustodyId: string | null;
  outgoingCashCustodyId: string | null;
  acceptedStockCountSessionId: string | null;
  idempotencyKey: string | null;
};

const LOCKED_HANDOVER_SELECT = {
  id: true,
  cafeId: true,
  branchId: true,
  status: true,
  target: true,
  stockCountSessionId: true,
  outgoingShiftId: true,
  outgoingStockCustodyId: true,
  outgoingCashCustodyId: true,
  acceptedStockCountSessionId: true,
  idempotencyKey: true,
} satisfies Prisma.HandoverSessionSelect;

/**
 * Everything the acceptance needs, resolved once and refused loudly.
 *
 * `acceptedSessionId` is held HERE and persisted at step 14, never at step 4.
 * `settleRequiredItems` re-reads `HandoverSession.acceptedStockCountSessionId`
 * and takes its immutability branch the moment it is non-null: on a first
 * acceptance every `satisfiedByLineId` is still NULL while the desired state
 * is a line id, so the state is not already exact and it would throw "final
 * required-item settlement is immutable". Persisting the pointer before
 * settlement would therefore make every first acceptance impossible. Step 4
 * resolves and pins; step 14 records.
 */
type AcceptedEvidence = {
  handover: LockedHandover;
  acceptedSessionId: string;
  outgoingStockCustodyId: string;
  outgoingCashCustodyId: string | null;
  incomingShiftId: string;
  /** The arriving shift's own cashier. SH-21's recipient when no session supplies one. */
  incomingShiftCashierId: string;
  countedLineIds: string[];
};

/**
 * Read-only. Every refusal is thrown before the first write, so a gate that
 * says no has changed nothing about the branch.
 */
async function resolveAcceptableEvidence(
  tx: Prisma.TransactionClient,
  handover: LockedHandover,
  args: { cafeId: string; viewerBranchId: string | null; incomingShiftId?: string | null }
): Promise<AcceptedEvidence> {
  // Another tenant's handover is not confirmed to exist. A 403 here would
  // tell one café that an id belonging to another one is real.
  if (handover.cafeId !== args.cafeId) throw new ApiError(404, HANDOVER_NOT_FOUND);
  if (args.viewerBranchId !== null && handover.branchId !== args.viewerBranchId) {
    throw new ApiError(403, FOREIGN_BRANCH);
  }
  if (!ACCEPTABLE_STATUSES.includes(handover.status)) {
    throw new ApiError(409, NOT_ACCEPTABLE);
  }
  if (handover.target !== "SHIFT_TO_SHIFT") {
    throw new ApiError(409, BRANCH_TARGET_ELSEWHERE);
  }
  if (handover.stockCountSessionId === null) throw new ApiError(409, NO_BOUND_COUNT);

  // Step 4. The pointer names the evidence — never "the newest confirmed
  // session", which after a recount would silently accept a round the
  // arriving custodian was never shown.
  const acceptedSessionId = handover.stockCountSessionId;
  const session = await tx.stockCountSession.findUnique({
    where: { id: acceptedSessionId },
    select: {
      id: true, cafeId: true, branchId: true, status: true,
      accountabilityContext: true, handoverId: true,
    },
  });
  if (!session) throw new ApiError(409, NO_BOUND_COUNT);
  if (session.cafeId !== handover.cafeId || session.branchId !== handover.branchId) {
    throw new ApiError(409, COUNT_NOT_OURS);
  }
  if (session.status !== "CONFIRMED") throw new ApiError(409, COUNT_NOT_CONFIRMED);
  if (session.accountabilityContext !== "HANDOVER" || session.handoverId !== handover.id) {
    throw new ApiError(409, COUNT_NOT_OURS);
  }

  // Step 3's evidence test, against the CURRENT session only.
  const lines = await tx.stockCountLine.findMany({
    where: { sessionId: acceptedSessionId },
    select: { ...EFFECTIVE_EVIDENCE_SELECT, id: true },
    orderBy: { id: "asc" },
  });
  // A line nobody counted has no figure to sign for, and
  // `acknowledgeStockLine` refuses to sign one. Requiring an acknowledgement
  // for it would make acceptance unreachable rather than careful.
  const countedLines = lines.filter(
    (line) => !(line.countedQuantity === null && effectiveCountEvidence(line).recountId === null)
  );

  // THE amendment, in one clause. An acknowledgement reaches a session only
  // through its line, so a row belonging to a superseded round is invisible
  // here: it can neither satisfy a missing line nor block on a stale dispute.
  const acknowledgements = await tx.handoverStockAcknowledgement.findMany({
    where: { handoverId: handover.id, line: { sessionId: acceptedSessionId } },
    select: { stockCountLineId: true, decision: true },
  });
  const acknowledged = new Set(acknowledgements.map((a) => a.stockCountLineId));
  if (countedLines.some((line) => !acknowledged.has(line.id))) {
    throw new ApiError(409, LINES_UNACKNOWLEDGED);
  }
  if (acknowledgements.some((a) => a.decision === "DISPUTED")) {
    throw new ApiError(409, LINES_DISPUTED);
  }

  // The custody being discharged is the one the CLOSING shift held, named on
  // the handover at close. "Whatever is open at the branch now" is a different
  // fact, and only the first one says who is being discharged.
  if (handover.outgoingStockCustodyId === null) {
    throw new ApiError(409, NO_OUTGOING_STOCK_CUSTODY);
  }
  const outgoingStock = await tx.custodyPeriod.findUnique({
    where: { id: handover.outgoingStockCustodyId },
    select: { id: true, branchId: true, scope: true, status: true },
  });
  if (
    !outgoingStock
    || outgoingStock.branchId !== handover.branchId
    || outgoingStock.scope !== "STOCK"
    || outgoingStock.status !== "OPEN"
  ) {
    throw new ApiError(409, NO_OUTGOING_STOCK_CUSTODY);
  }

  const incomingShift = await resolveIncomingShift(tx, handover, args.incomingShiftId);

  // Acceptance releases the freeze at step 15, so it must be releasing its
  // own. A branch frozen by a different handover is not this one's to reopen.
  const freeze = await activeFreezeFor(tx, handover.branchId);
  if (!freeze || freeze.handoverId !== handover.id) {
    throw new ApiError(409, FREEZE_NOT_OURS);
  }

  return {
    handover,
    acceptedSessionId,
    outgoingStockCustodyId: outgoingStock.id,
    outgoingCashCustodyId: handover.outgoingCashCustodyId,
    incomingShiftId: incomingShift.id,
    incomingShiftCashierId: incomingShift.cashierId,
    countedLineIds: countedLines.map((line) => line.id),
  };
}

/**
 * The shift that is waiting to receive custody.
 *
 * Named explicitly, or the branch's single OPEN shift gated on
 * `AWAITING_CUSTODY_TRANSFER` — the state `ensureCustodyForShift` puts a shift
 * into when it opens mid-handover. Two such shifts is an ambiguity rather than
 * a choice to make silently: handing the room to the wrong one would record
 * the wrong custodian.
 */
async function resolveIncomingShift(
  tx: Prisma.TransactionClient,
  handover: LockedHandover,
  requested: string | null | undefined
): Promise<{ id: string; cashierId: string }> {
  const candidates = await tx.shift.findMany({
    where: {
      branchId: handover.branchId,
      status: "OPEN",
      custodyGateReason: "AWAITING_CUSTODY_TRANSFER",
      ...(requested ? { id: requested } : {}),
    },
    // `cashierId` comes back because SH-21 has no arriving custodian in its
    // session — the manager is the caller — so the shift's own cashier is the
    // only authoritative answer to who is taking the room.
    select: { id: true, cashierId: true },
    orderBy: { shiftNumber: "asc" },
  });
  if (candidates.length !== 1) throw new ApiError(409, NO_INCOMING_SHIFT);
  return candidates[0];
}

/**
 * A failure seam for the rollback matrix, and nothing else.
 *
 * Acceptance's whole claim is that it is one transaction, and the only honest
 * way to prove a rollback is total is to fail inside it at each step and look
 * at what committed. That cannot be provoked from outside: every step succeeds
 * on good evidence, and mutilating the fixture to make one fail would test the
 * mutilation rather than the transaction.
 *
 * So the seam is here, and it is deliberately narrow. It is optional; it is
 * absent from `AcceptResult`; the route has no field that could carry it —
 * `acceptSchema` is `.strict()` — so no request body can reach it; and it can
 * only ever throw, because its return value is discarded. A production caller
 * that never passes it gets a function with no seam at all.
 */
export type AcceptanceCheckpoint = (
  step: number,
  tx: Prisma.TransactionClient
) => Promise<void>;

export const HANDOVER_ACCEPTED_AUDIT_ACTION = "HANDOVER_ACCEPTED";
export const HANDOVER_MANAGER_EXCEPTION_AUDIT_ACTION = "HANDOVER_MANAGER_EXCEPTION";

/**
 * A manager's authority to finish an acceptance the evidence does not justify.
 *
 * This is the ONLY difference between SH-20's acceptance and SH-21's. It is
 * optional, and when it is absent every line below behaves exactly as it did
 * before it existed — which is the point: there is one acceptance transaction,
 * not two that must be kept in step.
 *
 * `note` arrives already trimmed and already refused if blank. Validating it
 * here as well would put the refusal inside the transaction, after the row
 * lock, where a caller who sent whitespace would hold a lock to be told so.
 */
export type AcceptanceException = {
  /** The authenticated manager. Never the arriving custodian, never a body field. */
  managerId: string;
  reasonCodeId: string;
  /** Trimmed, non-empty. Written to every omitted row and to the exception. */
  note: string;
  kind: Extract<OpeningExceptionKind, "MANAGER_ADJUSTMENT" | "NO_INCOMING">;
};


export type AcceptResult = {
  status: "COMPLETED";
  handoverTarget: HandoverTarget;
  acceptedStockCountSessionId: string | null;
  incomingCashCustodyId: string | null;
  incomingStockCustodyId: string | null;
  incomingShiftId: string | null;
  boundary: { written: number; verified: number; carried: number };
  requiredItems: { satisfied: number; omitted: string[] };
  rebase: RebaseResult | null;
  varianceCaseIds: string[];
  spanIds: string[];
  outgoingShiftStatus: "CLOSED";
  alreadyAccepted: boolean;
};

/**
 * SH-21's answer, and the shape `runAcceptance` actually returns.
 *
 * The two extra fields are the exception's evidence, so they are NOT folded
 * into `AcceptResult`: an ordinary accept has no exception to report, and a
 * `null` id on every ordinary response would invite a reader to wonder which
 * accepts were overridden. `acceptHandover` returns the narrow type; only the
 * override path widens it.
 */
export type OverrideAcceptResult = AcceptResult & {
  openingExceptionId: string;
  /** `inventoryItemId` of every required item nobody counted, ascending. */
  missingItemIds: string[];
};

/** What the shared core produces; `openingExceptionId` is null with no exception. */
type AcceptanceOutcome = AcceptResult & {
  openingExceptionId: string | null;
  missingItemIds: string[];
};

/**
 * The answer to a caller whose acceptance committed and whose response was
 * lost.
 *
 * Every figure is read back from persisted state rather than remembered,
 * because a retry may arrive in a different process weeks later. `rebase` is
 * NULL on purpose: this call rebased nothing, and restating an earlier call's
 * `RebaseResult` would describe work that did not happen here.
 */
async function buildReplayResult(
  tx: Prisma.TransactionClient,
  handover: LockedHandover
): Promise<AcceptanceOutcome> {
  const [boundaries, required, cases] = await Promise.all([
    tx.handoverStockBoundary.findMany({
      where: { handoverId: handover.id },
      select: { verified: true },
    }),
    tx.handoverRequiredItem.findMany({
      where: { handoverId: handover.id },
      select: {
        satisfiedByLineId: true, omitted: true,
        itemNameSnapshot: true, inventoryItemId: true,
      },
      // Ascending by `inventoryItemId`, matching the order
      // `settleRequiredItems` sorts its omissions into, so a replay names the
      // missing items in exactly the order the first call did.
      orderBy: { inventoryItemId: "asc" },
    }),
    tx.varianceCase.findMany({
      where: { acceptedHandoverId: handover.id },
      select: { id: true, varianceSpan: { select: { id: true } } },
      orderBy: { id: "asc" },
    }),
  ]);

  // At most one, and `findFirst` rather than `findUnique` because exactly-once
  // is enforced by the status guard at step 14 rather than by a unique index —
  // SH-21 adds no schema. An ordinary completed accept has none, and this
  // stays null rather than inventing one.
  const exceptionRow = await tx.openingException.findFirst({
    where: { handoverId: handover.id },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const persisted = await tx.handoverSession.findUniqueOrThrow({
    where: { id: handover.id },
    select: {
      target: true, resolvedTarget: true, acceptedStockCountSessionId: true,
      incomingCashCustodyId: true, incomingStockCustodyId: true, incomingShiftId: true,
    },
  });

  return {
    status: "COMPLETED",
    handoverTarget: persisted.resolvedTarget ?? persisted.target ?? "SHIFT_TO_SHIFT",
    acceptedStockCountSessionId: persisted.acceptedStockCountSessionId,
    incomingCashCustodyId: persisted.incomingCashCustodyId,
    incomingStockCustodyId: persisted.incomingStockCustodyId,
    incomingShiftId: persisted.incomingShiftId,
    boundary: {
      written: boundaries.length,
      verified: boundaries.filter((b) => b.verified).length,
      carried: boundaries.filter((b) => !b.verified).length,
    },
    requiredItems: {
      satisfied: required.filter((r) => r.satisfiedByLineId !== null).length,
      omitted: required.filter((r) => r.omitted).map((r) => r.itemNameSnapshot),
    },
    rebase: null,
    varianceCaseIds: cases.map((c) => c.id),
    spanIds: cases.flatMap((c) => (c.varianceSpan ? [c.varianceSpan.id] : [])),
    outgoingShiftStatus: "CLOSED",
    alreadyAccepted: true,
    // Read back, never remembered. A retry may arrive in another process
    // weeks later, and the persisted rows are the only honest source.
    openingExceptionId: exceptionRow?.id ?? null,
    missingItemIds: required.filter((r) => r.omitted).map((r) => r.inventoryItemId),
  };
}

/**
 * Accept the handover: one transaction, sixteen steps, all or none of it.
 *
 * `cafeId` and `viewerBranchId` are additive to the roadmap's published
 * signature, matching every sibling service in this module — tenancy is the
 * caller's to state and the service's to enforce.
 */
export async function acceptHandover(args: {
  handoverId: string;
  incomingUserId: string;
  incomingShiftId?: string | null;
  idempotencyKey: string;
  cafeId: string;
  viewerBranchId: string | null;
  /**
   * Test-only failure seam. See {@link AcceptanceCheckpoint}.
   *
   * The route does not forward it and cannot: `acceptSchema` is `.strict()`
   * and has no field of this name, so no request body can reach it.
   */
  __afterStep?: AcceptanceCheckpoint;
}): Promise<AcceptResult> {
  return db.$transaction(async (tx) => {
    // 1. The row lock, first, so everything read below is the state written to.
    if (!(await lockHandover(tx, args.handoverId))) {
      throw new ApiError(404, HANDOVER_NOT_FOUND);
    }

    const handover = await tx.handoverSession.findUniqueOrThrow({
      where: { id: args.handoverId },
      select: LOCKED_HANDOVER_SELECT,
    });

    // Tenancy before anything else, including before the replay: reading back
    // a completed acceptance is still reading somebody's record.
    if (handover.cafeId !== args.cafeId) throw new ApiError(404, HANDOVER_NOT_FOUND);
    if (args.viewerBranchId !== null && handover.branchId !== args.viewerBranchId) {
      throw new ApiError(403, FOREIGN_BRANCH);
    }

    // 2. Already accepted. A retry under the SAME key hears the same answer;
    //    a different key is a claim to a second acceptance of one handover,
    //    and there is only ever one.
    if (handover.status === "COMPLETED") {
      if (handover.idempotencyKey !== args.idempotencyKey) {
        throw new ApiError(409, ALREADY_ACCEPTED);
      }
      return narrowAcceptResult(await buildReplayResult(tx, handover));
    }

    // 3–4. The gate. Every refusal is thrown before the first write.
    const evidence = await resolveAcceptableEvidence(tx, handover, {
      cafeId: args.cafeId,
      viewerBranchId: args.viewerBranchId,
      incomingShiftId: args.incomingShiftId,
    });

    // No `exception`: an ordinary accept has no manager authority to carry,
    // and step 5 keeps its refusal.
    return narrowAcceptResult(await runAcceptance(tx, evidence, args));
  });
}

/**
 * Drop SH-21's two fields from an ordinary accept's answer.
 *
 * `AcceptResult` is a published contract, and an ordinary acceptance that
 * started reporting `openingExceptionId: null` and `missingItemIds: []` would
 * be widening it for callers who never asked. The shared core computes both
 * because the override path needs them; this is where they stop.
 */
function narrowAcceptResult(outcome: AcceptanceOutcome): AcceptResult {
  const { openingExceptionId: _e, missingItemIds: _m, ...rest } = outcome;
  void _e;
  void _m;
  return rest;
}

const EXCEPTION_NOTE_REQUIRED = "لازم تكتب سبب الاستثناء بالتفصيل";
const EXCEPTION_RECIPIENT_MISMATCH =
  "المستلم المحدد مش صاحب الوردية اللي مستنية العهدة";
const NOT_AN_EXCEPTION =
  "التسليم ده اتقفل استلام عادي — مفيش استثناء مدير متسجل عليه";

/**
 * Finish a handover the evidence does not justify, and say exactly what was
 * skipped.
 *
 * SH-20's transaction, unchanged, plus a manager's authority. It is the
 * `SHIFT_TO_SHIFT` form only: `resolveAcceptableEvidence` refuses an immutable
 * `BRANCH_CUSTODY` target several lines before anything is written, and SH-22
 * owns branch acceptance with its own explicit missing-item evidence.
 *
 * ── WHAT AN OVERRIDE IS NOT ──
 *
 * It is not a count. Nothing here writes a `StockCountLine`, carries a
 * previous session's figure forward, or estimates. An item nobody counted
 * gets a `SYSTEM_CARRIED` / `verified: false` boundary — the truthful
 * statement that the shelf was not observed — and an unverified boundary
 * opens no variance case and names nobody. A manager may waive the
 * requirement to count; nobody may waive having counted.
 *
 * ── WHO IS WHO ──
 *
 * Two different people, and conflating them is the failure this signature
 * exists to prevent. The MANAGER authorises: `exceptionById`, the
 * `OpeningException.authorizedById`, the reason, the note, and the audit
 * actor. The arriving CUSTODIAN still performs SH-20's operational
 * acceptance: the rebase, the count lock, the variance cases, the custody
 * transfer, the outgoing close and the freeze release. A manager who signed
 * the exception did not thereby take the shelf, and a record saying they did
 * would misname whoever answers for it tomorrow.
 *
 * `incomingUserId` is an assertion, never an instruction: it must equal the
 * arriving shift's own cashier, and when omitted it is read from that shift.
 * The manager can never be substituted for it.
 */
export async function overrideAcceptHandover(args: {
  handoverId: string;
  /** The authenticated manager. From `session.id`; never from a request body. */
  managerId: string;
  /** Optional consistency assertion. Must equal the arriving shift's cashier. */
  incomingUserId?: string | null;
  reasonCodeId: string;
  note: string;
  kind: Extract<OpeningExceptionKind, "MANAGER_ADJUSTMENT" | "NO_INCOMING">;
  idempotencyKey: string;
  cafeId: string;
  viewerBranchId: string | null;
  /** Test-only failure seam. See {@link AcceptanceCheckpoint}. */
  __afterStep?: AcceptanceCheckpoint;
}): Promise<OverrideAcceptResult> {
  // Before the transaction, because a caller who sent whitespace should not
  // first take a row lock to be told so. `resolveVarianceReason` refuses a
  // blank cash-variance note the same way.
  const note = args.note?.trim() ?? "";
  if (note.length === 0) throw new ApiError(400, EXCEPTION_NOTE_REQUIRED);

  return db.$transaction(async (tx) => {
    // 1. The row lock, first, exactly as the ordinary accept takes it.
    if (!(await lockHandover(tx, args.handoverId))) {
      throw new ApiError(404, HANDOVER_NOT_FOUND);
    }

    const handover = await tx.handoverSession.findUniqueOrThrow({
      where: { id: args.handoverId },
      select: LOCKED_HANDOVER_SELECT,
    });

    // Tenancy before everything, including before the replay: reading back a
    // completed acceptance is still reading somebody's record.
    if (handover.cafeId !== args.cafeId) throw new ApiError(404, HANDOVER_NOT_FOUND);
    if (args.viewerBranchId !== null && handover.branchId !== args.viewerBranchId) {
      throw new ApiError(403, FOREIGN_BRANCH);
    }

    // 2. Replay. A retry under the SAME key hears the same answer; a different
    //    key is a claim to a second acceptance of one handover.
    if (handover.status === "COMPLETED") {
      if (handover.idempotencyKey !== args.idempotencyKey) {
        throw new ApiError(409, ALREADY_ACCEPTED);
      }
      const replay = await buildReplayResult(tx, handover);
      // The key belongs to an ordinary accept that committed with no
      // exception. Answering with a fabricated `openingExceptionId`, or
      // writing one now onto a completed handover, would both be inventions:
      // no manager authorised anything on this record.
      if (replay.openingExceptionId === null) {
        throw new ApiError(409, NOT_AN_EXCEPTION);
      }
      return { ...replay, openingExceptionId: replay.openingExceptionId };
    }

    // The reason is validated against the HANDOVER domain of the handover's
    // OWN café, read from the locked row rather than from the caller — so a
    // reason code belonging to somebody else cannot authorise this exception.
    await assertHandoverReason(tx, args.reasonCodeId, handover.cafeId, "سبب الاستثناء");

    // 3–4. SH-20's gate, unchanged and unweakened. The status, the target, the
    // bound and CONFIRMED count, the acknowledgement of every counted line of
    // the CURRENT round, the absence of a dispute, the outgoing custody, the
    // arriving shift and the freeze are all still required. A manager's
    // authority reaches exactly one of SH-20's refusals — the uncounted
    // required item at step 5 — and none of the others.
    const evidence = await resolveAcceptableEvidence(tx, handover, {
      cafeId: args.cafeId,
      viewerBranchId: args.viewerBranchId,
    });

    // The recipient is the arriving shift's cashier. When the caller named
    // one it is checked rather than believed, and a mismatch is refused
    // instead of silently preferring either answer.
    const incomingUserId = evidence.incomingShiftCashierId;
    if (args.incomingUserId && args.incomingUserId !== incomingUserId) {
      throw new ApiError(409, EXCEPTION_RECIPIENT_MISMATCH);
    }

    const outcome = await runAcceptance(tx, evidence, {
      handoverId: args.handoverId,
      incomingUserId,
      idempotencyKey: args.idempotencyKey,
      exception: {
        managerId: args.managerId,
        reasonCodeId: args.reasonCodeId,
        note,
        kind: args.kind,
      },
      __afterStep: args.__afterStep,
    });

    // Non-null by construction: `runAcceptance` creates the exception on every
    // path that carries one, and throws on every path that does not commit.
    /* c8 ignore next */
    if (outcome.openingExceptionId === null) throw new ApiError(409, NOT_AN_EXCEPTION);
    return { ...outcome, openingExceptionId: outcome.openingExceptionId };
  });
}

/**
 * Close the outgoing shift. Step 13, and nothing else.
 *
 * Exported because it is the acceptance's one internal injectable unit: T14's
 * rollback matrix forces a failure immediately after it, and a seam that only
 * exists inside a closure cannot be aimed at.
 *
 * The guard and the write are ONE statement, so two callers racing cannot both
 * observe `AWAITING_HANDOVER` and both stamp the close. Matching zero rows is
 * a refusal rather than a silent no-op: a shift that is not awaiting a
 * handover is not this acceptance's to close.
 *
 * Nothing financial is recomputed. `actualCashAmount`, `expectedCashAmount`,
 * `cashDifference`, the tolerance verdict, the reason and its note were
 * settled when the money was, and re-deriving them here would let an
 * acceptance silently restate a reconciliation somebody already signed.
 */
export async function finalizeOutgoingShift(
  tx: Prisma.TransactionClient,
  args: { outgoingShiftId: string; closedById: string; at: Date }
): Promise<{ outgoingShiftStatus: "CLOSED" }> {
  const moved = await tx.shift.updateMany({
    where: { id: args.outgoingShiftId, status: "AWAITING_HANDOVER" },
    data: {
      status: "CLOSED",
      // When the shelf became a fact, as distinct from when the money did.
      stockClosedAt: args.at,
      closedAt: args.at,
      // Who accepted the count and discharged the custodian — not the cashier
      // who held the drawer.
      closedById: args.closedById,
    },
  });
  if (moved.count === 0) throw new ApiError(409, OUTGOING_NOT_AWAITING);
  return { outgoingShiftStatus: "CLOSED" };
}

/**
 * Steps 5 through 16, in the roadmap's order.
 *
 * Split out from `acceptHandover` so the entry — lock, tenancy, replay, gate —
 * stays readable beside it. Every write below is on the caller's transaction
 * client; nothing here opens one, and nothing here awaits anything outside it.
 */
async function runAcceptance(
  tx: Prisma.TransactionClient,
  evidence: AcceptedEvidence,
  args: {
    handoverId: string;
    incomingUserId: string;
    idempotencyKey: string;
    /** SH-21 only. Absent on every ordinary accept. See {@link AcceptanceException}. */
    exception?: AcceptanceException;
    __afterStep?: AcceptanceCheckpoint;
  }
): Promise<AcceptanceOutcome> {
  const { handover, acceptedSessionId } = evidence;
  const exception = args.exception;
  // Filled at step 14a, after the guarded completion write has won. Declared
  // here only so the result below can name it.
  let openingExceptionId: string | null = null;
  const checkpoint = async (step: number) => {
    if (args.__afterStep) await args.__afterStep(step, tx);
  };

  // ── 5. Required items ──
  //
  // SH-14's settlement authority is used rather than reimplemented. The note
  // is passed ONLY when a manager authorised the exception: a note is SH-21's
  // authorisation evidence, and an ordinary accept that supplied one would be
  // an unaudited override. With no exception this call is byte-for-byte the
  // one SH-20 made.
  //
  // The refusal below is a `throw` inside the transaction, so the `omitted:
  // true` rows settlement wrote moments ago never commit. After a refused
  // acceptance `omitted` and `omissionNote` are exactly as they were.
  //
  // SH-21 bypasses the refusal and nothing else. It does NOT invent a count
  // line for the missing item, does not guess a quantity, and does not carry
  // the previous session's figure forward as though somebody had looked: step
  // 7 writes those items `SYSTEM_CARRIED` / `verified: false`, which is the
  // truthful statement that nobody counted them.
  const settled = await settleRequiredItems(tx, {
    handoverId: handover.id,
    acceptedSessionId,
    ...(exception ? { omissionNote: exception.note } : {}),
  });
  if (!exception && settled.omitted.length > 0) {
    throw new ApiError(409, REQUIRED_ITEMS_OMITTED);
  }
  // Ascending by `inventoryItemId`, the order `settleRequiredItems` already
  // sorted them into, so the result, the audit row and a later replay all
  // name the same items in the same order.
  const missingItemIds = settled.omitted.map((entry) => entry.inventoryItemId);
  const missingItemNames = settled.omitted.map((entry) => entry.itemNameSnapshot);
  await checkpoint(5);

  // ── 6. Rebase, under the freeze that protected the count ──
  //
  // The freeze is NOT released first. Releasing it to get the movement
  // through would reopen the shelf to sales in the middle of the acceptance,
  // which is the one thing it exists to prevent; the token identifies the
  // handover the freeze was taken for, and step 15 releases it.
  const rebase = await rebaseFromCountInTransaction(tx, {
    sessionId: acceptedSessionId,
    actorId: args.incomingUserId,
    idempotencyKey: `${handover.id}:rebase`,
    freezeToken: handover.id,
  });
  await checkpoint(6);

  // ── 7. The closing position ──
  //
  // SH-15's own rules, applied to the ACCEPTED session — never to
  // `handover.stockCountSessionId`, which after a recount has more than one
  // answer in its history. Nothing here re-derives what counts as verified.
  const boundary = await buildStockBoundary(tx, {
    cafeId: handover.cafeId,
    branchId: handover.branchId,
    handoverId: handover.id,
    acceptedSessionId,
  });
  const written = await persistStockBoundary(tx, {
    handoverId: handover.id,
    lines: boundary.lines,
  });
  // Read back rather than assumed: `createMany` returns a count, and step 9
  // needs each row's id to hang an unresolved span from.
  const boundaryRows = await tx.handoverStockBoundary.findMany({
    where: { handoverId: handover.id },
    select: { id: true, inventoryItemId: true },
  });
  const boundaryByItemId = new Map(
    boundaryRows.map((row) => [row.inventoryItemId, row.id])
  );
  await checkpoint(7);

  // ── 8. The accepted evidence becomes immutable ──
  //
  // After settle, rebase and boundary, which is the roadmap's order. A
  // superseded session is never the subject: it stays CONFIRMED and unlocked,
  // because it is history rather than the record.
  await lockCountSession(tx, {
    sessionId: acceptedSessionId,
    handoverId: handover.id,
    actorId: args.incomingUserId,
  });
  await checkpoint(8);

  // ── 9. Accepted variance and its attribution ──
  //
  // One case per NON-ZERO variance, with no tolerance predicate and
  // `disposition` unread — a difference the generic tolerance called
  // acceptable is still a difference somebody physically observed. SH-17 owns
  // every verdict; none of it is re-derived here, and acceptance never sets
  // `assignedResponsibilityUserId`.
  const variance = await openHandoverVarianceCases(tx, {
    cafeId: handover.cafeId,
    branchId: handover.branchId,
    handoverId: handover.id,
    acceptedSessionId,
    outgoingCustodyPeriodId: evidence.outgoingStockCustodyId,
    boundaryByItemId,
    openedById: args.incomingUserId,
  });
  await checkpoint(9);

  // One instant, reused at steps 10, 11, 12, 13 and 14. Custody moving, the
  // arriving shift becoming operational and the outgoing one closing are one
  // fact, and four timestamps milliseconds apart would invite a reader to look
  // for an order among them that does not exist.
  //
  // Taken HERE rather than at the top, and that position is load-bearing.
  // `openHandoverVarianceCases` derives its span's `toVerifiedAt` from
  // `handover.acceptedAt ?? new Date()`, and at step 9 the column is still
  // NULL — so the fallback applies. An `acceptedAt` captured before step 9
  // would be EARLIER than the span it contains, and a reader would find a span
  // that closed after the acceptance which created it. Captured after, the
  // ordering is the true one: the evidence was assessed, and then the room
  // changed hands.
  const acceptedAt = new Date();

  // ── 10. STOCK custody moves ──
  //
  // The predecessor records who accepted it; the successor records which shift
  // answers for it. A BRANCH successor is not constructible from here — the
  // gate refused a `BRANCH_CUSTODY` target long before this line.
  const stock = await transferCustody(tx, {
    outgoingPeriodId: evidence.outgoingStockCustodyId,
    scope: "STOCK",
    incoming: {
      participants: [{ userId: args.incomingUserId, role: "PRIMARY" }],
      shiftId: evidence.incomingShiftId,
      responsibleShiftId: evidence.incomingShiftId,
      holderType: "USER",
      openedById: args.incomingUserId,
    },
    actorId: args.incomingUserId,
    acceptedById: args.incomingUserId,
    acceptedAt,
  });
  await checkpoint(10);

  // ── 11. CASH custody moves, when one is still open to move ──
  //
  // SH-16 leaves the drawer OPEN for a `SHIFT_TO_SHIFT` close precisely so it
  // can be handed over here, at the figure the close counted. A shift that
  // never held one has nothing to transfer, and one is not conjured so the
  // record looks complete.
  const incomingCashCustodyId = await transferCashCustody(tx, {
    outgoingCashCustodyId: evidence.outgoingCashCustodyId,
    branchId: handover.branchId,
    outgoingShiftId: handover.outgoingShiftId,
    incomingShiftId: evidence.incomingShiftId,
    incomingUserId: args.incomingUserId,
    acceptedAt,
  });
  await checkpoint(11);

  // ── 12. The arriving shift may sell ──
  //
  // In the SAME commit as step 10, which is the whole of correction #2: there
  // is no instant in which the arriving cashier holds custody but cannot sell,
  // or can sell but holds nothing.
  await tx.shift.update({
    where: { id: evidence.incomingShiftId },
    data: { custodyGateReason: null, custodyReadyAt: acceptedAt },
  });
  await checkpoint(12);

  // ── 13. The outgoing shift closes ──
  const outgoing = await finalizeOutgoingShift(tx, {
    outgoingShiftId: handover.outgoingShiftId,
    closedById: args.incomingUserId,
    at: acceptedAt,
  });
  await checkpoint(13);

  // ── 14. The record ──
  //
  // `acceptedStockCountSessionId` is persisted HERE, and could not have been
  // persisted at step 4: `settleRequiredItems` refuses to write once it is
  // non-null, so an early write would make every first acceptance throw.
  //
  // `resolvedTarget` is written; `target` is not. The immutable intent is
  // SH-14's, and for an ordinary acceptance the two are equal by construction
  // — the gate refused everything else. SH-21's audited exception is the only
  // path on which they may diverge, and it is not this one.
  //
  // The guard in the `where` is what makes two racing acceptances produce one
  // completion: the loser matches zero rows and is refused.
  //
  // SH-21 adds three columns and NOT a fourth status. The terminal state of an
  // overridden handover is `COMPLETED`, the same as any other: it did complete,
  // and a separate `MANAGER_EXCEPTION` status would fork every downstream
  // reader — every list, every blocker check, every report — on a distinction
  // the exception columns already carry precisely. The manager-exception fact
  // lives in `exceptionById` / `exceptionReason` / `exceptionAt`, in the
  // `OpeningException` below and in its own audit action.
  //
  // `resolvedTarget` stays `SHIFT_TO_SHIFT`. An override changes who may
  // finish the acceptance, never where the custody goes; SH-22 owns branch
  // custody, and no divergence is reachable from here.
  const completed = await tx.handoverSession.updateMany({
    where: { id: handover.id, status: { in: [...ACCEPTABLE_STATUSES] } },
    data: {
      status: "COMPLETED",
      resolvedTarget: "SHIFT_TO_SHIFT",
      acceptedStockCountSessionId: acceptedSessionId,
      acceptedAt,
      completedAt: acceptedAt,
      idempotencyKey: args.idempotencyKey,
      incomingUserId: args.incomingUserId,
      incomingShiftId: evidence.incomingShiftId,
      incomingStockCustodyId: stock.incomingPeriodId,
      incomingCashCustodyId,
      ...(exception
        ? {
            exceptionById: exception.managerId,
            exceptionReason: exception.note,
            exceptionAt: acceptedAt,
          }
        : {}),
    },
  });
  if (completed.count === 0) throw new ApiError(409, NOT_ACCEPTABLE);
  await checkpoint(14);

  // ── 14a. The exception becomes a record of its own ──
  //
  // AFTER the guarded write above, and that position is what makes it
  // exactly-once without a unique index or any schema change. Two overrides
  // racing both reach step 14; the `status IN (OUTGOING_SUBMITTED,
  // INCOMING_REVIEW)` guard lets exactly one match a row, and the loser throws
  // before it can get here. A retry under the same key never arrives at all —
  // it met `COMPLETED` at the entry and was answered from persisted state.
  //
  // Still inside the transaction, so a failure at step 15 or 16 takes this row
  // with it: an exception row surviving a rolled-back acceptance would claim a
  // manager authorised a handover that never happened.
  //
  // Every amount column stays NULL. Nothing financial was overridden here, and
  // a zero would read as a counted figure rather than as an absent one.
  if (exception) {
    const openingException = await tx.openingException.create({
      data: {
        cafeId: handover.cafeId,
        branchId: handover.branchId,
        handoverId: handover.id,
        kind: exception.kind,
        reasonCodeId: exception.reasonCodeId,
        note: exception.note,
        authorizedById: exception.managerId,
      },
      select: { id: true },
    });
    openingExceptionId = openingException.id;
  }
  await checkpoint(14.5);

  // ── 15. The shelf is unfrozen ──
  //
  // Last, and inside this transaction. By now the same transaction already
  // holds the branch's SHARED advisory lock, taken by the step-6 rebase, and
  // this takes the EXCLUSIVE one on the same key. PostgreSQL grants a request
  // that conflicts only with locks the same transaction already holds, so the
  // upgrade does not self-deadlock — and `acquireInventoryExclusiveLock`
  // already skips its lock-order assertion for a key it holds SHARED.
  await releaseInventoryFreeze(tx, {
    handoverId: handover.id,
    actorId: args.incomingUserId,
  });
  // The last seam, and the one that closes the rollback matrix: everything
  // this acceptance writes now exists, the freeze release included. A failure
  // here — the connection dying between the last write and the commit — must
  // still leave the shelf frozen, because a released freeze with no custody
  // transfer would open the branch to sales against a handover nobody
  // completed.
  await checkpoint(15);

  const result: AcceptanceOutcome = {
    status: "COMPLETED",
    handoverTarget: "SHIFT_TO_SHIFT",
    acceptedStockCountSessionId: acceptedSessionId,
    incomingCashCustodyId,
    incomingStockCustodyId: stock.incomingPeriodId,
    incomingShiftId: evidence.incomingShiftId,
    boundary: {
      written: written.written,
      verified: boundary.verifiedCount,
      carried: boundary.carriedCount,
    },
    requiredItems: {
      satisfied: await tx.handoverRequiredItem.count({
        where: { handoverId: handover.id, satisfiedByLineId: { not: null } },
      }),
      // Empty on every ordinary accept BY CONSTRUCTION: a non-empty list
      // refused it at step 5. Only a manager's exception can put a name here,
      // and then the name is the whole point of the record.
      omitted: missingItemNames,
    },
    rebase,
    varianceCaseIds: variance.caseIds,
    spanIds: variance.spanIds,
    outgoingShiftStatus: outgoing.outgoingShiftStatus,
    alreadyAccepted: false,
    openingExceptionId,
    missingItemIds,
  };

  // ── 16. One audit row, carrying the whole shape ──
  //
  // `auditInTransaction`, never the fire-and-forget `audit`: an acceptance
  // recorded when the acceptance rolled back would be a false statement about
  // who took the room, which is exactly what this record exists to settle.
  await auditInTransaction(tx, {
    cafeId: handover.cafeId,
    userId: args.incomingUserId,
    action: HANDOVER_ACCEPTED_AUDIT_ACTION,
    entity: "HandoverSession",
    entityId: handover.id,
    details: {
      branchId: handover.branchId,
      acceptedStockCountSessionId: acceptedSessionId,
      resolvedTarget: "SHIFT_TO_SHIFT",
      idempotencyKey: args.idempotencyKey,
      boundary: result.boundary,
      requiredItemsSatisfied: result.requiredItems.satisfied,
      rebase: {
        itemsRebased: rebase.itemsRebased,
        itemsSkipped: rebase.itemsSkipped,
        alreadyRebased: rebase.alreadyRebased,
      },
      varianceCaseIds: variance.caseIds,
      spanIds: variance.spanIds,
      outgoingStockCustodyId: evidence.outgoingStockCustodyId,
      incomingStockCustodyId: stock.incomingPeriodId,
      outgoingCashCustodyId: evidence.outgoingCashCustodyId,
      incomingCashCustodyId,
      outgoingShiftId: handover.outgoingShiftId,
      incomingShiftId: evidence.incomingShiftId,
      outgoingShiftStatus: outgoing.outgoingShiftStatus,
      acceptedAt: acceptedAt.toISOString(),
      // Absent on an ordinary accept, so SH-20's row is byte-identical.
      ...(exception ? { missingItemIds } : {}),
    },
  });

  // ── 16a. And who authorised finishing without the count ──
  //
  // A SECOND row, not a substituted one. Step 16 records the acceptance, whose
  // actor is the custodian who took the shelf; this records the exception,
  // whose actor is the manager who authorised it. Collapsing them into one row
  // would force a single `userId` to answer two different questions, and
  // whichever name it carried would be a false answer to the other.
  if (exception) {
    await auditInTransaction(tx, {
      cafeId: handover.cafeId,
      userId: exception.managerId,
      action: HANDOVER_MANAGER_EXCEPTION_AUDIT_ACTION,
      entity: "HandoverSession",
      entityId: handover.id,
      details: {
        branchId: handover.branchId,
        kind: exception.kind,
        reasonCodeId: exception.reasonCodeId,
        note: exception.note,
        // The items nobody counted, named. This is the property the audit
        // trail alone could not provide in R1, and the reason the omission is
        // also written onto each `HandoverRequiredItem` row.
        missingItemIds,
        missingItemNames,
        openingExceptionId,
        acceptedStockCountSessionId: acceptedSessionId,
        incomingUserId: args.incomingUserId,
        incomingShiftId: evidence.incomingShiftId,
        idempotencyKey: args.idempotencyKey,
        exceptionAt: acceptedAt.toISOString(),
      },
    });
  }

  return result;
}

/**
 * Hand the drawer to the arriving custodian, or report that none moved.
 *
 * The closing figure is what the close COUNTED, read back from the shift
 * rather than recomputed: the variance is a separate finding on the shift, and
 * the drawer closes at the figure that was actually there.
 */
async function transferCashCustody(
  tx: Prisma.TransactionClient,
  args: {
    outgoingCashCustodyId: string | null;
    branchId: string;
    outgoingShiftId: string;
    incomingShiftId: string;
    incomingUserId: string;
    acceptedAt: Date;
  }
): Promise<string | null> {
  if (!args.outgoingCashCustodyId) return null;

  const period = await tx.custodyPeriod.findFirst({
    where: {
      id: args.outgoingCashCustodyId,
      branchId: args.branchId,
      scope: "CASH",
    },
    select: { id: true, status: true },
  });
  // A drawer a `BRANCH_CUSTODY` close already discharged, or one closed
  // elsewhere, is not this acceptance's to move. Neither is a missing one.
  if (!period || period.status !== "OPEN") return null;

  const shift = await tx.shift.findUnique({
    where: { id: args.outgoingShiftId },
    select: { actualCashAmount: true },
  });

  const cash = await transferCustody(tx, {
    outgoingPeriodId: period.id,
    scope: "CASH",
    incoming: {
      participants: [{ userId: args.incomingUserId, role: "PRIMARY" }],
      shiftId: args.incomingShiftId,
      holderType: "USER",
      openedById: args.incomingUserId,
    },
    closingCashAmount:
      shift?.actualCashAmount === null || shift?.actualCashAmount === undefined
        ? null
        : Number(shift.actualCashAmount),
    actorId: args.incomingUserId,
    acceptedById: args.incomingUserId,
    acceptedAt: args.acceptedAt,
  });
  return cash.incomingPeriodId;
}

// ═══════════════ SH-22 · Half A — the branch takes the shelf ═══════════════
//
// A `BRANCH_CUSTODY` handover ENDS employee custody of the stock rather than
// moving it to another employee. Nobody arrives, nobody signs, and the shelf
// is held by the branch itself until somebody opens a shift and verifies it
// (Half B). That is a different act from SH-20's acceptance, and this is a
// SIBLING transaction rather than a parameter on that one:
//
//   * SH-20's `resolveAcceptableEvidence` refuses a `BRANCH_CUSTODY` target
//     several lines before its first write, and SH-21 inherits that refusal.
//     Both keep it. A flag that relaxed it would make one gate answer two
//     different questions, and the answer to either would be one edit away
//     from becoming wrong for the other.
//
//   * `runAcceptance` resolves an arriving shift, moves the drawer, releases
//     that shift's gate and names an incoming user on the completion. Every
//     one of those is a step this path must NOT take, and a `runAcceptance`
//     with four "unless branch custody" branches inside it would be a worse
//     record of what each acceptance does than two functions that each do one
//     thing.
//
// ── WHAT IS THE SAME, AND IS REUSED WHOLE ──
//
// The evidence rules. The count must be CONFIRMED, bound to this handover,
// carry an acknowledgement for every counted line of the CURRENT round and no
// dispute; the outgoing STOCK custody must be the one named at close and
// still OPEN; the freeze must be this handover's. The settlement, the rebase,
// the boundary, the count lock and the accepted-variance writer are SH-14's,
// SH-23's, SH-15's, SH-13's and SH-17's, called unchanged.
//
// ── WHAT IS DIFFERENT, AND WHY ──
//
// CASH does not move, and must already have stopped moving. A
// `BRANCH_CUSTODY` close discharges the outgoing drawer at financial close
// (`finalizeCashCustodyAtFinancialClose`) and opens no successor, because
// nobody was appointed to hold it. So this gate REQUIRES the outgoing CASH
// period to be non-OPEN rather than transferring it: a drawer still open here
// would mean the close did not do what this acceptance is assuming it did.
//
// The STOCK successor is held by the BRANCH: zero participants, no shift, no
// `responsibleShiftId`. `openedById` is the manager, which is the truthful
// answer to "who put the stock into branch custody" and is not a claim that
// they are holding it.
//
// No `NO_INCOMING` exception is manufactured. That kind classifies an
// override of a SHIFT_TO_SHIFT acceptance whose recipient was absent;
// `resolvedTarget = BRANCH_CUSTODY` already states that no person receives
// this stock, and a second record saying the same thing in weaker words would
// invite a reader to look for a recipient who was never intended.

/** The one refusal R-A1 exists to make, in the café's own words. */
const SHIFT_AWAITING_CUSTODY =
  "في وردية مستنية العهدة — سلّم ليها أو اقفلها قبل التحويل لعهدة الفرع";
const NOT_BRANCH_TARGET =
  "التسليم ده مش للعهدة المركزية — استخدم الاستلام العادي";
const OUTGOING_CASH_STILL_OPEN =
  "عهدة الخزنة لسه مفتوحة — لازم تتقفل مع الإقفال المالي قبل التحويل لعهدة الفرع";
const BRANCH_OMISSION_REASON_REQUIRED =
  "في أصناف مطلوبة ماتعدّتش — لازم سبب مدير ومبرر مكتوب";

export const BRANCH_CUSTODY_ACCEPTED_AUDIT_ACTION = HANDOVER_ACCEPTED_AUDIT_ACTION;

/** Everything Half A's gate resolved, and every refusal it already made. */
type BranchAcceptedEvidence = {
  handover: LockedHandover;
  acceptedSessionId: string;
  outgoingStockCustodyId: string;
  /** The already-discharged drawer, recorded so the audit can name it. */
  outgoingCashCustodyId: string | null;
  countedLineIds: string[];
};

/**
 * A manager's authority to finish a branch acceptance over an uncounted
 * required item. Optional, and only ever consulted when something was
 * actually omitted.
 */
type BranchOmissionAuthority = {
  reasonCodeId: string;
  /** Trimmed and non-empty by the time it reaches the transaction. */
  note: string;
};

export type BranchCustodyAcceptResult = {
  status: "COMPLETED";
  handoverTarget: "BRANCH_CUSTODY";
  resolvedTarget: "BRANCH_CUSTODY";
  acceptedStockCountSessionId: string | null;
  /** The BRANCH-held successor. */
  incomingStockCustodyId: string | null;
  /** Always null. Named rather than omitted, because it is the decision. */
  incomingCashCustodyId: null;
  incomingShiftId: null;
  incomingUserId: null;
  boundary: { written: number; verified: number; carried: number };
  requiredItems: { satisfied: number; omitted: string[] };
  rebase: RebaseResult | null;
  varianceCaseIds: string[];
  spanIds: string[];
  outgoingShiftStatus: "CLOSED";
  openingExceptionId: string | null;
  /** `inventoryItemId` of every required item nobody counted, ascending. */
  missingItemIds: string[];
  alreadyAccepted: boolean;
};

/**
 * Read-only. Every refusal is thrown before the first write, so a gate that
 * says no has changed nothing about the branch.
 *
 * Deliberately NOT `resolveAcceptableEvidence` with a flag: that function's
 * `target !== "SHIFT_TO_SHIFT"` refusal and its arriving-shift resolution are
 * the two things this path must invert, and inverting them there would leave
 * SH-20 and SH-21 depending on a gate that no longer says one thing.
 */
async function resolveBranchAcceptableEvidence(
  tx: Prisma.TransactionClient,
  handover: LockedHandover,
  args: { cafeId: string; viewerBranchId: string | null }
): Promise<BranchAcceptedEvidence> {
  // Another tenant's handover is not confirmed to exist. A 403 here would
  // tell one café that an id belonging to another one is real.
  if (handover.cafeId !== args.cafeId) throw new ApiError(404, HANDOVER_NOT_FOUND);
  if (args.viewerBranchId !== null && handover.branchId !== args.viewerBranchId) {
    throw new ApiError(403, FOREIGN_BRANCH);
  }
  if (!ACCEPTABLE_STATUSES.includes(handover.status)) {
    throw new ApiError(409, NOT_ACCEPTABLE);
  }
  // The IMMUTABLE target, read and never written. SH-14 is the only writer of
  // this column, and a route that could retarget a handover at acceptance
  // would make "where the stock is going" a decision taken after the count
  // rather than before it.
  if (handover.target !== "BRANCH_CUSTODY") {
    throw new ApiError(409, NOT_BRANCH_TARGET);
  }
  if (handover.stockCountSessionId === null) throw new ApiError(409, NO_BOUND_COUNT);

  // The pointer names the evidence — never "the newest confirmed session",
  // which after a recount would silently accept a round nobody reviewed.
  const acceptedSessionId = handover.stockCountSessionId;
  const session = await tx.stockCountSession.findUnique({
    where: { id: acceptedSessionId },
    select: {
      id: true, cafeId: true, branchId: true, status: true,
      accountabilityContext: true, handoverId: true,
    },
  });
  if (!session) throw new ApiError(409, NO_BOUND_COUNT);
  if (session.cafeId !== handover.cafeId || session.branchId !== handover.branchId) {
    throw new ApiError(409, COUNT_NOT_OURS);
  }
  if (session.status !== "CONFIRMED") throw new ApiError(409, COUNT_NOT_CONFIRMED);
  // HANDOVER, and only HANDOVER. A branch OPENING verification's session is
  // Half B's evidence about a shelf the branch is handing BACK, and accepting
  // one here would close a handover on a count of the wrong direction.
  if (session.accountabilityContext !== "HANDOVER" || session.handoverId !== handover.id) {
    throw new ApiError(409, COUNT_NOT_OURS);
  }

  const lines = await tx.stockCountLine.findMany({
    where: { sessionId: acceptedSessionId },
    select: { ...EFFECTIVE_EVIDENCE_SELECT, id: true },
    orderBy: { id: "asc" },
  });
  // A line nobody counted has no figure to sign for, and
  // `acknowledgeStockLine` refuses to sign one.
  const countedLines = lines.filter(
    (line) => !(line.countedQuantity === null && effectiveCountEvidence(line).recountId === null)
  );

  // Against the CURRENT session only. An acknowledgement reaches a session
  // through its line, so a row belonging to a superseded round can neither
  // satisfy a missing line nor block on a stale dispute.
  const acknowledgements = await tx.handoverStockAcknowledgement.findMany({
    where: { handoverId: handover.id, line: { sessionId: acceptedSessionId } },
    select: { stockCountLineId: true, decision: true },
  });
  const acknowledged = new Set(acknowledgements.map((a) => a.stockCountLineId));
  if (countedLines.some((line) => !acknowledged.has(line.id))) {
    throw new ApiError(409, LINES_UNACKNOWLEDGED);
  }
  if (acknowledgements.some((a) => a.decision === "DISPUTED")) {
    throw new ApiError(409, LINES_DISPUTED);
  }

  // The custody being discharged is the one the CLOSING shift held, named on
  // the handover at close — not "whatever is open at the branch now".
  if (handover.outgoingStockCustodyId === null) {
    throw new ApiError(409, NO_OUTGOING_STOCK_CUSTODY);
  }
  const outgoingStock = await tx.custodyPeriod.findUnique({
    where: { id: handover.outgoingStockCustodyId },
    select: { id: true, branchId: true, scope: true, status: true, holderType: true },
  });
  if (
    !outgoingStock
    || outgoingStock.branchId !== handover.branchId
    || outgoingStock.scope !== "STOCK"
    || outgoingStock.status !== "OPEN"
  ) {
    throw new ApiError(409, NO_OUTGOING_STOCK_CUSTODY);
  }

  // ── CASH: already settled, and not this transaction's to touch ──
  //
  // The `BRANCH_CUSTODY` close discharged the drawer at financial close and
  // opened no successor. A period still OPEN here means that did not happen,
  // and moving it now would make an acceptance answer a question the close
  // owns. Refused rather than repaired.
  if (handover.outgoingCashCustodyId !== null) {
    const cash = await tx.custodyPeriod.findUnique({
      where: { id: handover.outgoingCashCustodyId },
      select: { id: true, branchId: true, scope: true, status: true },
    });
    if (cash && cash.branchId === handover.branchId && cash.scope === "CASH"
      && cash.status === "OPEN") {
      throw new ApiError(409, OUTGOING_CASH_STILL_OPEN);
    }
  }

  // ── R-A1: nobody may be left waiting for a transfer that will not come ──
  //
  // A shift gated `AWAITING_CUSTODY_TRANSFER` opened while this handover was
  // live and is waiting for an arriving custodian to be named. Branch custody
  // names nobody, so completing here would strand that shift on a gate no
  // later operation could release — and `ensureCustodyForShift` would never
  // re-decide it, because the handover it was waiting for is finished.
  //
  // Refused deterministically, BEFORE the first write, and with no
  // retargeting: the fix is somebody's to make (hand to that shift, or close
  // it), and inventing an incoming user to absorb it would be this milestone
  // recording a custodian nobody appointed. `branchIsMidHandover` holds a
  // SHARE lock on this handover's row for the whole of a concurrent
  // shift-open, so a shift cannot appear between this check and the
  // completion below.
  const waiting = await tx.shift.count({
    where: {
      branchId: handover.branchId,
      status: "OPEN",
      custodyGateReason: "AWAITING_CUSTODY_TRANSFER",
    },
  });
  if (waiting > 0) throw new ApiError(409, SHIFT_AWAITING_CUSTODY);

  // Acceptance releases the freeze at step 17, so it must be releasing its
  // own. A branch frozen by a different handover is not this one's to reopen.
  const freeze = await activeFreezeFor(tx, handover.branchId);
  if (!freeze || freeze.handoverId !== handover.id) {
    throw new ApiError(409, FREEZE_NOT_OURS);
  }

  return {
    handover,
    acceptedSessionId,
    outgoingStockCustodyId: outgoingStock.id,
    outgoingCashCustodyId: handover.outgoingCashCustodyId,
    countedLineIds: countedLines.map((line) => line.id),
  };
}

/**
 * The answer to a caller whose branch acceptance committed and whose response
 * was lost. Read back from persisted state, never remembered: a retry may
 * arrive in a different process weeks later.
 */
async function buildBranchReplayResult(
  tx: Prisma.TransactionClient,
  handover: LockedHandover
): Promise<BranchCustodyAcceptResult> {
  const [boundaries, required, cases] = await Promise.all([
    tx.handoverStockBoundary.findMany({
      where: { handoverId: handover.id },
      select: { verified: true },
    }),
    tx.handoverRequiredItem.findMany({
      where: { handoverId: handover.id },
      select: {
        satisfiedByLineId: true, omitted: true,
        itemNameSnapshot: true, inventoryItemId: true,
      },
      orderBy: { inventoryItemId: "asc" },
    }),
    tx.varianceCase.findMany({
      where: { acceptedHandoverId: handover.id },
      select: { id: true, varianceSpan: { select: { id: true } } },
      orderBy: { id: "asc" },
    }),
  ]);

  const exceptionRow = await tx.openingException.findFirst({
    where: { handoverId: handover.id },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const persisted = await tx.handoverSession.findUniqueOrThrow({
    where: { id: handover.id },
    select: {
      resolvedTarget: true, acceptedStockCountSessionId: true,
      incomingStockCustodyId: true,
    },
  });

  return {
    status: "COMPLETED",
    handoverTarget: "BRANCH_CUSTODY",
    // Read back rather than asserted: if the persisted row ever disagreed, a
    // replay restating the expected answer would hide the disagreement.
    resolvedTarget: persisted.resolvedTarget === "BRANCH_CUSTODY"
      ? "BRANCH_CUSTODY"
      : (() => { throw new ApiError(409, NOT_BRANCH_TARGET); })(),
    acceptedStockCountSessionId: persisted.acceptedStockCountSessionId,
    incomingStockCustodyId: persisted.incomingStockCustodyId,
    incomingCashCustodyId: null,
    incomingShiftId: null,
    incomingUserId: null,
    boundary: {
      written: boundaries.length,
      verified: boundaries.filter((b) => b.verified).length,
      carried: boundaries.filter((b) => !b.verified).length,
    },
    requiredItems: {
      satisfied: required.filter((r) => r.satisfiedByLineId !== null).length,
      omitted: required.filter((r) => r.omitted).map((r) => r.itemNameSnapshot),
    },
    // NULL on purpose: this call rebased nothing, and restating an earlier
    // call's `RebaseResult` would describe work that did not happen here.
    rebase: null,
    varianceCaseIds: cases.map((c) => c.id),
    spanIds: cases.flatMap((c) => (c.varianceSpan ? [c.varianceSpan.id] : [])),
    outgoingShiftStatus: "CLOSED",
    openingExceptionId: exceptionRow?.id ?? null,
    missingItemIds: required.filter((r) => r.omitted).map((r) => r.inventoryItemId),
    alreadyAccepted: true,
  };
}

/**
 * Accept a closing handover into BRANCH stock custody: one transaction,
 * eighteen steps, all or none of it.
 *
 * `managerId` is the authenticated manager and the only actor this path has.
 * There is no arriving custodian to be the actor instead, and the manager is
 * never recorded as holding the stock — `openedById` on the BRANCH successor
 * says who put it there, and the period has no participants at all.
 */
export async function acceptToBranchCustody(args: {
  handoverId: string;
  /** The authenticated manager. From `session.id`; never from a request body. */
  managerId: string;
  idempotencyKey: string;
  /** Required only when a required item was never counted. */
  omissionReasonCodeId?: string | null;
  omissionNote?: string | null;
  cafeId: string;
  viewerBranchId: string | null;
  /** Test-only failure seam. See {@link AcceptanceCheckpoint}. */
  __afterStep?: AcceptanceCheckpoint;
}): Promise<BranchCustodyAcceptResult> {
  // Before the transaction, so a caller who sent whitespace does not first
  // take a row lock to be told so — the rule `overrideAcceptHandover` states.
  const note = args.omissionNote?.trim() ?? "";
  const omission: BranchOmissionAuthority | null =
    args.omissionReasonCodeId && note.length > 0
      ? { reasonCodeId: args.omissionReasonCodeId, note }
      : null;
  // A reason with no note, or a note with no reason, is half an
  // authorisation. Refused here rather than silently ignored, because a
  // caller who believed they had authorised an omission and had not would
  // discover it as an unexplained 409 several steps later.
  if ((args.omissionReasonCodeId || note.length > 0) && !omission) {
    throw new ApiError(400, BRANCH_OMISSION_REASON_REQUIRED);
  }

  return db.$transaction(async (tx) => {
    // 1. The row lock, first, so everything read below is the state written
    //    to — and so a concurrent shift-open blocks on it (see R-A1).
    if (!(await lockHandover(tx, args.handoverId))) {
      throw new ApiError(404, HANDOVER_NOT_FOUND);
    }

    const handover = await tx.handoverSession.findUniqueOrThrow({
      where: { id: args.handoverId },
      select: LOCKED_HANDOVER_SELECT,
    });

    // 2. Tenancy before anything else, including before the replay: reading
    //    back a completed acceptance is still reading somebody's record.
    if (handover.cafeId !== args.cafeId) throw new ApiError(404, HANDOVER_NOT_FOUND);
    if (args.viewerBranchId !== null && handover.branchId !== args.viewerBranchId) {
      throw new ApiError(403, FOREIGN_BRANCH);
    }

    // 3. Already accepted. A retry under the SAME key hears the same answer;
    //    a different key is a claim to a second acceptance of one handover.
    if (handover.status === "COMPLETED") {
      if (handover.idempotencyKey !== args.idempotencyKey) {
        throw new ApiError(409, ALREADY_ACCEPTED);
      }
      return buildBranchReplayResult(tx, handover);
    }

    // 4. The gate. Every refusal is thrown before the first write.
    const evidence = await resolveBranchAcceptableEvidence(tx, handover, {
      cafeId: args.cafeId,
      viewerBranchId: args.viewerBranchId,
    });

    return runBranchAcceptance(tx, evidence, {
      managerId: args.managerId,
      idempotencyKey: args.idempotencyKey,
      omission,
      __afterStep: args.__afterStep,
    });
  });
}

/**
 * Steps 5 through 18, in order. Every write lands on the caller's transaction
 * client; nothing here opens one.
 */
async function runBranchAcceptance(
  tx: Prisma.TransactionClient,
  evidence: BranchAcceptedEvidence,
  args: {
    managerId: string;
    idempotencyKey: string;
    omission: BranchOmissionAuthority | null;
    __afterStep?: AcceptanceCheckpoint;
  }
): Promise<BranchCustodyAcceptResult> {
  const { handover, acceptedSessionId } = evidence;
  const omission = args.omission;
  let openingExceptionId: string | null = null;
  const checkpoint = async (step: number) => {
    if (args.__afterStep) await args.__afterStep(step, tx);
  };

  // ── 5. The omission reason, validated against this handover's own café ──
  //
  // Read from the LOCKED row rather than from the caller, so a reason code
  // belonging to somebody else cannot authorise this omission. Validated
  // before settlement writes anything, which is what makes a bad reason code
  // leave the required-item rows exactly as they were.
  if (omission) {
    await assertHandoverReason(tx, omission.reasonCodeId, handover.cafeId, "سبب الاستثناء");
  }

  // ── 6. Required items ──
  //
  // SH-14's authority, used rather than reimplemented. The note is passed
  // ONLY when a manager authorised the omission — a note is the
  // authorisation's evidence, and an acceptance that supplied one without a
  // reason would be an unaudited override.
  const settled = await settleRequiredItems(tx, {
    handoverId: handover.id,
    acceptedSessionId,
    ...(omission ? { omissionNote: omission.note } : {}),
  });
  // Ascending by `inventoryItemId`, the order settlement already sorted them
  // into, so the result, the audit row and a later replay agree.
  const missingItemIds = settled.omitted.map((entry) => entry.inventoryItemId);
  const missingItemNames = settled.omitted.map((entry) => entry.itemNameSnapshot);
  // A `throw` inside the transaction, so the `omitted: true` rows settlement
  // wrote moments ago never commit.
  if (!omission && settled.omitted.length > 0) {
    throw new ApiError(409, BRANCH_OMISSION_REASON_REQUIRED);
  }
  await checkpoint(6);

  // ── 7. Rebase, under the freeze that protected the count ──
  //
  // The freeze is NOT released first. Releasing it to get the movement
  // through would reopen the shelf in the middle of the acceptance, which is
  // the one thing it exists to prevent; step 17 releases it.
  //
  // The manager is the actor. On this path there is no arriving custodian to
  // be one, and the rebase is an act performed by whoever authorised the
  // acceptance rather than by whoever is taking the room — nobody is.
  const rebase = await rebaseFromCountInTransaction(tx, {
    sessionId: acceptedSessionId,
    actorId: args.managerId,
    idempotencyKey: `${handover.id}:rebase`,
    freezeToken: handover.id,
  });
  await checkpoint(7);

  // ── 8. The closing position ──
  const boundary = await buildStockBoundary(tx, {
    cafeId: handover.cafeId,
    branchId: handover.branchId,
    handoverId: handover.id,
    acceptedSessionId,
  });
  const written = await persistStockBoundary(tx, {
    handoverId: handover.id,
    lines: boundary.lines,
  });
  const boundaryRows = await tx.handoverStockBoundary.findMany({
    where: { handoverId: handover.id },
    select: { id: true, inventoryItemId: true },
  });
  const boundaryByItemId = new Map(
    boundaryRows.map((row) => [row.inventoryItemId, row.id])
  );
  await checkpoint(8);

  // ── 9. The accepted evidence becomes immutable ──
  await lockCountSession(tx, {
    sessionId: acceptedSessionId,
    handoverId: handover.id,
    actorId: args.managerId,
  });
  await checkpoint(9);

  // ── 10. Accepted variance and its attribution ──
  //
  // The custody the difference is measured against is the OUTGOING one — the
  // employee period that held the shelf while the gap appeared. The BRANCH
  // successor does not exist yet and did not hold anything during the
  // interval being judged, so naming it here would move a shortage onto a
  // custody that began after it.
  const variance = await openHandoverVarianceCases(tx, {
    cafeId: handover.cafeId,
    branchId: handover.branchId,
    handoverId: handover.id,
    acceptedSessionId,
    outgoingCustodyPeriodId: evidence.outgoingStockCustodyId,
    boundaryByItemId,
    openedById: args.managerId,
  });
  await checkpoint(10);

  // ── 11. One instant, reused by steps 12, 14 and 15 ──
  //
  // Taken HERE and not earlier, for the reason SH-20 states:
  // `openHandoverVarianceCases` derives its spans' `toVerifiedAt` from
  // `handover.acceptedAt ?? new Date()`, and at step 10 the column is still
  // NULL. An `acceptedAt` captured before step 10 would be earlier than the
  // spans it contains.
  const acceptedAt = new Date();

  // ── 12. STOCK custody moves from the employee to the BRANCH ──
  //
  // Zero participants, no shift, no `responsibleShiftId` — the successor is
  // held by nobody, which is the entire point of branch custody and the one
  // fact a later reader must not be able to mistake for a person. The
  // predecessor records who accepted it: the manager, who is the only actor
  // this path has.
  const stock = await transferCustody(tx, {
    outgoingPeriodId: evidence.outgoingStockCustodyId,
    scope: "STOCK",
    incoming: {
      participants: [],
      shiftId: null,
      responsibleShiftId: null,
      holderType: "BRANCH",
      // Who put the stock into branch custody, not who is holding it.
      openedById: args.managerId,
    },
    actorId: args.managerId,
    acceptedById: args.managerId,
    acceptedAt,
  });
  await checkpoint(12);

  // ── 13. CASH does not move ──
  //
  // Deliberately nothing. The drawer was discharged at financial close with
  // no successor, and the gate refused this acceptance if it was not. There
  // is no step to skip conditionally and no null to write.

  // ── 14. The outgoing shift closes ──
  //
  // `closedById` is the manager: the person who accepted the count and
  // discharged the custodian, which on this path is the only person involved.
  const outgoing = await finalizeOutgoingShift(tx, {
    outgoingShiftId: handover.outgoingShiftId,
    closedById: args.managerId,
    at: acceptedAt,
  });
  await checkpoint(14);

  // ── 15. The record ──
  //
  // `resolvedTarget` is WRITTEN; `target` is not. The immutable intent is
  // SH-14's, and this path never rewrites it — the gate refused everything
  // that was not already `BRANCH_CUSTODY`.
  //
  // The three incoming identities stay NULL and are written explicitly rather
  // than omitted: `BRANCH_CUSTODY` means no person receives this stock, and a
  // column left unwritten would be indistinguishable from one nobody had got
  // around to filling.
  //
  // The guard in the `where` is what makes two racing acceptances produce one
  // completion: the loser matches zero rows and is refused.
  const completed = await tx.handoverSession.updateMany({
    where: { id: handover.id, status: { in: [...ACCEPTABLE_STATUSES] } },
    data: {
      status: "COMPLETED",
      resolvedTarget: "BRANCH_CUSTODY",
      acceptedStockCountSessionId: acceptedSessionId,
      acceptedAt,
      completedAt: acceptedAt,
      idempotencyKey: args.idempotencyKey,
      incomingUserId: null,
      incomingShiftId: null,
      incomingStockCustodyId: stock.incomingPeriodId,
      incomingCashCustodyId: null,
      ...(omission
        ? {
            exceptionById: args.managerId,
            exceptionReason: omission.note,
            exceptionAt: acceptedAt,
          }
        : {}),
    },
  });
  if (completed.count === 0) throw new ApiError(409, NOT_ACCEPTABLE);
  await checkpoint(15);

  // ── 16. The omission becomes a record of its own ──
  //
  // AFTER the guarded write above, which is what makes it exactly-once with
  // no unique index: two acceptances racing both reach step 15, exactly one
  // matches a row, and the loser throws before reaching here.
  //
  // `MANAGER_ADJUSTMENT` and never `NO_INCOMING`. Nobody was expected to
  // arrive, so there is no absent recipient to classify; the kind records
  // what the manager actually authorised, which is finishing over shelves
  // nobody counted.
  if (omission && missingItemIds.length > 0) {
    const openingException = await tx.openingException.create({
      data: {
        cafeId: handover.cafeId,
        branchId: handover.branchId,
        handoverId: handover.id,
        kind: "MANAGER_ADJUSTMENT",
        reasonCodeId: omission.reasonCodeId,
        note: omission.note,
        authorizedById: args.managerId,
      },
      select: { id: true },
    });
    openingExceptionId = openingException.id;
  }
  await checkpoint(16);

  // ── 17. The shelf is unfrozen ──
  await releaseInventoryFreeze(tx, {
    handoverId: handover.id,
    actorId: args.managerId,
  });
  await checkpoint(17);

  const result: BranchCustodyAcceptResult = {
    status: "COMPLETED",
    handoverTarget: "BRANCH_CUSTODY",
    resolvedTarget: "BRANCH_CUSTODY",
    acceptedStockCountSessionId: acceptedSessionId,
    incomingStockCustodyId: stock.incomingPeriodId,
    incomingCashCustodyId: null,
    incomingShiftId: null,
    incomingUserId: null,
    boundary: {
      written: written.written,
      verified: boundary.verifiedCount,
      carried: boundary.carriedCount,
    },
    requiredItems: {
      satisfied: await tx.handoverRequiredItem.count({
        where: { handoverId: handover.id, satisfiedByLineId: { not: null } },
      }),
      omitted: missingItemNames,
    },
    rebase,
    varianceCaseIds: variance.caseIds,
    spanIds: variance.spanIds,
    outgoingShiftStatus: outgoing.outgoingShiftStatus,
    openingExceptionId,
    missingItemIds,
    alreadyAccepted: false,
  };

  // ── 18. One audit row, carrying the whole shape ──
  //
  // The same action as an ordinary acceptance, because it IS one: a handover
  // was accepted. `resolvedTarget` in the details is what tells the two
  // apart, and it is the column a reader would consult anyway. A second
  // action name would fork every existing reader of handover acceptances on a
  // distinction the details already carry exactly.
  await auditInTransaction(tx, {
    cafeId: handover.cafeId,
    userId: args.managerId,
    action: HANDOVER_ACCEPTED_AUDIT_ACTION,
    entity: "HandoverSession",
    entityId: handover.id,
    details: {
      branchId: handover.branchId,
      acceptedStockCountSessionId: acceptedSessionId,
      resolvedTarget: "BRANCH_CUSTODY",
      idempotencyKey: args.idempotencyKey,
      boundary: result.boundary,
      requiredItemsSatisfied: result.requiredItems.satisfied,
      rebase: {
        itemsRebased: rebase.itemsRebased,
        itemsSkipped: rebase.itemsSkipped,
        alreadyRebased: rebase.alreadyRebased,
      },
      varianceCaseIds: variance.caseIds,
      spanIds: variance.spanIds,
      outgoingStockCustodyId: evidence.outgoingStockCustodyId,
      incomingStockCustodyId: stock.incomingPeriodId,
      // The drawer this handover named, already discharged by the close. Both
      // recorded, so the row states that CASH did not move here rather than
      // leaving a reader to infer it from an absence.
      outgoingCashCustodyId: evidence.outgoingCashCustodyId,
      incomingCashCustodyId: null,
      outgoingShiftId: handover.outgoingShiftId,
      incomingShiftId: null,
      incomingUserId: null,
      outgoingShiftStatus: outgoing.outgoingShiftStatus,
      acceptedAt: acceptedAt.toISOString(),
      ...(omission ? { missingItemIds } : {}),
    },
  });

  // ── 18a. And who authorised finishing without the count ──
  //
  // A second row, whose actor is the same manager but whose subject is the
  // authority rather than the acceptance. Kept separate for the reason SH-21
  // states: one `userId` answering two questions gives a false answer to one
  // of them the moment the two people differ, and they differ on every
  // SHIFT_TO_SHIFT override.
  if (omission && missingItemIds.length > 0) {
    await auditInTransaction(tx, {
      cafeId: handover.cafeId,
      userId: args.managerId,
      action: HANDOVER_MANAGER_EXCEPTION_AUDIT_ACTION,
      entity: "HandoverSession",
      entityId: handover.id,
      details: {
        branchId: handover.branchId,
        kind: "MANAGER_ADJUSTMENT",
        reasonCodeId: omission.reasonCodeId,
        note: omission.note,
        missingItemIds,
        missingItemNames,
        openingExceptionId,
        acceptedStockCountSessionId: acceptedSessionId,
        resolvedTarget: "BRANCH_CUSTODY",
        idempotencyKey: args.idempotencyKey,
        exceptionAt: acceptedAt.toISOString(),
      },
    });
  }
  await checkpoint(18);

  return result;
}
