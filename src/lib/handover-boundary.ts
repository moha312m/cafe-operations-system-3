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

import type { BoundarySource, Prisma, StockCountType } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { audit, auditInTransaction } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  EFFECTIVE_EVIDENCE_SELECT,
  effectiveCountEvidence,
  hasAuthoritativeObservation,
} from "@/lib/count-evidence";
import { round3 } from "@/lib/costing";
import { linkShiftCustody, transferCustody } from "@/lib/custody";
import { lockItemForUpdate } from "@/lib/ledger";
import { rebaseFromCountInTransaction, type RebaseResult } from "@/lib/stock-rebase";
import {
  ACTIVE_COUNT_STATUSES,
  COUNT_STARTED_AUDIT_ACTION,
  lockCountSession,
} from "@/lib/stock-count";
import { resolveCountScopeInTransaction } from "@/lib/stock-count-policy";
import {
  classifyStockVariance,
  persistVarianceSpan,
} from "@/lib/stock-variance-attribution";
import { openVarianceCase } from "@/lib/variance-case";
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
      line && !isUnreached(line)
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
 * A line the count never reached: in scope, and nothing written to it.
 *
 * HAVING A LINE IS NOT HAVING BEEN COUNTED. A handover count may close over
 * shelves nobody reached (SH-21), and each of those still has a line.
 * Routing by line-existence sent them into the counted path, where the
 * pairing rule found a NULL cursor and refused the whole boundary — so the
 * acceptance could not be written at all. Their truthful row is the one this
 * module already has a name for: the book figure, carried, unverified,
 * opening no variance and naming nobody.
 *
 * THE MALFORMED CASE IS DELIBERATELY EXCLUDED. A figure written with no
 * cursor is somebody's observation, badly recorded — not an empty round. It
 * still goes to `countedBoundary` and is still REFUSED there, because
 * silently downgrading it to SYSTEM_CARRIED would throw away a real
 * observation, which is exactly the repair the pairing rule at the top of
 * this file forbids. Hence the raw-column reading beside the shared
 * predicate: "no observation" and "nothing here at all" are different
 * questions, and only the second one may carry.
 */
function isUnreached(
  line: Prisma.StockCountLineGetPayload<{ select: typeof ACCEPTED_LINE_SELECT }>
): boolean {
  return (
    !hasAuthoritativeObservation(line) &&
    line.countedQuantity === null &&
    line.recounts.length === 0 &&
    line.corrections.length === 0
  );
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

// ═══════════ SH-22 · Half B — the branch hands the shelf back ═══════════
//
// A shift opened while the branch itself held the stock is gated
// `AWAITING_OPENING_VERIFICATION`: it may not sell, serve or collect, because
// nobody has yet established what is on the shelf it would be selling from.
// Half B is the two acts that discharge that gate — count the whole shelf,
// then verify the count and take custody of what it found.
//
// ── WHAT MAKES THIS DIFFERENT FROM A HANDOVER COUNT ──
//
// Direction. A handover count measures what a LEAVING custodian is handing
// over; this measures what an ARRIVING one is taking on from nobody. There is
// no outgoing person to acknowledge lines, no incoming person to sign for
// them, and no freeze — the branch is not mid-handover, it is simply holding
// stock.
//
// Strictness. A handover count may state a gap: a shelf nobody reached
// submits and confirms as PENDING-and-unobserved, because a leaving custodian
// running out of time is a real situation with a truthful representation.
// A branch opening verification may NOT. The whole point is to establish what
// the arriving custodian is answerable for, and a line nobody looked at would
// make them answerable for a shelf nobody has seen since the branch took it.
// `submitCountSession` and `confirmCountSession` already relax only for
// `accountabilityContext === "HANDOVER"`, so the strictness here is the
// default path rather than a new rule — and it is proved rather than assumed.
//
// Scope. FULL, and the whole active branch inventory, derived through the
// same authoritative resolver every other count uses. Not the handover's
// CRITICAL/FULL policy: that policy answers "what must a leaving custodian
// count", and narrowing an opening verification with it would let a branch
// hand over shelves nobody has looked at since it took them.

/** The whole active, non-archived branch inventory, and never a client list. */
const OPENING_VERIFICATION_TYPE: StockCountType = "FULL";

const NO_BRANCH_CUSTODY =
  "مفيش عهدة مخزن باسم الفرع مفتوحة — مفيش حاجة تتراجع";
const SHIFT_NOT_GATED =
  "الوردية دي مش مستنية جرد افتتاحي";
const AMBIGUOUS_OPENING_SHIFT =
  "في أكتر من وردية مستنية الجرد الافتتاحي — مينفعش نختار واحدة منهم";
const OPENING_CASH_MISSING =
  "عهدة الخزنة بتاعة الوردية مش مفتوحة — مينفعش نراجع المخزن من غيرها";
const OPENING_COUNT_NOT_OURS =
  "الجرد ده مش الجرد الافتتاحي بتاع عهدة الفرع دي";
const OPENING_COUNT_NOT_CONFIRMED = "الجرد الافتتاحي لسه متأكدش";
const OPENING_COUNT_HAS_GAPS =
  "في سطور في الجرد الافتتاحي محدش عدّها — الجرد الافتتاحي لازم يكون كامل";
const OPENING_ALREADY_VERIFIED_ELSEWHERE =
  "عهدة الفرع دي اتراجعت بجرد تاني خلاص";
const ANOTHER_COUNT_RUNNING = "في جرد شغال في الفرع بالفعل — اقفله الأول";

export const BRANCH_CUSTODY_VERIFIED_AUDIT_ACTION = "BRANCH_CUSTODY_VERIFIED";

/** Take a custody period's row lock for the rest of the caller's transaction. */
async function lockCustodyPeriod(
  tx: Prisma.TransactionClient,
  custodyPeriodId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "CustodyPeriod" WHERE "id" = ${custodyPeriodId} FOR UPDATE
  `;
  return rows.length > 0;
}

/** Take a shift's row lock. The same idiom `lockShift` uses in the close. */
async function lockShiftRow(
  tx: Prisma.TransactionClient,
  shiftId: string
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Shift" WHERE "id" = ${shiftId} FOR UPDATE
  `;
  return rows.length > 0;
}

/**
 * The branch's single OPEN shift waiting on an opening verification.
 *
 * Exactly one, or a refusal. A branch with two gated shifts is an ambiguity
 * rather than a choice to make silently: releasing the wrong one would record
 * the wrong custodian for everything the other shift then sells. "The first
 * row" is not an answer to that question, it is a way of not asking it.
 */
async function resolveOpeningShift(
  tx: Prisma.TransactionClient,
  args: { branchId: string; shiftId: string }
): Promise<{ id: string; cafeId: string; cashierId: string }> {
  const gated = await tx.shift.findMany({
    where: {
      branchId: args.branchId,
      status: "OPEN",
      custodyGateReason: "AWAITING_OPENING_VERIFICATION",
    },
    select: { id: true, cafeId: true, cashierId: true },
    orderBy: { shiftNumber: "asc" },
  });
  if (gated.length === 0) throw new ApiError(409, SHIFT_NOT_GATED);
  if (gated.length > 1) throw new ApiError(409, AMBIGUOUS_OPENING_SHIFT);
  // Named AND resolved, both. The caller says which shift they mean, and the
  // branch says which one is actually waiting; a mismatch is refused rather
  // than resolved in either direction.
  if (gated[0].id !== args.shiftId) throw new ApiError(409, SHIFT_NOT_GATED);
  return gated[0];
}

/** The opening shift's CASH custody, which this verification never rewrites. */
async function assertOpeningCashCustody(
  tx: Prisma.TransactionClient,
  shiftId: string
): Promise<string | null> {
  const link = await tx.shiftCustody.findFirst({
    where: { shiftId, scope: "CASH" },
    select: { custodyPeriodId: true },
  });
  if (!link) return null;
  const period = await tx.custodyPeriod.findUnique({
    where: { id: link.custodyPeriodId },
    select: { id: true, scope: true, status: true, holderType: true },
  });
  if (!period || period.scope !== "CASH" || period.status !== "OPEN") {
    throw new ApiError(409, OPENING_CASH_MISSING);
  }
  return period.id;
}

export type StartOpeningVerificationResult = {
  countSessionId: string;
  type: StockCountType;
  scopeItemIds: string[];
  branchCustodyPeriodId: string;
  shiftId: string;
  /** True when a retry found the count already open and created nothing. */
  reused: boolean;
};

/**
 * Open the FULL count that discharges a branch-custody opening gate, or
 * return the one that is already open.
 *
 * Idempotent by structure rather than by idempotency key: the branch custody
 * period carries the pointer — a session whose `openingBranchCustodyPeriodId`
 * names it — so a retry's answer is "here is the count you started", not a
 * second count. The branch's partial unique index on active sessions is the
 * backstop.
 *
 * LOCK ORDER: branch STOCK custody, then shift. The same order
 * `verifyOpeningAgainstBoundary` takes, so a start and a verify racing each
 * other queue rather than deadlock.
 */
export async function startOpeningVerificationCount(args: {
  cafeId: string;
  branchId: string;
  shiftId: string;
  actorId: string;
}): Promise<StartOpeningVerificationResult> {
  const outcome = await db.$transaction(async (tx) => {
    const branch = await tx.branch.findUnique({
      where: { id: args.branchId },
      select: { id: true, cafeId: true },
    });
    if (!branch) throw new ApiError(404, "الفرع مش موجود");
    if (branch.cafeId !== args.cafeId) {
      throw new ApiError(400, "الفرع مش تابع للكافيه");
    }

    // ── 1. the branch custody, locked ──
    const branchCustody = await tx.custodyPeriod.findFirst({
      where: {
        branchId: args.branchId,
        scope: "STOCK",
        status: "OPEN",
        holderType: "BRANCH",
      },
      select: { id: true, cafeId: true },
    });
    if (!branchCustody || branchCustody.cafeId !== args.cafeId) {
      throw new ApiError(409, NO_BRANCH_CUSTODY);
    }
    if (!(await lockCustodyPeriod(tx, branchCustody.id))) {
      throw new ApiError(409, NO_BRANCH_CUSTODY);
    }

    // ── 2. the shift, locked ──
    const shift = await resolveOpeningShift(tx, {
      branchId: args.branchId,
      shiftId: args.shiftId,
    });
    if (shift.cafeId !== args.cafeId) throw new ApiError(409, SHIFT_NOT_GATED);
    if (!(await lockShiftRow(tx, shift.id))) throw new ApiError(409, SHIFT_NOT_GATED);

    // The drawer the shift already holds. Read and asserted, never rewritten:
    // a stock verification has no business moving money.
    await assertOpeningCashCustody(tx, shift.id);

    // ── 3. a retry, under both locks ──
    //
    // The branch period is the pointer. A session naming it is this
    // verification's count however many times the request arrives.
    const existing = await tx.stockCountSession.findFirst({
      where: {
        branchId: args.branchId,
        openingBranchCustodyPeriodId: branchCustody.id,
        accountabilityContext: "BRANCH_OPENING_VERIFICATION",
        status: { in: [...ACTIVE_COUNT_STATUSES] },
      },
      select: { id: true, type: true, lines: { select: { inventoryItemId: true } } },
    });
    if (existing) {
      return {
        countSessionId: existing.id,
        type: existing.type,
        scopeItemIds: existing.lines.map((l) => l.inventoryItemId),
        branchCustodyPeriodId: branchCustody.id,
        shiftId: shift.id,
        reused: true,
        started: null,
      };
    }

    // Somebody else's count holds the branch. Legibility, not enforcement —
    // the partial unique index is the guarantee.
    const live = await tx.stockCountSession.findFirst({
      where: { branchId: args.branchId, status: { in: [...ACTIVE_COUNT_STATUSES] } },
      select: { id: true },
    });
    if (live) throw new ApiError(409, ANOTHER_COUNT_RUNNING);

    // ── 4. scope ──
    //
    // FULL, through the authoritative resolver, which takes no item list —
    // that is the guarantee rather than an implementation detail. The
    // handover's CRITICAL/FULL policy is deliberately not consulted: it
    // answers a different question, about what a leaving custodian must
    // count.
    const scope = await resolveCountScopeInTransaction(tx, {
      cafeId: args.cafeId,
      branchId: args.branchId,
      type: OPENING_VERIFICATION_TYPE,
    });
    if (scope.inventoryItemIds.length === 0) {
      throw new ApiError(400, "مفيش أصناف مخزون في الفرع ينفع تتعد");
    }
    const items = await tx.inventoryItem.findMany({
      where: { id: { in: scope.inventoryItemIds } },
      select: { id: true, unit: true },
      orderBy: { name: "asc" },
    });

    const created = await tx.stockCountSession.create({
      data: {
        cafeId: args.cafeId,
        branchId: args.branchId,
        shiftId: shift.id,
        // Both point at the branch period: the count is taken UNDER the
        // custody being discharged, and it is that custody's opening
        // verification. Two columns because they answer different questions
        // and a later count under a different custody will make them differ.
        custodyPeriodId: branchCustody.id,
        openingBranchCustodyPeriodId: branchCustody.id,
        type: OPENING_VERIFICATION_TYPE,
        status: "DRAFT",
        scopeDerivation: scope.derivation,
        initiatedById: args.actorId,
        accountabilityContext: "BRANCH_OPENING_VERIFICATION",
        // No handover. The branch was holding the stock; nobody handed it
        // over, and naming the handover that put it there would claim this
        // count answers to a session that finished long ago.
        handoverId: null,
        // `mode` omitted so the schema default BLIND applies, exactly as
        // `startHandoverCount` leaves it.
        lines: {
          create: items.map((item) => ({
            inventoryItemId: item.id,
            unit: item.unit,
            disposition: "PENDING" as const,
          })),
        },
      },
      select: { id: true },
    });

    return {
      countSessionId: created.id,
      type: OPENING_VERIFICATION_TYPE,
      scopeItemIds: items.map((i) => i.id),
      branchCustodyPeriodId: branchCustody.id,
      shiftId: shift.id,
      reused: false,
      started: { scopeDerivation: scope.derivation },
    };
  });

  // Fire-and-forget, exactly as `startCountSession` and `startHandoverCount`
  // audit their own starts: the session row is its own evidence. A reuse
  // writes nothing and says nothing.
  if (outcome.started) {
    await audit({
      cafeId: args.cafeId,
      userId: args.actorId,
      action: COUNT_STARTED_AUDIT_ACTION,
      entity: "StockCountSession",
      entityId: outcome.countSessionId,
      details: {
        branchId: args.branchId,
        accountabilityContext: "BRANCH_OPENING_VERIFICATION",
        openingBranchCustodyPeriodId: outcome.branchCustodyPeriodId,
        shiftId: outcome.shiftId,
        type: outcome.type,
        scopeDerivation: outcome.started.scopeDerivation,
        lineCount: outcome.scopeItemIds.length,
        inventoryItemIds: outcome.scopeItemIds,
      },
    });
  }

  return {
    countSessionId: outcome.countSessionId,
    type: outcome.type,
    scopeItemIds: outcome.scopeItemIds,
    branchCustodyPeriodId: outcome.branchCustodyPeriodId,
    shiftId: outcome.shiftId,
    reused: outcome.reused,
  };
}

// ───────────────── the verification, and what it may blame ─────────────────

/**
 * A failure seam for Half B's rollback matrix, and nothing else.
 *
 * The same narrow shape SH-20's acceptance uses: optional, absent from the
 * result, unreachable from the route (`.strict()` body), and able only to
 * throw. A production caller that never passes it gets a function with no
 * seam at all.
 */
export type OpeningVerificationCheckpoint = (
  step: number,
  tx: Prisma.TransactionClient
) => Promise<void>;

export type OpeningVerificationResult = {
  status: "VERIFIED";
  /** The BRANCH period that was discharged. */
  branchCustodyPeriodId: string;
  /** The USER period the opening shift now holds. */
  incomingStockCustodyId: string;
  shiftId: string;
  countSessionId: string;
  countStatus: "LOCKED";
  /** The drawer, asserted and unchanged. Never rewritten by this act. */
  cashCustodyPeriodId: string | null;
  rebase: RebaseResult | null;
  varianceCaseIds: string[];
  spanIds: string[];
  verifiedAt: Date;
  alreadyVerified: boolean;
};

const ACCEPTED_OPENING_LINE_SELECT = {
  ...EFFECTIVE_EVIDENCE_SELECT,
  inventoryItemId: true,
  confidence: true,
  costImpact: true,
  costImpactAvailable: true,
  costUnavailableReason: true,
} satisfies Prisma.StockCountLineSelect;

/**
 * The boundary that OPENED this branch custody, and the custody it belongs to.
 *
 * ── WHY THIS DOES NOT USE `resolveVarianceAttribution` ──
 *
 * That resolver maps a boundary to `handover.outgoingStockCustodyId` — the
 * custody being DISCHARGED. For a span that ends at the same handover's own
 * closing boundary that is the right answer. For a span that STARTS at a
 * boundary and runs forward, it is the wrong one: what held the stock after
 * that boundary is the handover's SUCCESSOR, and the successor is the branch
 * period this verification is discharging now.
 *
 * Half B therefore reads the successor directly. The resolver's own mapping
 * is a separate, pre-existing defect
 * (`SH17_ATTRIBUTION_SUCCESSOR_MAPPING_DEFECT`), tracked and deliberately not
 * repaired here: it fails conservatively, toward `PERIOD_UNRESOLVED`, so it
 * names nobody falsely, and repairing it is a change to accepted handover
 * accountability that belongs in its own stage with its own proofs.
 */
async function openingBoundaryFor(
  tx: Prisma.TransactionClient,
  args: {
    branchId: string;
    inventoryItemId: string;
    branchCustodyPeriodId: string;
  }
): Promise<{ boundaryId: string; verified: boolean; acceptedAt: Date } | null> {
  const row = await tx.handoverStockBoundary.findFirst({
    where: {
      inventoryItemId: args.inventoryItemId,
      handover: {
        branchId: args.branchId,
        status: "COMPLETED",
        // THE handover that put the stock into this very custody. Not "the
        // latest completed one": a boundary from some other handover would
        // describe a shelf this custody never received.
        incomingStockCustodyId: args.branchCustodyPeriodId,
      },
    },
    select: {
      id: true,
      verified: true,
      handover: { select: { acceptedAt: true } },
    },
    orderBy: { handover: { acceptedAt: "desc" } },
  });
  if (!row || !row.handover.acceptedAt) return null;
  return {
    boundaryId: row.id,
    verified: row.verified,
    acceptedAt: row.handover.acceptedAt,
  };
}

/**
 * Every STOCK custody of this branch whose life overlaps the unresolved
 * interval.
 *
 * A joinable row per period rather than a JSON array, for the reason the span
 * table exists: the responsible-custody summary has to be a bounded aggregate
 * query. With no verified starting point the interval has no lower bound,
 * which is the honest reading of "we have never seen this shelf".
 */
async function crossedStockCustodies(
  tx: Prisma.TransactionClient,
  args: { branchId: string; from: Date | null; to: Date }
): Promise<string[]> {
  const periods = await tx.custodyPeriod.findMany({
    where: {
      branchId: args.branchId,
      scope: "STOCK",
      startedAt: { lte: args.to },
      ...(args.from ? { OR: [{ endedAt: null }, { endedAt: { gte: args.from } }] } : {}),
    },
    select: { id: true },
    orderBy: { startedAt: "asc" },
  });
  return periods.map((p) => p.id);
}

/**
 * Verify what the branch was holding, and hand it to the opening shift.
 *
 * ── OPTION B: THE VARIANCE IS THE EVIDENCE'S OWN ──
 *
 * `quantityVariance` is the accepted line's EFFECTIVE variance — counted
 * against what was expected at the count point — and never "counted against
 * the old boundary". Between the boundary and the count the branch may have
 * legitimately received stock: a delivery booked in, a transfer, a correction
 * somebody recorded. Every one of those moved the expected figure, and
 * measuring against the boundary instead would report the whole recorded
 * movement as a difference nobody could explain.
 *
 *   boundary 100, recorded receipt +10, expected 110, counted 110  → 0, no case
 *   boundary 100, recorded receipt +10, expected 110, counted 108  → -2
 *
 * Never +10 and never +8. The boundary is still attribution CONTEXT — it is
 * what says whether anybody has verified this shelf since the branch took it
 * — but it is not the arithmetic.
 *
 * ── AND NO EMPLOYEE IS NAMED ──
 *
 * A difference found here arose while the BRANCH held the stock, which is a
 * period with no participants by construction. `BRANCH_CUSTODY` says exactly
 * that. Where the chain of evidence is broken — the opening boundary was
 * carried rather than counted, or there is none — the verdict is
 * `PERIOD_UNRESOLVED` with a NULL custody and a span recording the periods it
 * crossed. Neither ever writes `assignedResponsibilityUserId`, and the
 * arriving custodian is never on the hook for a gap that predates them.
 */
export async function verifyOpeningAgainstBoundary(args: {
  cafeId: string;
  branchId: string;
  shiftId: string;
  countSessionId: string;
  /** The authenticated verifier. From `session.id`; never from a body. */
  verifierId: string;
  /** Test-only failure seam. See {@link OpeningVerificationCheckpoint}. */
  __afterStep?: OpeningVerificationCheckpoint;
}): Promise<OpeningVerificationResult> {
  return db.$transaction(async (tx) => {
    const checkpoint = async (step: number) => {
      if (args.__afterStep) await args.__afterStep(step, tx);
    };

    // ── The session names its own branch custody ──
    //
    // Structural, and the whole of the replay key. There is no client
    // idempotency key on this path and there must not be: a caller-supplied
    // key would let a second verification of a DIFFERENT session claim to be
    // a retry of the first.
    const session = await tx.stockCountSession.findUnique({
      where: { id: args.countSessionId },
      select: {
        id: true, cafeId: true, branchId: true, shiftId: true, status: true,
        accountabilityContext: true, handoverId: true,
        openingBranchCustodyPeriodId: true, lockedByHandoverId: true,
      },
    });
    if (!session) throw new ApiError(404, "جلسة الجرد غير موجودة");
    if (session.cafeId !== args.cafeId) throw new ApiError(404, "جلسة الجرد غير موجودة");
    if (session.branchId !== args.branchId) throw new ApiError(409, OPENING_COUNT_NOT_OURS);
    if (
      session.accountabilityContext !== "BRANCH_OPENING_VERIFICATION"
      || session.openingBranchCustodyPeriodId === null
      || session.handoverId !== null
    ) {
      throw new ApiError(409, OPENING_COUNT_NOT_OURS);
    }
    const branchCustodyPeriodId = session.openingBranchCustodyPeriodId;

    // ── 1. the branch predecessor, locked ──
    if (!(await lockCustodyPeriod(tx, branchCustodyPeriodId))) {
      throw new ApiError(409, NO_BRANCH_CUSTODY);
    }
    const predecessor = await tx.custodyPeriod.findUniqueOrThrow({
      where: { id: branchCustodyPeriodId },
      select: {
        id: true, cafeId: true, branchId: true, scope: true,
        status: true, holderType: true,
      },
    });
    if (
      predecessor.cafeId !== args.cafeId
      || predecessor.branchId !== args.branchId
      || predecessor.scope !== "STOCK"
      || predecessor.holderType !== "BRANCH"
    ) {
      throw new ApiError(409, NO_BRANCH_CUSTODY);
    }

    // ── The replay, under the lock ──
    //
    // A transferred predecessor means this verification already committed.
    // Everything below is read back from persisted rows — the successor, the
    // locked session, the cases, the spans, the gate — and NOTHING is
    // written. A session that is not the one that was accepted is a different
    // claim about the same custody, and it is refused rather than answered.
    if (predecessor.status !== "OPEN") {
      return buildOpeningReplayResult(tx, {
        branchId: args.branchId,
        branchCustodyPeriodId,
        requestedSessionId: session.id,
      });
    }

    // ── 2. the shift, locked ──
    const shift = await resolveOpeningShift(tx, {
      branchId: args.branchId,
      shiftId: args.shiftId,
    });
    if (shift.cafeId !== args.cafeId) throw new ApiError(409, SHIFT_NOT_GATED);
    if (!(await lockShiftRow(tx, shift.id))) throw new ApiError(409, SHIFT_NOT_GATED);
    // The gate is re-read under the lock rather than trusted from the query
    // that found it: a close or a release landing in between would make the
    // earlier answer a statement about a shift that has moved on.
    const gated = await tx.shift.findUniqueOrThrow({
      where: { id: shift.id },
      select: { id: true, status: true, custodyGateReason: true },
    });
    if (gated.status !== "OPEN" || gated.custodyGateReason !== "AWAITING_OPENING_VERIFICATION") {
      throw new ApiError(409, SHIFT_NOT_GATED);
    }
    if (session.shiftId !== null && session.shiftId !== shift.id) {
      throw new ApiError(409, OPENING_COUNT_NOT_OURS);
    }

    // ── 3 & 4. the evidence, and the drawer that must not move ──
    if (session.status !== "CONFIRMED") {
      throw new ApiError(409, OPENING_COUNT_NOT_CONFIRMED);
    }
    const cashCustodyPeriodId = await assertOpeningCashCustody(tx, shift.id);

    const lines = await tx.stockCountLine.findMany({
      where: { sessionId: session.id },
      select: ACCEPTED_OPENING_LINE_SELECT,
      orderBy: { id: "asc" },
    });
    // STRICT. Under `BRANCH_OPENING_VERIFICATION` there is no relaxation to
    // reach for: submit refuses an uncounted line and confirm refuses a
    // PENDING one, so a gap here would mean the evidence arrived by some
    // route that bypassed both. Refused rather than carried, because carrying
    // it would make the arriving custodian answerable for a shelf nobody has
    // looked at since the branch took it.
    if (lines.some((line) => !hasAuthoritativeObservation(line))) {
      throw new ApiError(409, OPENING_COUNT_HAS_GAPS);
    }

    // One instant for the whole act: the spans close at it, the custody
    // changes hands at it, and the gate opens at it. Three timestamps
    // milliseconds apart would invite a reader to look for an order among
    // them that does not exist.
    const verifiedAt = new Date();

    // ── 5. Option B: classify, and open a case for every real difference ──
    const caseIds: string[] = [];
    const spanIds: string[] = [];

    for (const line of lines) {
      const evidence = effectiveCountEvidence(line);
      // The evidence's OWN variance. Recorded legitimate movement already
      // moved `expectedQuantity`, so it is not a difference anybody has to
      // answer for. See the Option B note above.
      const quantityVariance = evidence.varianceQuantity;
      if (quantityVariance === 0) continue;

      const opening = await openingBoundaryFor(tx, {
        branchId: args.branchId,
        inventoryItemId: line.inventoryItemId,
        branchCustodyPeriodId,
      });

      // Every boundary the item crossed since that observation. Under branch
      // custody there should be none — a second handover would have had to
      // move the stock first — and asking is what makes that a fact rather
      // than an assumption.
      const since = opening
        ? { gt: opening.acceptedAt, lt: verifiedAt }
        : { lt: verifiedAt };
      const crossedBoundaries = await tx.handoverStockBoundary.findMany({
        where: {
          inventoryItemId: line.inventoryItemId,
          handover: {
            branchId: args.branchId,
            status: "COMPLETED",
            acceptedAt: since,
          },
        },
        select: { verified: true },
      });

      const verdict = classifyStockVariance({
        branchId: args.branchId,
        inventoryItemId: line.inventoryItemId,
        closingBoundaryVerified: true,
        closingCustodyPeriodId: branchCustodyPeriodId,
        closingCustodyHolderType: "BRANCH",
        openingBoundary: opening
          ? {
              boundaryId: opening.boundaryId,
              verified: opening.verified,
              acceptedAt: opening.acceptedAt,
              // The SUCCESSOR of that boundary's handover — the branch period
              // that has held the stock ever since. See `openingBoundaryFor`.
              custodyPeriodId: branchCustodyPeriodId,
            }
          : null,
        interveningUnverifiedBoundaryCount: crossedBoundaries.filter((b) => !b.verified).length,
        crossedCustodyPeriodIds: await crossedStockCustodies(tx, {
          branchId: args.branchId,
          from: opening?.acceptedAt ?? null,
          to: verifiedAt,
        }),
      });

      const impact = line.costImpactAvailable
        ? ({ available: true, value: Number(line.costImpact) } as const)
        : ({
            available: false,
            reason:
              (line.costUnavailableReason as
                | "MISSING_COST"
                | "UNTRUSTED_COST"
                | "CONFIDENCE_NOT_VERIFIED") ?? "MISSING_COST",
          } as const);

      const { caseId } = await openVarianceCase(tx, {
        cafeId: args.cafeId,
        branchId: args.branchId,
        type: "STOCK",
        // No shift, ever. The gap arose while the BRANCH held the stock, and
        // the opening shift is the one arriving — naming it would make the
        // arriving custodian answerable for what they walked into.
        shiftId: null,
        custodyPeriodId: verdict.custodyPeriodId,
        source: { kind: "STOCK_LINE", stockCountLineId: line.id },
        quantityVariance,
        amountVariance: impact.available ? impact.value : null,
        financialImpact: impact,
        confidence: line.confidence,
        attribution: verdict.attribution,
        // No handover accepted this. The branch was already holding the
        // stock, and the handover that put it there closed long ago.
        acceptedHandoverId: null,
        openedById: args.verifierId,
      });
      caseIds.push(caseId);

      if (verdict.attribution === "PERIOD_UNRESOLVED") {
        const { spanId } = await persistVarianceSpan(tx, {
          varianceCaseId: caseId,
          inventoryItemId: line.inventoryItemId,
          // The new arm. There is no closing boundary here and none is
          // invented; the accepted opening line IS what found the gap.
          closingEvidence: { kind: "STOCK_COUNT_LINE", stockCountLineId: line.id },
          // The ACCEPTANCE instant, not `countedAt`. A span closes when its
          // evidence was accepted, and a count that was confirmed at noon and
          // verified at two closed at two.
          toVerifiedAt: verifiedAt,
          verdict,
        });
        spanIds.push(spanId);
      }
    }
    await checkpoint(5);

    // ── 6. Rebase, so the shelf matches what was counted ──
    //
    // No freeze token: the branch is not mid-handover, so there is no freeze
    // to pass through. If one existed the rebase would refuse, which is the
    // correct answer — a shelf held for somebody else's handover is not this
    // verification's to move.
    const rebase = await rebaseFromCountInTransaction(tx, {
      sessionId: session.id,
      actorId: args.verifierId,
      idempotencyKey: `${branchCustodyPeriodId}:opening-rebase`,
    });
    await checkpoint(6);

    // ── 7. The accepted evidence becomes immutable ──
    //
    // `handoverId: null`, truthfully: no handover locked this count. See
    // `lockCountSession` for why borrowing one would be worse than a null.
    await lockCountSession(tx, {
      sessionId: session.id,
      handoverId: null,
      actorId: args.verifierId,
    });
    await checkpoint(7);

    // ── 8. STOCK custody moves from the BRANCH to the arriving custodian ──
    //
    // The predecessor records who accepted it — the verifier, who is the
    // person who looked at the shelf. The successor records which shift
    // answers for it, without which every later sale is unattributable and
    // SERVE refuses outright.
    //
    // `shiftId` is passed as null and the link written explicitly below.
    // Identical committed state — both writes are in this transaction — and
    // it gives the rollback matrix a seam between "the successor exists" and
    // "the shift is attached to it", which is otherwise unreachable.
    const transfer = await transferCustody(tx, {
      outgoingPeriodId: predecessor.id,
      scope: "STOCK",
      incoming: {
        participants: [{ userId: shift.cashierId, role: "PRIMARY" }],
        shiftId: null,
        responsibleShiftId: shift.id,
        holderType: "USER",
        openedById: args.verifierId,
      },
      actorId: args.verifierId,
      acceptedById: args.verifierId,
      acceptedAt: verifiedAt,
    });
    await checkpoint(8);

    await linkShiftCustody(tx, {
      shiftId: shift.id,
      custodyPeriodId: transfer.incomingPeriodId,
      scope: "STOCK",
    });
    await checkpoint(9);

    // ── 9. The gate opens, in the SAME commit as the transfer ──
    //
    // There is no instant in which the arriving cashier holds custody but
    // cannot sell, or can sell but holds nothing.
    await tx.shift.update({
      where: { id: shift.id },
      data: { custodyGateReason: null, custodyReadyAt: verifiedAt },
    });
    await checkpoint(10);

    // ── 10. One audit row, carrying the whole shape ──
    //
    // `auditInTransaction`, never the fire-and-forget `audit`: a verification
    // recorded when the verification rolled back would be a false statement
    // about who took the shelf.
    await auditInTransaction(tx, {
      cafeId: args.cafeId,
      userId: args.verifierId,
      action: BRANCH_CUSTODY_VERIFIED_AUDIT_ACTION,
      entity: "CustodyPeriod",
      entityId: predecessor.id,
      details: {
        branchId: args.branchId,
        branchCustodyPeriodId: predecessor.id,
        incomingStockCustodyId: transfer.incomingPeriodId,
        shiftId: shift.id,
        countSessionId: session.id,
        // Asserted and unchanged. Recorded so the row states that the drawer
        // did not move here, rather than leaving a reader to infer it.
        cashCustodyPeriodId,
        varianceCaseIds: caseIds,
        spanIds,
        rebase: {
          itemsRebased: rebase.itemsRebased,
          itemsSkipped: rebase.itemsSkipped,
          alreadyRebased: rebase.alreadyRebased,
        },
        lineCount: lines.length,
        verifiedAt: verifiedAt.toISOString(),
      },
    });
    await checkpoint(11);

    return {
      status: "VERIFIED" as const,
      branchCustodyPeriodId: predecessor.id,
      incomingStockCustodyId: transfer.incomingPeriodId,
      shiftId: shift.id,
      countSessionId: session.id,
      countStatus: "LOCKED" as const,
      cashCustodyPeriodId,
      rebase,
      varianceCaseIds: caseIds,
      spanIds,
      verifiedAt,
      alreadyVerified: false,
    };
  });
}

/**
 * The answer to a caller whose verification committed and whose response was
 * lost — assembled from persisted rows, writing nothing.
 *
 * STRUCTURAL, with no idempotency key anywhere. What identifies "the
 * verification that happened" is the shape of the record it left: the
 * transferred branch predecessor, the USER successor that took over from it,
 * the LOCKED session naming that predecessor as its opening custody, and the
 * cases and spans hanging from that session's lines. A persisted key would
 * add a second, weaker answer to the same question — one a caller could
 * supply, and therefore one a DIFFERENT session could claim.
 */
async function buildOpeningReplayResult(
  tx: Prisma.TransactionClient,
  args: {
    branchId: string;
    branchCustodyPeriodId: string;
    requestedSessionId: string;
  }
): Promise<OpeningVerificationResult> {
  const accepted = await tx.stockCountSession.findFirst({
    where: {
      branchId: args.branchId,
      openingBranchCustodyPeriodId: args.branchCustodyPeriodId,
      accountabilityContext: "BRANCH_OPENING_VERIFICATION",
      status: "LOCKED",
    },
    select: { id: true, shiftId: true, lines: { select: { id: true } } },
  });
  if (!accepted) throw new ApiError(409, NO_BRANCH_CUSTODY);
  // A different session, after the custody has already moved. Not a retry —
  // a second claim about one custody — and answering it with the first one's
  // result would tell the caller their count was accepted when it was not.
  if (accepted.id !== args.requestedSessionId) {
    throw new ApiError(409, OPENING_ALREADY_VERIFIED_ELSEWHERE);
  }

  const successor = await tx.custodyPeriod.findFirst({
    where: { previousPeriodId: args.branchCustodyPeriodId, scope: "STOCK" },
    select: { id: true, responsibleShiftId: true, acceptedAt: true },
  });
  if (!successor) throw new ApiError(409, NO_BRANCH_CUSTODY);

  const predecessor = await tx.custodyPeriod.findUniqueOrThrow({
    where: { id: args.branchCustodyPeriodId },
    select: { acceptedAt: true },
  });

  const cases = await tx.varianceCase.findMany({
    where: { stockCountLineId: { in: accepted.lines.map((l) => l.id) } },
    select: { id: true, varianceSpan: { select: { id: true } } },
    orderBy: { id: "asc" },
  });

  const shiftId = successor.responsibleShiftId ?? accepted.shiftId;
  const cashLink = shiftId
    ? await tx.shiftCustody.findFirst({
        where: { shiftId, scope: "CASH" },
        select: { custodyPeriodId: true },
      })
    : null;

  return {
    status: "VERIFIED",
    branchCustodyPeriodId: args.branchCustodyPeriodId,
    incomingStockCustodyId: successor.id,
    shiftId: shiftId ?? "",
    countSessionId: accepted.id,
    countStatus: "LOCKED",
    cashCustodyPeriodId: cashLink?.custodyPeriodId ?? null,
    // NULL on purpose: this call rebased nothing, and restating an earlier
    // call's `RebaseResult` would describe work that did not happen here.
    rebase: null,
    varianceCaseIds: cases.map((c) => c.id),
    spanIds: cases.flatMap((c) => (c.varianceSpan ? [c.varianceSpan.id] : [])),
    verifiedAt: predecessor.acceptedAt ?? successor.acceptedAt ?? new Date(),
    alreadyVerified: true,
  };
}
