// HANDOVER-007 — SH-19: the arriving hand signs for what it receives, and
// disagreeing sends the count back rather than rewriting it.
//
// SH-18 left the handover at `OUTGOING_SUBMITTED` with a confirmed, bound
// count the incoming custodian could see the shape of and none of the
// figures. SH-19 is what the incoming custodian may then DO: acknowledge each
// line, optionally with a spot count of their own, and — when the two
// accounts do not agree — ask for the whole thing to be counted again.
//
// Four facts this suite exists to pin, because each has a plausible wrong
// implementation:
//
//   1. `varianceQuantity: null` and `varianceQuantity: 0` are different
//      claims. NULL is "I signed for it without counting"; 0 is "I counted it
//      and we agree". An implementation that coalesced the first to zero
//      would manufacture evidence the reviewer never gave.
//
//   2. `handedOverQuantity` is `effectiveCountedQuantity + ledgerDeltaAbove(
//      itemVersion)` — what is actually on the shelf now, not what was
//      written down some time earlier. It is asserted against a REAL
//      `rebaseFromCount` on a clone rather than against a restatement of the
//      same arithmetic.
//
//   3. `requestRecount` writes to `HandoverSession` and nothing else. The
//      superseded count stays `CONFIRMED` and byte-identical, custody does
//      not move, the freeze is retained, and no `VarianceCase` is created or
//      retracted — the R1 defect, pinned before and after.
//
//   4. The `REJECTED → DRAFT` restart replaces only the current-count
//      pointer. The first count remains readable history, and the rejection
//      fields are RETAINED, because they are the record of why a second count
//      exists.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

const MARKER = tag("HANDOVER007");

type HandoverLib = typeof import("@/lib/handover");
const handoverLib = (): Promise<HandoverLib> => import("@/lib/handover");
type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");

/** Both handover grants, so the close itself is never the thing refusing. */
const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

let fx: CountCafe;
/** A second tenant. Nothing in it may ever be reachable from the first. */
let other: CountCafe;

const ITEM_KEYS = ["alpha", "bravo", "charlie"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];
const items: Record<ItemKey, { id: string; name: string }> = {} as never;

/**
 * The arriving custodian: `handover.accept` and deliberately NOT
 * `handover.submit`.
 *
 * Every system role that can accept can also submit, so the distinction is
 * made the way the application itself makes it — a per-user override on top
 * of a role — rather than by inventing a role for the test. It is what proves
 * both SH-19 routes are guarded by the accept key and not the submit key.
 */
let incoming: { id: string; email: string };
/** The same grant, pinned to the cafe's OTHER branch. */
let annexIncoming: { id: string; email: string };
/** A live handover belonging to the second tenant. */
let otherHandoverId: string;

/** The reason vocabulary the whole suite draws on. */
let handoverReasonId: string;
let inactiveHandoverReasonId: string;
let stockReasonId: string;
let foreignHandoverReasonId: string;

// ───────────────────────────── the SH-18 reality ─────────────────────────

async function configureBranch() {
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: {
      stockCountPolicy: "HYBRID",
      handoverCountType: "CRITICAL",
      periodicFullCountSchedule: "MANUAL_ONLY",
      periodicFullCountWeekday: null,
      varianceBlocksHandover: false,
      varianceHardBlockAmount: null,
    },
  });
  await db.branch.update({
    where: { id: fx.branchId },
    data: {
      stockCountPolicyOverride: null,
      handoverCountTypeOverride: null,
      periodicFullCountScheduleOverride: null,
      periodicFullCountWeekdayOverride: null,
    },
  });
}

async function restoreItems() {
  for (const key of ITEM_KEYS) {
    await db.inventoryItem.update({
      where: { id: items[key].id },
      data: {
        unit: "KG",
        isCritical: true,
        isActive: true,
        archivedAt: null,
        currentStock: "10",
      },
    });
  }
}

/**
 * Empty the branch of everything a previous case created.
 *
 * Order is dictated by the schema's deliberate `Restrict` keys: evidence must
 * outlive the thing it describes, so acknowledgements and boundaries go
 * before lines, count sessions before the handovers that cite them, and
 * handovers before the custody periods naming who was answerable.
 */
async function resetBranch(branchId: string) {
  await db.handoverStockAcknowledgement.deleteMany({ where: { handover: { branchId } } });
  await db.handoverStockBoundary.deleteMany({ where: { handover: { branchId } } });
  await db.handoverRequiredItem.updateMany({
    where: { handover: { branchId } },
    data: { satisfiedByLineId: null },
  });
  await db.handoverSession.updateMany({
    where: { branchId },
    data: { stockCountSessionId: null, acceptedStockCountSessionId: null },
  });
  await db.shift.updateMany({ where: { branchId }, data: { cashVarianceCaseId: null } });
  await db.varianceCase.deleteMany({ where: { branchId } });
  await db.stockCountSession.updateMany({
    where: { branchId },
    data: { lockedByHandoverId: null, handoverId: null, accountabilityContext: "NONE" },
  });
  await db.stockCountRebase.deleteMany({ where: { session: { branchId } } });
  await db.stockCountSession.deleteMany({ where: { branchId } });
  await db.inventoryFreeze.deleteMany({ where: { branchId } });
  await db.openingException.deleteMany({ where: { branchId } });
  await db.handoverSession.deleteMany({ where: { branchId } });
  await db.tenderReconciliation.deleteMany({ where: { branchId } });
  await db.payment.deleteMany({ where: { branchId } });
  await db.inventoryTransaction.deleteMany({ where: { branchId } });
  await db.order.deleteMany({ where: { branchId } });
  await db.shiftCustody.deleteMany({ where: { shift: { branchId } } });
  await db.custodyParticipant.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
  await db.shift.deleteMany({ where: { branchId } });
}

async function openOperationalShift(
  cafeId: string,
  branchId: string,
  userId: string,
  openingCash = 100,
) {
  const last = await db.shift.aggregate({
    where: { branchId },
    _max: { shiftNumber: true },
  });
  const shift = await db.shift.create({
    data: {
      cafeId,
      branchId,
      cashierId: userId,
      shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: openingCash,
      expectedCashAmount: openingCash,
    },
  });
  const { ensureCustodyForShift } = await custodyLib();
  await db.$transaction((tx) =>
    ensureCustodyForShift(tx, {
      cafeId,
      branchId,
      shiftId: shift.id,
      userId,
      openingCashAmount: openingCash,
    }),
  );
  return shift;
}

type Handover = {
  handoverId: string;
  shiftId: string;
  freezeId: string;
  requiredItemIds: string[];
  outgoingStockCustodyId: string | null;
  outgoingCashCustodyId: string | null;
};

/**
 * A branch in exactly the state SH-16 leaves it: shift AWAITING_HANDOVER with
 * `financiallyClosedAt` set and `stockClosedAt` still null, an open freeze
 * naming the handover, and a DRAFT handover carrying its snapshot.
 */
async function freshHandover(
  cafe: CountCafe = fx,
  branchId: string = fx.branchId,
): Promise<Handover> {
  await resetBranch(branchId);
  const shift = await openOperationalShift(cafe.cafeId, branchId, cafe.cashier.id);
  const { closeShiftWithSettlement } = await cashCloseLib();
  const closed = await closeShiftWithSettlement({
    shiftId: shift.id,
    actualCash: 100,
    actorId: cafe.cashier.id,
    closedByManager: false,
    handoverTarget: "SHIFT_TO_SHIFT",
    grants: GRANTS_FULL,
  });
  if (!closed.handoverId || !closed.freezeId) {
    throw new Error(
      `close produced no handover (status ${closed.status}, issue ${JSON.stringify(closed.handoverConfigIssue)})`,
    );
  }
  const handover = await db.handoverSession.findUniqueOrThrow({
    where: { id: closed.handoverId },
    select: {
      outgoingStockCustodyId: true,
      outgoingCashCustodyId: true,
      requiredItems: {
        select: { inventoryItemId: true },
        orderBy: { itemNameSnapshot: "asc" },
      },
    },
  });
  return {
    handoverId: closed.handoverId,
    shiftId: shift.id,
    freezeId: closed.freezeId,
    requiredItemIds: handover.requiredItems.map((r) => r.inventoryItemId),
    outgoingStockCustodyId: handover.outgoingStockCustodyId,
    outgoingCashCustodyId: handover.outgoingCashCustodyId,
  };
}

before(async () => {
  await requireServer();
  fx = await countCafe("HANDOVER007");
  other = await countCafe("HANDOVER007X");

  for (const key of ITEM_KEYS) {
    const created = await countItem(fx, key, { stock: 10, isCritical: true });
    items[key] = { id: created.id, name: created.name };
  }
  // The annex needs a critical item of its own, or its SELECTED-mode config
  // has no scope and no shift there could ever close into a handover.
  await countItem(fx, "annex", { stock: 8, isCritical: true, branchId: fx.otherBranchId });

  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  incoming = await db.user.create({
    data: {
      email: `${fx.marker.toLowerCase()}-incoming@example.invalid`,
      name: `${fx.marker}-incoming`,
      passwordHash: hash,
      role: "CASHIER",
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      permissionOverrides: {
        create: [{ permissionKey: "handover.submit", allowed: false }],
      },
    },
    select: { id: true, email: true },
  });
  await login(incoming.email, COUNT_PASSWORD);

  annexIncoming = await db.user.create({
    data: {
      email: `${fx.marker.toLowerCase()}-annex@example.invalid`,
      name: `${fx.marker}-annex`,
      passwordHash: hash,
      role: "CASHIER",
      cafeId: fx.cafeId,
      branchId: fx.otherBranchId,
    },
    select: { id: true, email: true },
  });
  await login(annexIncoming.email, COUNT_PASSWORD);

  // The reason vocabulary. Two HANDOVER reasons of this café's — one active,
  // one stopped — a STOCK reason of this café's, and an active HANDOVER
  // reason belonging to the OTHER café, which must be indistinguishable from
  // an id that matches nothing at all.
  const handoverReason = await db.reasonCode.create({
    data: {
      cafeId: fx.cafeId,
      domain: "HANDOVER",
      code: `${MARKER}-HO`,
      label: "خلاف على الجرد",
    },
  });
  handoverReasonId = handoverReason.id;
  const inactive = await db.reasonCode.create({
    data: {
      cafeId: fx.cafeId,
      domain: "HANDOVER",
      code: `${MARKER}-HO-OFF`,
      label: "سبب تسليم متوقف",
      isActive: false,
    },
  });
  inactiveHandoverReasonId = inactive.id;
  const stock = await db.reasonCode.create({
    data: { cafeId: fx.cafeId, domain: "STOCK", code: `${MARKER}-ST`, label: "هالك" },
  });
  stockReasonId = stock.id;
  const foreign = await db.reasonCode.create({
    data: {
      cafeId: other.cafeId,
      domain: "HANDOVER",
      code: `${MARKER}-FOREIGN`,
      label: "سبب كافيه تاني",
    },
  });
  foreignHandoverReasonId = foreign.id;

  // The foreign tenant needs a live handover of its own, so a cross-café
  // refusal is about tenancy rather than about an id that matches nothing.
  await countItem(other, "foreign", { stock: 4, isCritical: true });
  await db.cafeSettings.update({
    where: { cafeId: other.cafeId },
    data: {
      stockCountPolicy: "HYBRID",
      handoverCountType: "CRITICAL",
      periodicFullCountSchedule: "MANUAL_ONLY",
      periodicFullCountWeekday: null,
    },
  });
  const foreignHandover = await freshHandover(other, other.branchId);
  otherHandoverId = foreignHandover.handoverId;
});

beforeEach(async () => {
  await configureBranch();
  await restoreItems();
});

after(async () => {
  // The branch resets run FIRST, as teardown steps.
  //
  // `purgeCafe` deletes every table carrying a `cafeId` column, and
  // `CustodyParticipant` carries none — it hangs off `CustodyPeriod` and
  // `User`. A café left holding a live handover therefore cannot have its
  // custody periods removed, and `User` then fails on
  // `CustodyParticipant_userId_fkey`. Emptying the branches the way every
  // case already empties them leaves the purge nothing it cannot reach.
  await teardownTaggedCafe(
    [fx?.cafeId, other?.cafeId],
    [
      () => resetBranch(fx.branchId),
      () => resetBranch(fx.otherBranchId),
      () => resetBranch(other.branchId),
      () => resetBranch(other.otherBranchId),
    ],
    { disconnect: true },
  );
});

// ──────────────────────── T1 · HANDOVER reason validation ────────────────
//
// The narrowest deliverable in the stage, and the one both SH-19 writes rest
// on. `assertStockReason` (src/lib/stock-count.ts) is the shape being
// followed — one message for "no such reason", "another café's reason" and
// "wrong domain", so an id cannot be probed across tenants, and a DIFFERENT
// message for "stopped", which is the only one the caller can act on.
//
// It takes a client rather than reaching for `db`, because both production
// callers run inside the handover row lock and a validation read outside that
// transaction could pass against a reason another request is deactivating.

const SUBJECT = "سبب إعادة الجرد";
const MISSING = `لازم تحدد ${SUBJECT}`;
const NOT_OURS = `${SUBJECT} مش من أسباب التسليم بتاعة الكافيه`;
const STOPPED = `${SUBJECT} ده متوقف`;

const messageIs = (message: string) => (error: unknown) =>
  (error as { status?: number }).status === 400 &&
  (error as { message?: string }).message === message;

async function assertReason(reasonCodeId: string | null | undefined, cafeId = fx.cafeId) {
  const { assertHandoverReason } = await handoverLib();
  return assertHandoverReason(db, reasonCodeId, cafeId, SUBJECT);
}

describe("HANDOVER reason validation", () => {
  test("1.1 the empty string, null and undefined all take the missing arm", async () => {
    // The empty string matters on its own: a body carrying `""` that slipped
    // past a truthiness check would reach `findUnique` on an empty id and be
    // refused for the wrong reason, or match nothing and be reported as
    // another café's.
    for (const value of ["", null, undefined] as const) {
      await assert.rejects(
        assertReason(value),
        messageIs(MISSING),
        `${JSON.stringify(value)} must be refused as missing`,
      );
    }
  });

  test("1.2 an id that matches no ReasonCode is refused", async () => {
    await assert.rejects(assertReason("no-such-reason-id"), messageIs(NOT_OURS));
  });

  test("1.3 the other café's active HANDOVER reason is indistinguishable", async () => {
    await assert.rejects(assertReason(foreignHandoverReasonId), messageIs(NOT_OURS));
  });

  test("1.4 this café's STOCK-domain reason is refused with the same message", async () => {
    await assert.rejects(assertReason(stockReasonId), messageIs(NOT_OURS));
  });

  test("1.5 a stopped HANDOVER reason is refused with a message the caller can act on", async () => {
    await assert.rejects(assertReason(inactiveHandoverReasonId), messageIs(STOPPED));
    // And the two refusals are genuinely different, which is the whole point.
    assert.notEqual(STOPPED, NOT_OURS);
  });

  test("1.6 this café's active HANDOVER reason resolves and writes nothing", async () => {
    const before = await db.reasonCode.findUniqueOrThrow({ where: { id: handoverReasonId } });
    const result = await assertReason(handoverReasonId);
    assert.equal(result, undefined, "the gate answers by not throwing, not by a value");
    assert.deepEqual(
      await db.reasonCode.findUniqueOrThrow({ where: { id: handoverReasonId } }),
      before,
      "validating a reason must not touch it",
    );
  });
});

// ──────────────────── T2 · the incoming acknowledgement ──────────────────
//
// The arriving custodian signs for one line at a time. Three shapes, and they
// are not interchangeable:
//
//   no spot count      → ACCEPTED, incomingCountedQuantity NULL, variance NULL
//   spot count, equal  → ACCEPTED, variance 0
//   spot count, differs→ DISPUTED, and only with a HANDOVER reason
//
// NULL is not zero. "I signed for it without counting" and "I counted it and
// we agree" are different claims about what the reviewer actually did, and an
// implementation that coalesced the first into the second would manufacture
// evidence nobody gave.
//
// What is signed for is `handedOverQuantity` — the effective counted figure
// plus every ledger movement above that figure's own cursor. The count was
// taken at a moment; the shelf is being handed over now.

const statusIs = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;

const refusalIs = (status: number, message: string) => (error: unknown) =>
  (error as { status?: number }).status === status &&
  (error as { message?: string }).message === message;

const NOT_IN_REVIEW = "التسليم مش في مرحلة مراجعة";
const NO_BOUND_COUNT = "مفيش جرد مربوط بالتسليم ده";
const LINE_NOT_FOUND = "سطر الجرد غير موجود";
const OLD_SESSION = "السطر ده من جرد قديم — الجرد الحالي هو اللي بيتراجع";
const UNCOUNTED = "السطر ده لسه ماتعدش — مش ينفع تستلمه";
const ALREADY_ACKNOWLEDGED = "السطر ده متسجل استلامه قبل كده";
const HANDOVER_NOT_FOUND = "التسليم مش موجود";
const FOREIGN_BRANCH = "ليس لديك صلاحية على فرع تاني";

/**
 * Write a line's figures directly. Capture is `count-010`'s subject.
 *
 * `itemVersion` is the item's REAL `ledgerVersion` at fill time rather than a
 * constant, because the whole point of `handedOverQuantity` is that movements
 * ABOVE that cursor are replayed — and a cursor that did not come from the
 * ledger could not be moved past.
 */
async function fillLine(
  sessionId: string,
  inventoryItemId: string,
  spec: {
    counted?: number | null;
    expected?: number;
    reasonCodeId?: string | null;
    costImpact?: number | null;
    costImpactAvailable?: boolean;
  },
) {
  const line = await db.stockCountLine.findFirstOrThrow({
    where: { sessionId, inventoryItemId },
    select: { id: true },
  });
  const item = await db.inventoryItem.findUniqueOrThrow({
    where: { id: inventoryItemId },
    select: { ledgerVersion: true },
  });
  const counted = spec.counted === undefined ? null : spec.counted;
  const expected = spec.expected ?? 0;
  await db.stockCountLine.update({
    where: { id: line.id },
    data: {
      expectedQuantity: expected,
      countedQuantity: counted,
      effectiveCountedQuantity: counted,
      varianceQuantity: counted === null ? null : counted - expected,
      countedAt: counted === null ? null : new Date(),
      counterId: counted === null ? null : fx.cashier.id,
      itemVersion: counted === null ? null : item.ledgerVersion,
      expectedBasis: counted === null ? null : "LOCKED_ITEM_VERSION",
      disposition: counted === null ? "PENDING" : "WITHIN_TOLERANCE",
      reasonCodeId: spec.reasonCodeId ?? null,
      costImpact: spec.costImpact ?? null,
      costImpactAvailable: spec.costImpactAvailable ?? false,
    },
  });
  return line.id;
}

type FillSpec = Parameters<typeof fillLine>[2] & { itemId: string };

async function startCount(
  handoverId: string,
  overrides: Partial<{ actorId: string; cafeId: string; viewerBranchId: string | null }> = {},
) {
  const { startHandoverCount } = await handoverLib();
  return startHandoverCount({
    handoverId,
    actorId: overrides.actorId ?? fx.cashier.id,
    cafeId: overrides.cafeId ?? fx.cafeId,
    viewerBranchId:
      overrides.viewerBranchId === undefined ? fx.branchId : overrides.viewerBranchId,
  });
}

async function submit(
  handoverId: string,
  overrides: Partial<{ outgoingUserId: string; cafeId: string; viewerBranchId: string | null }> = {},
) {
  const { submitHandover } = await handoverLib();
  return submitHandover({
    handoverId,
    outgoingUserId: overrides.outgoingUserId ?? fx.cashier.id,
    cafeId: overrides.cafeId ?? fx.cafeId,
    viewerBranchId:
      overrides.viewerBranchId === undefined ? fx.branchId : overrides.viewerBranchId,
  });
}

/** A bound count in a stated status, with the given lines written. */
async function boundCount(
  h: Handover,
  specs: FillSpec[],
  status: "DRAFT" | "SUBMITTED" | "CONFIRMED" = "CONFIRMED",
  cafe: CountCafe = fx,
) {
  const started = await startCount(h.handoverId, {
    actorId: cafe.cashier.id,
    cafeId: cafe.cafeId,
    viewerBranchId: null,
  });
  for (const spec of specs) {
    await fillLine(started.countSessionId, spec.itemId, spec);
  }
  if (status !== "DRAFT") {
    await db.stockCountSession.update({
      where: { id: started.countSessionId },
      data: {
        status,
        submittedAt: new Date(),
        ...(status === "CONFIRMED"
          ? { confirmedAt: new Date(), confirmedById: cafe.cashier.id }
          : {}),
      },
    });
  }
  return started.countSessionId;
}

/**
 * Every required item counted exactly.
 *
 * A function rather than a constant: `items` is populated in `before()`, and
 * a module-level array would capture `undefined` ids at load time.
 */
const exactSpecs = (): FillSpec[] =>
  ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 10, expected: 10 }));

/** A handover that has actually been submitted, with its confirmed evidence. */
async function submittedHandover(
  specs?: FillSpec[],
): Promise<Handover & { sessionId: string }> {
  const h = await freshHandover();
  const sessionId = await boundCount(
    h,
    specs ?? exactSpecs(),
  );
  await submit(h.handoverId);
  return { ...h, sessionId };
}

const lineOf = (sessionId: string, inventoryItemId: string) =>
  db.stockCountLine.findFirstOrThrow({
    where: { sessionId, inventoryItemId },
    select: { id: true },
  });

/** The service call under test, with the arriving custodian as the actor. */
async function acknowledge(args: {
  handoverId: string;
  stockCountLineId: string;
  incomingCountedQuantity?: number | null;
  disputeReasonCodeId?: string;
  disputeNote?: string;
  acknowledgedById?: string;
  cafeId?: string;
  viewerBranchId?: string | null;
}) {
  const { acknowledgeStockLine } = await handoverLib();
  return acknowledgeStockLine({
    handoverId: args.handoverId,
    stockCountLineId: args.stockCountLineId,
    acknowledgedById: args.acknowledgedById ?? incoming.id,
    incomingCountedQuantity: args.incomingCountedQuantity,
    disputeReasonCodeId: args.disputeReasonCodeId,
    disputeNote: args.disputeNote,
    cafeId: args.cafeId ?? fx.cafeId,
    viewerBranchId: args.viewerBranchId === undefined ? fx.branchId : args.viewerBranchId,
  });
}

const ackRow = (handoverId: string, stockCountLineId: string) =>
  db.handoverStockAcknowledgement.findUnique({
    where: { handoverId_stockCountLineId: { handoverId, stockCountLineId } },
  });

const ackCount = (handoverId: string) =>
  db.handoverStockAcknowledgement.count({ where: { handoverId } });

/**
 * A row as a comparable string.
 *
 * Decimals through their own `toJSON`, so `12.500` and `12.5` are different
 * strings and a silently re-scaled column cannot pass; BigInt tagged, because
 * `JSON.stringify` throws on it rather than losing it quietly.
 */
const asText = (row: unknown) =>
  JSON.stringify(row, (_key, value) =>
    typeof value === "bigint" ? `bigint:${value.toString()}` : value,
  );

const lineText = async (lineId: string) =>
  asText(await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } }));

describe("acknowledgeStockLine", () => {
  test("2.1 no spot count records ACCEPTED with a NULL variance, not zero", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    const result = await acknowledge({ handoverId: h.handoverId, stockCountLineId: line.id });
    assert.equal(result.decision, "ACCEPTED");
    assert.strictEqual(result.varianceQuantity, null);
    assert.equal(result.handedOverQuantity, 10);

    const row = await ackRow(h.handoverId, line.id);
    assert.ok(row, "the acknowledgement must be persisted, not merely returned");
    assert.equal(row.decision, "ACCEPTED");
    assert.strictEqual(row.varianceQuantity, null, "NULL is not zero");
    assert.strictEqual(row.incomingCountedQuantity, null);
    assert.equal(Number(row.handedOverQuantity), 10);
    assert.equal(row.acknowledgedById, incoming.id);
    assert.ok(row.acknowledgedAt instanceof Date);
  });

  test("2.2 a matching spot count records ACCEPTED with variance 0", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    const result = await acknowledge({
      handoverId: h.handoverId,
      stockCountLineId: line.id,
      incomingCountedQuantity: 10,
    });
    assert.equal(result.decision, "ACCEPTED");
    assert.equal(result.varianceQuantity, 0);

    const row = await ackRow(h.handoverId, line.id);
    assert.ok(row);
    assert.notStrictEqual(row.varianceQuantity, null, "counting and agreeing is not not-counting");
    assert.equal(Number(row.varianceQuantity), 0);
    assert.equal(Number(row.incomingCountedQuantity), 10);
  });

  test("2.3 a differing spot count with no reason is refused, and rolls back", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    await assert.rejects(
      acknowledge({
        handoverId: h.handoverId,
        stockCountLineId: line.id,
        incomingCountedQuantity: 7,
      }),
      refusalIs(400, "لازم تحدد سبب الاختلاف"),
    );

    // The rollback is asserted, not assumed: the acknowledgement row and the
    // transition are written in the same transaction as the reason check.
    assert.equal(await ackCount(h.handoverId), 0);
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, reviewedAt: true },
    });
    assert.equal(handover.status, "OUTGOING_SUBMITTED");
    assert.equal(handover.reviewedAt, null);
  });

  test("2.4 a differing spot count with a valid reason records DISPUTED", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    const result = await acknowledge({
      handoverId: h.handoverId,
      stockCountLineId: line.id,
      incomingCountedQuantity: 7,
      disputeReasonCodeId: handoverReasonId,
      disputeNote: "لقيت ٧ بس",
    });
    assert.equal(result.decision, "DISPUTED");
    // A lower spot count is a NEGATIVE variance. The sign is the direction of
    // the disagreement and reversing it would blame the wrong hand.
    assert.equal(result.varianceQuantity, -3);
    assert.equal(result.handedOverQuantity, 10);

    const row = await ackRow(h.handoverId, line.id);
    assert.ok(row);
    assert.equal(row.decision, "DISPUTED");
    assert.equal(Number(row.varianceQuantity), -3);
    assert.equal(row.disputeReasonCodeId, handoverReasonId);
    assert.equal(row.disputeNote, "لقيت ٧ بس");
  });

  test("2.5 a dispute leaves the counted line byte-identical", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);
    const before = await lineText(line.id);

    await acknowledge({
      handoverId: h.handoverId,
      stockCountLineId: line.id,
      incomingCountedQuantity: 2,
      disputeReasonCodeId: handoverReasonId,
    });

    assert.equal(
      await lineText(line.id),
      before,
      "the outgoing hand's figure is evidence — a dispute records disagreement with it, never a correction of it",
    );
  });

  test("2.6 handedOverQuantity replays ledger movement above the count cursor", async () => {
    const h = await submittedHandover();
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: h.sessionId, inventoryItemId: items.alpha.id },
      select: { id: true, itemVersion: true, effectiveCountedQuantity: true },
    });

    // A real movement, through the single writer, above the line's cursor.
    // The freeze token is the handover's own — the same trusted path the
    // orchestration uses; an untokened write would be refused by the freeze.
    const { applyStockMutation } = await import("@/lib/ledger");
    const moved = await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: items.alpha.id,
        type: "ADJUSTMENT",
        quantity: -2.5,
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        createdById: fx.cashier.id,
        freezeToken: h.handoverId,
        allowNegative: true,
      }),
    );
    assert.ok(
      moved.itemVersion > (line.itemVersion ?? BigInt(0)),
      "the fixture movement must land above the count cursor",
    );

    const result = await acknowledge({ handoverId: h.handoverId, stockCountLineId: line.id });
    assert.equal(result.handedOverQuantity, 7.5);
    assert.notEqual(
      result.handedOverQuantity,
      Number(line.effectiveCountedQuantity),
      "a figure that ignored the replay would hand over stock that has already left",
    );
  });

  test("2.7 handedOverQuantity equals what a real rebase produces", async () => {
    const h = await submittedHandover();
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: h.sessionId, inventoryItemId: items.alpha.id },
      select: { id: true, itemVersion: true },
    });
    const { applyStockMutation } = await import("@/lib/ledger");
    await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: items.alpha.id,
        type: "ADJUSTMENT",
        quantity: 1.25,
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        createdById: fx.cashier.id,
        freezeToken: h.handoverId,
        allowNegative: true,
      }),
    );

    const result = await acknowledge({ handoverId: h.handoverId, stockCountLineId: line.id });

    // The reference figure, from the real rebase rather than from a second
    // copy of the same arithmetic. It runs against a CLONE — session, lines
    // and recounts under new ids — because rebasing the real session is
    // SH-20's act and would consume the evidence this handover still needs.
    //
    // The freeze is released first because `rebaseFromCount` at this HEAD
    // takes no freeze token, so it cannot run against a frozen branch. That
    // is a property of the reference call, not of the acknowledgement: the
    // acknowledgement above already committed with the freeze fully in force.
    await db.inventoryFreeze.update({
      where: { id: h.freezeId },
      data: { releasedAt: new Date(), releasedById: fx.manager.id },
    });

    const source = await db.stockCountSession.findUniqueOrThrow({
      where: { id: h.sessionId },
      include: { lines: { include: { recounts: true, corrections: true } } },
    });
    // The clone is complete only if there is nothing else to clone. Recounts
    // and approved corrections would each move the effective figure, so a
    // fixture that grew one and did not copy it would compare two different
    // pieces of evidence and still pass.
    for (const l of source.lines) {
      assert.equal(l.recounts.length, 0, "clone the recounts too if the fixture grows one");
      assert.equal(l.corrections.length, 0, "clone the corrections too if the fixture grows one");
    }
    const clone = await db.stockCountSession.create({
      data: {
        cafeId: source.cafeId,
        branchId: source.branchId,
        shiftId: source.shiftId,
        type: source.type,
        status: "CONFIRMED",
        mode: source.mode,
        scopeDerivation: source.scopeDerivation,
        initiatedById: source.initiatedById,
        confirmedAt: source.confirmedAt,
        confirmedById: source.confirmedById,
        lines: {
          create: source.lines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            unit: l.unit,
            expectedQuantity: l.expectedQuantity,
            countedQuantity: l.countedQuantity,
            effectiveCountedQuantity: l.effectiveCountedQuantity,
            varianceQuantity: l.varianceQuantity,
            itemVersion: l.itemVersion,
            expectedBasis: l.expectedBasis,
            countedAt: l.countedAt,
            counterId: l.counterId,
            disposition: l.disposition,
            reasonCodeId: l.reasonCodeId,
          })),
        },
      },
      select: { id: true },
    });

    const { rebaseFromCount } = await import("@/lib/stock-rebase");
    await rebaseFromCount({
      sessionId: clone.id,
      actorId: fx.manager.id,
      idempotencyKey: `${MARKER}-clone-rebase`,
    });

    const rebased = await db.stockCountRebase.findFirstOrThrow({
      where: { sessionId: clone.id, inventoryItemId: items.alpha.id },
      select: { stockAfter: true },
    });
    assert.equal(
      Number(rebased.stockAfter),
      result.handedOverQuantity,
      "the acknowledged figure and the rebase must be the same arithmetic, proved rather than asserted in a comment",
    );
  });

  test("2.8 a line from another handover's session is refused", async () => {
    const mine = await submittedHandover();
    // A genuinely separate handover, in the café's other branch, so building
    // it cannot disturb the one under test.
    const annexItem = await db.inventoryItem.findFirstOrThrow({
      where: { branchId: fx.otherBranchId, isCritical: true },
      select: { id: true },
    });
    const annex = await freshHandover(fx, fx.otherBranchId);
    const annexSession = await boundCount(annex, [
      { itemId: annexItem.id, counted: 8, expected: 8 },
    ]);
    const foreignLine = await lineOf(annexSession, annexItem.id);

    await assert.rejects(
      acknowledge({
        handoverId: mine.handoverId,
        stockCountLineId: foreignLine.id,
        viewerBranchId: null,
      }),
      refusalIs(409, OLD_SESSION),
    );
    assert.equal(await ackCount(mine.handoverId), 0);
  });

  test("2.9 a line from a superseded session of this handover is refused", async () => {
    const h = await submittedHandover();
    const stale = await lineOf(h.sessionId, items.alpha.id);

    // The superseded state, built directly: `requestRecount` does not exist
    // until T4, and case 7.6 re-asserts this through the real recount path.
    const replacement = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        shiftId: h.shiftId,
        type: "CRITICAL",
        status: "CONFIRMED",
        scopeDerivation: "CRITICAL_ONLY",
        initiatedById: fx.cashier.id,
        accountabilityContext: "HANDOVER",
        handoverId: h.handoverId,
      },
      select: { id: true },
    });
    await db.handoverSession.update({
      where: { id: h.handoverId },
      data: { stockCountSessionId: replacement.id },
    });

    await assert.rejects(
      acknowledge({ handoverId: h.handoverId, stockCountLineId: stale.id }),
      refusalIs(409, OLD_SESSION),
    );
    assert.equal(await ackCount(h.handoverId), 0);
  });

  test("2.10 an uncounted line is refused with a controlled business error", async () => {
    // The handover has to SUBMIT before anything can be acknowledged, and
    // `submitHandover` refuses a required item with no figure — so the
    // uncounted line is produced after the submit, by a direct write. It is
    // the state the guard exists for: a line the current session names, whose
    // `countedQuantity` is null with no recount and no approved correction.
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.charlie.id);
    await db.stockCountLine.update({
      where: { id: line.id },
      data: {
        countedQuantity: null,
        effectiveCountedQuantity: null,
        varianceQuantity: null,
        countedAt: null,
        counterId: null,
        itemVersion: null,
        expectedBasis: null,
        disposition: "PENDING",
      },
    });

    let thrown: unknown;
    try {
      await acknowledge({ handoverId: h.handoverId, stockCountLineId: line.id });
      assert.fail("acknowledging an uncounted line must be refused");
    } catch (error) {
      thrown = error;
    }
    assert.equal((thrown as { status?: number }).status, 409);
    assert.equal((thrown as { message?: string }).message, UNCOUNTED);
    assert.equal(
      (thrown as { constructor: { name: string } }).constructor.name,
      "ApiError",
      "a null figure must not reach the database and come back as a constraint violation",
    );
    assert.ok(!(thrown instanceof TypeError));
    assert.equal(await ackCount(h.handoverId), 0);
  });

  test("2.11 the first acknowledgement opens the review", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    const before = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, reviewedAt: true },
    });
    assert.equal(before.status, "OUTGOING_SUBMITTED");
    assert.equal(before.reviewedAt, null);

    await acknowledge({ handoverId: h.handoverId, stockCountLineId: line.id });

    const after_ = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, reviewedAt: true, incomingUserId: true },
    });
    assert.equal(after_.status, "INCOMING_REVIEW");
    assert.ok(after_.reviewedAt instanceof Date);
    // The acknowledgement actor is recorded on the acknowledgement. The
    // handover-level incoming party is set when custody actually moves, which
    // is SH-20's.
    assert.equal(after_.incomingUserId, null);
  });

  test("2.12 a later acknowledgement does not re-stamp the review", async () => {
    const h = await submittedHandover();
    const first = await lineOf(h.sessionId, items.alpha.id);
    const second = await lineOf(h.sessionId, items.bravo.id);

    await acknowledge({ handoverId: h.handoverId, stockCountLineId: first.id });
    const stamped = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { reviewedAt: true },
    });

    await acknowledge({ handoverId: h.handoverId, stockCountLineId: second.id });
    const after_ = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, reviewedAt: true },
    });
    assert.equal(after_.status, "INCOMING_REVIEW");
    assert.deepEqual(
      after_.reviewedAt,
      stamped.reviewedAt,
      "the moment the review opened is a fact about the first look, not the latest one",
    );
    assert.equal(await ackCount(h.handoverId), 2);
  });

  test("2.13 the same line cannot be acknowledged twice", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    await acknowledge({
      handoverId: h.handoverId,
      stockCountLineId: line.id,
      incomingCountedQuantity: 10,
    });

    await assert.rejects(
      acknowledge({
        handoverId: h.handoverId,
        stockCountLineId: line.id,
        incomingCountedQuantity: 4,
        disputeReasonCodeId: handoverReasonId,
      }),
      refusalIs(409, ALREADY_ACKNOWLEDGED),
    );

    assert.equal(await ackCount(h.handoverId), 1);
    const row = await ackRow(h.handoverId, line.id);
    assert.ok(row);
    assert.equal(
      Number(row.incomingCountedQuantity),
      10,
      "a signature stands; the second call must not overwrite the first figure",
    );
    assert.equal(row.decision, "ACCEPTED");
  });

  test("2.14 a handover that is not in review refuses", async () => {
    const h = await freshHandover();
    const sessionId = await boundCount(h, exactSpecs());
    const line = await lineOf(sessionId, items.alpha.id);

    await assert.rejects(
      acknowledge({ handoverId: h.handoverId, stockCountLineId: line.id }),
      refusalIs(409, NOT_IN_REVIEW),
    );
    assert.equal(await ackCount(h.handoverId), 0);
  });

  test("2.15 tenancy and branch scope are enforced", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    // Another tenant's view of our id is not confirmed to exist at all.
    await assert.rejects(
      acknowledge({
        handoverId: h.handoverId,
        stockCountLineId: line.id,
        cafeId: other.cafeId,
        viewerBranchId: null,
      }),
      refusalIs(404, HANDOVER_NOT_FOUND),
    );
    // The café is the viewer's; the branch is not.
    await assert.rejects(
      acknowledge({
        handoverId: h.handoverId,
        stockCountLineId: line.id,
        viewerBranchId: fx.otherBranchId,
      }),
      refusalIs(403, FOREIGN_BRANCH),
    );
    assert.equal(await ackCount(h.handoverId), 0);
  });
});

// ────────────────── T3 · the acknowledge route, and blindness ────────────
//
// The service is unreachable without a door, and a door SH-24's UI cannot
// open is not production reachability. `handover.accept` guards it — the act
// belongs to the ARRIVING custodian, which is exactly what that key names.
//
// `.strict()` is the other half. A body carrying `handedOverQuantity`,
// `varianceQuantity`, `decision` or `acknowledgedById` is refused BY NAME
// rather than quietly dropped: obeying would let the person being measured
// write their own result, and ignoring would let them believe they had.
// `acknowledgedById` is never read from the body — it is the session's own id.
//
// And the blindness regression, from SH-19's own suite: before the first
// acknowledgement the whole-handover view names no quantity column at all;
// after it, EVERY line is disclosed, including the ones nobody acknowledged.
// The boundary is whole-handover and always was — SH-19 causes it rather than
// redesigning it.

const QUANTITY_KEYS = [
  "expectedQuantity",
  "varianceQuantity",
  "costImpact",
  "costImpactAvailable",
  "costUnavailableReason",
  "countedQuantity",
  "effectiveCountedQuantity",
  "itemVersion",
  "expectedBasis",
] as const;

/**
 * Walk anything — the live object or a parsed HTTP body — and refuse a
 * quantity key wherever it hides.
 */
function assertNoQuantityKeys(value: unknown, path = "view") {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertNoQuantityKeys(entry, `${path}[${i}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assert.ok(
      !(QUANTITY_KEYS as readonly string[]).includes(key),
      `${path}.${key} leaks a count target to a reviewer who has not looked yet`,
    );
    assertNoQuantityKeys(child, `${path}.${key}`);
  }
}

type AckBody = {
  handedOverQuantity?: number;
  varianceQuantity?: number | null;
  decision?: string;
  error?: string;
};

const ackPost = (email: string, handoverId: string, body: unknown) =>
  as<AckBody>(email, `/api/handovers/${handoverId}/acknowledge`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const handoverGet = (email: string, handoverId: string) =>
  as<{ handover: { acknowledged: boolean; count: { lines: Array<Record<string, unknown>> } } }>(
    email,
    `/api/handovers/${handoverId}`,
  );

describe("acknowledge route", () => {
  test("3.1 POST returns the verdict and nothing else", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    const r = await ackPost(incoming.email, h.handoverId, { stockCountLineId: line.id });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(
      Object.keys(r.body).sort(),
      ["decision", "handedOverQuantity", "varianceQuantity"],
      "an extra key in the response is a leak, not a convenience",
    );
    assert.equal(r.body.decision, "ACCEPTED");
    assert.equal(r.body.handedOverQuantity, 10);
    assert.strictEqual(r.body.varianceQuantity, null);
    assert.equal(await ackCount(h.handoverId), 1);
  });

  test("3.2 the schema refuses a body that writes its own result", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    for (const [field, value] of [
      ["handedOverQuantity", 999],
      ["varianceQuantity", 0],
      ["decision", "ACCEPTED"],
      ["acknowledgedById", fx.cashier.id],
    ] as const) {
      const r = await ackPost(incoming.email, h.handoverId, {
        stockCountLineId: line.id,
        [field]: value,
      });
      assert.equal(r.status, 400, `${field} -> ${r.text}`);
      assert.ok(
        (r.body.error ?? "").includes(field),
        `the refusal must name the unrecognised key, got: ${r.body.error}`,
      );
    }
    assert.equal(
      await ackCount(h.handoverId),
      0,
      "a refused body must not have signed for anything",
    );
  });

  test("3.3 a same-café account without handover.accept is refused", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    const r = await ackPost(fx.waiter.email, h.handoverId, { stockCountLineId: line.id });
    assert.equal(r.status, 403, r.text);
    assert.equal(await ackCount(h.handoverId), 0);
  });

  test("3.4 another café's handover id is not confirmed to exist", async () => {
    const r = await ackPost(incoming.email, otherHandoverId, {
      stockCountLineId: "whatever-line-id",
    });
    assert.equal(r.status, 404, r.text);
  });

  test("3.5 a caller pinned to another branch is refused", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    const r = await ackPost(annexIncoming.email, h.handoverId, { stockCountLineId: line.id });
    assert.equal(r.status, 403, r.text);
    assert.equal(await ackCount(h.handoverId), 0);
  });

  test("3.6 a differing spot count with no reason reaches HTTP as 400", async () => {
    const h = await submittedHandover();
    const line = await lineOf(h.sessionId, items.alpha.id);

    const r = await ackPost(incoming.email, h.handoverId, {
      stockCountLineId: line.id,
      incomingCountedQuantity: 3,
    });
    assert.equal(r.status, 400, r.text);
    assert.equal(
      r.body.error,
      "لازم تحدد سبب الاختلاف",
      "the service's own wording must survive the route",
    );
    assert.equal(await ackCount(h.handoverId), 0);
  });

  test("3.7 the state refusals reach HTTP as 409, not 400 and not 500", async () => {
    // Uncounted, produced after the submit for the reason case 2.10 records.
    const uncounted = await submittedHandover();
    const charlie = await lineOf(uncounted.sessionId, items.charlie.id);
    await db.stockCountLine.update({
      where: { id: charlie.id },
      data: {
        countedQuantity: null,
        effectiveCountedQuantity: null,
        varianceQuantity: null,
        countedAt: null,
        counterId: null,
        itemVersion: null,
        expectedBasis: null,
        disposition: "PENDING",
      },
    });
    const uncountedResponse = await ackPost(incoming.email, uncounted.handoverId, {
      stockCountLineId: charlie.id,
    });
    assert.equal(uncountedResponse.status, 409, uncountedResponse.text);
    assert.equal(uncountedResponse.body.error, UNCOUNTED);

    // Superseded: the pointer has moved on.
    const stale = await lineOf(uncounted.sessionId, items.alpha.id);
    const replacement = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        shiftId: uncounted.shiftId,
        type: "CRITICAL",
        status: "CONFIRMED",
        scopeDerivation: "CRITICAL_ONLY",
        initiatedById: fx.cashier.id,
        accountabilityContext: "HANDOVER",
        handoverId: uncounted.handoverId,
      },
      select: { id: true },
    });
    await db.handoverSession.update({
      where: { id: uncounted.handoverId },
      data: { stockCountSessionId: replacement.id },
    });
    const staleResponse = await ackPost(incoming.email, uncounted.handoverId, {
      stockCountLineId: stale.id,
    });
    assert.equal(staleResponse.status, 409, staleResponse.text);
    assert.equal(staleResponse.body.error, OLD_SESSION);
  });
});

describe("blindness boundary", () => {
  test("3.8 before any acknowledgement, no quantity key exists in the view", async () => {
    const h = await submittedHandover([
      // A real, priced, non-zero difference — the most valuable thing to leak.
      {
        itemId: items.alpha.id,
        counted: 2,
        expected: 9,
        reasonCodeId: stockReasonId,
        costImpact: 1234,
        costImpactAvailable: true,
      },
      { itemId: items.bravo.id, counted: 4, expected: 4 },
      { itemId: items.charlie.id, counted: 7, expected: 7 },
    ]);

    const r = await handoverGet(incoming.email, h.handoverId);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.handover.acknowledged, false);
    assertNoQuantityKeys(r.body.handover, "handover");
    // And the raw text, so no serialiser can smuggle one through a key the
    // walk did not visit.
    for (const key of QUANTITY_KEYS) {
      assert.ok(!r.text.includes(key), `the serialised body names ${key}`);
    }
    assert.equal(r.body.handover.count.lines.length, 3);
  });

  test("3.9 one acknowledgement discloses the whole handover, not one line", async () => {
    const h = await submittedHandover([
      { itemId: items.alpha.id, counted: 2, expected: 9, reasonCodeId: stockReasonId },
      { itemId: items.bravo.id, counted: 4, expected: 4 },
      { itemId: items.charlie.id, counted: 7, expected: 7 },
    ]);
    const line = await lineOf(h.sessionId, items.alpha.id);

    const posted = await ackPost(incoming.email, h.handoverId, { stockCountLineId: line.id });
    assert.equal(posted.status, 200, posted.text);

    const r = await handoverGet(incoming.email, h.handoverId);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.handover.acknowledged, true);

    const lines = r.body.handover.count.lines;
    assert.equal(lines.length, 3);
    for (const l of lines) {
      assert.ok(
        "countedQuantity" in l && "expectedQuantity" in l,
        "disclosure is whole-handover: the lines nobody acknowledged are disclosed too",
      );
    }
    const alpha = lines.find((l) => l.inventoryItemId === items.alpha.id)!;
    assert.equal(Number(alpha.expectedQuantity), 9);
    assert.equal(Number(alpha.varianceQuantity), -7);
  });

  test("3.10 the acknowledge response discloses only its own verdict", async () => {
    const h = await submittedHandover([
      { itemId: items.alpha.id, counted: 2, expected: 9, reasonCodeId: stockReasonId },
      { itemId: items.bravo.id, counted: 4, expected: 4 },
      { itemId: items.charlie.id, counted: 7, expected: 7 },
    ]);
    const line = await lineOf(h.sessionId, items.alpha.id);

    const r = await ackPost(incoming.email, h.handoverId, { stockCountLineId: line.id });
    assert.equal(r.status, 200, r.text);
    // `varianceQuantity` is the acknowledgement's OWN key and legitimately
    // present, so the scan is by name against the leak list minus that one.
    for (const key of QUANTITY_KEYS) {
      if (key === "varianceQuantity") continue;
      assert.ok(!r.text.includes(key), `the acknowledgement response names ${key}`);
    }
    // No other line's figures, and no session projection.
    assert.ok(!r.text.includes(h.sessionId));
    for (const itemId of [items.bravo.id, items.charlie.id]) {
      assert.ok(!r.text.includes(itemId), "another line has nothing to do with this verdict");
    }
  });
});

void NO_BOUND_COUNT;
void LINE_NOT_FOUND;

// ─────────────────────────── T4 · the recount request ────────────────────
//
// Disagreeing sends the count back. It does not rewrite it, and it does not
// leave a case behind.
//
// `requestRecount` writes to `HandoverSession` and to nothing else. The
// superseded session stays CONFIRMED and byte-identical; custody stays where
// it is; the freeze is RETAINED, because the shelf must stay still between
// the disputed count and its replacement; and no `VarianceCase` is created or
// retracted — the R1 defect, pinned before and after.
//
// The pointer is deliberately NOT moved. It still names the superseded
// session until the replacement is created, which is what keeps the prior
// evidence readable and what makes a stale acknowledgement refusable.

const NOT_RECOUNTABLE = "التسليم مش في حالة تسمح بطلب إعادة الجرد";
const RECOUNT_SUBJECT_MISSING = "لازم تحدد سبب إعادة الجرد";

async function requestRecount(args: {
  handoverId: string;
  reasonCodeId?: string;
  note?: string;
  incomingUserId?: string;
  cafeId?: string;
  viewerBranchId?: string | null;
}) {
  const { requestRecount: service } = await handoverLib();
  return service({
    handoverId: args.handoverId,
    incomingUserId: args.incomingUserId ?? incoming.id,
    reasonCodeId: args.reasonCodeId as string,
    note: args.note,
    cafeId: args.cafeId ?? fx.cafeId,
    viewerBranchId: args.viewerBranchId === undefined ? fx.branchId : args.viewerBranchId,
  });
}

/** An operational shift opened at the branch while the handover is pending. */
async function openIncomingShift(branchId: string = fx.branchId) {
  return openOperationalShift(fx.cafeId, branchId, incoming.id);
}

/** Every line of a session, as one comparable string. */
async function sessionLinesText(sessionId: string) {
  return asText(
    await db.stockCountLine.findMany({ where: { sessionId }, orderBy: { id: "asc" } }),
  );
}

/**
 * Every field SH-20 owns, still nobody's.
 *
 * Extracted rather than inlined because case 6.7 re-runs the whole set after
 * the restart: a field that stayed null through the rejection and then moved
 * during the replacement would be the same defect, one step later.
 */
async function assertNoLaterStageWrites(h: Handover, note: string) {
  const handover = await db.handoverSession.findUniqueOrThrow({
    where: { id: h.handoverId },
    select: {
      acceptedStockCountSessionId: true,
      resolvedTarget: true,
      incomingUserId: true,
      incomingStockCustodyId: true,
      incomingCashCustodyId: true,
      acceptedAt: true,
      completedAt: true,
      idempotencyKey: true,
      stockCountSessionId: true,
    },
  });
  for (const [field, value] of Object.entries(handover)) {
    if (field === "stockCountSessionId") continue;
    assert.equal(value, null, `${note}: HandoverSession.${field} belongs to SH-20`);
  }
  assert.equal(
    await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }),
    0,
    `${note}: the stock boundary is written by acceptance`,
  );
  assert.equal(
    await db.stockCountSession.count({
      where: { handoverId: h.handoverId, lockedByHandoverId: { not: null } },
    }),
    0,
    `${note}: locking the evidence is acceptance`,
  );
  assert.equal(
    await db.handoverRequiredItem.count({
      where: { handoverId: h.handoverId, satisfiedByLineId: { not: null } },
    }),
    0,
    `${note}: settling the required items is acceptance`,
  );
  assert.equal(
    await db.stockCountRebase.count({ where: { session: { handoverId: h.handoverId } } }),
    0,
    `${note}: rebasing the shelf is acceptance`,
  );
}

/** A submitted handover whose alpha line is DISPUTED and bravo ACCEPTED. */
async function reviewedHandover() {
  const h = await submittedHandover();
  const alpha = await lineOf(h.sessionId, items.alpha.id);
  const bravo = await lineOf(h.sessionId, items.bravo.id);
  await acknowledge({
    handoverId: h.handoverId,
    stockCountLineId: alpha.id,
    incomingCountedQuantity: 6,
    disputeReasonCodeId: handoverReasonId,
  });
  await acknowledge({ handoverId: h.handoverId, stockCountLineId: bravo.id });
  return { ...h, alphaLineId: alpha.id, bravoLineId: bravo.id };
}

describe("requestRecount", () => {
  test("4.1 a recount with no reason is refused and writes nothing", async () => {
    const h = await submittedHandover();

    await assert.rejects(
      requestRecount({ handoverId: h.handoverId }),
      refusalIs(400, RECOUNT_SUBJECT_MISSING),
    );
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, rejectedAt: true, rejectionReasonCodeId: true },
    });
    assert.equal(handover.status, "OUTGOING_SUBMITTED");
    assert.equal(handover.rejectedAt, null);
    assert.equal(handover.rejectionReasonCodeId, null);
  });

  test("4.2 a STOCK-domain reason is not a handover reason", async () => {
    const h = await submittedHandover();
    await assert.rejects(
      requestRecount({ handoverId: h.handoverId, reasonCodeId: stockReasonId }),
      statusIs(400),
    );
    await assertStillSubmitted(h.handoverId);
  });

  test("4.3 a stopped HANDOVER reason is refused", async () => {
    const h = await submittedHandover();
    await assert.rejects(
      requestRecount({ handoverId: h.handoverId, reasonCodeId: inactiveHandoverReasonId }),
      statusIs(400),
    );
    await assertStillSubmitted(h.handoverId);
  });

  test("4.4 another café's HANDOVER reason is refused", async () => {
    const h = await submittedHandover();
    await assert.rejects(
      requestRecount({ handoverId: h.handoverId, reasonCodeId: foreignHandoverReasonId }),
      statusIs(400),
    );
    await assertStillSubmitted(h.handoverId);
  });

  test("4.5 from OUTGOING_SUBMITTED the handover moves to REJECTED", async () => {
    const h = await submittedHandover();
    const result = await requestRecount({
      handoverId: h.handoverId,
      reasonCodeId: handoverReasonId,
    });
    assert.equal(result.status, "REJECTED");
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true },
    });
    assert.equal(handover.status, "REJECTED");
  });

  test("4.6 from INCOMING_REVIEW it moves to REJECTED too", async () => {
    const h = await reviewedHandover();
    const before = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true },
    });
    assert.equal(before.status, "INCOMING_REVIEW", "the fixture must have opened the review");

    const result = await requestRecount({
      handoverId: h.handoverId,
      reasonCodeId: handoverReasonId,
    });
    assert.equal(result.status, "REJECTED");
  });

  test("4.7 the rejection records why, and when", async () => {
    const h = await submittedHandover();
    await requestRecount({
      handoverId: h.handoverId,
      reasonCodeId: handoverReasonId,
      note: "العدد مش مظبوط",
    });

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { rejectionReasonCodeId: true, rejectionNote: true, rejectedAt: true },
    });
    assert.equal(handover.rejectionReasonCodeId, handoverReasonId);
    assert.equal(handover.rejectionNote, "العدد مش مظبوط");
    assert.ok(handover.rejectedAt instanceof Date);
  });

  test("4.8 disputedLineIds names the current session's disputes and no others", async () => {
    const h = await reviewedHandover();

    // A DISPUTED acknowledgement against an EARLIER session of this same
    // handover. It is not evidence about the count being sent back.
    const earlier = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        shiftId: h.shiftId,
        type: "CRITICAL",
        status: "CONFIRMED",
        scopeDerivation: "CRITICAL_ONLY",
        initiatedById: fx.cashier.id,
        accountabilityContext: "HANDOVER",
        handoverId: h.handoverId,
        lines: {
          create: [{ inventoryItemId: items.charlie.id, unit: "KG", disposition: "PENDING" }],
        },
      },
      select: { id: true, lines: { select: { id: true } } },
    });
    const earlierLineId = earlier.lines[0].id;
    await db.handoverStockAcknowledgement.create({
      data: {
        handoverId: h.handoverId,
        stockCountLineId: earlierLineId,
        handedOverQuantity: 1,
        varianceQuantity: -1,
        decision: "DISPUTED",
        disputeReasonCodeId: handoverReasonId,
        acknowledgedById: incoming.id,
      },
    });

    const result = await requestRecount({
      handoverId: h.handoverId,
      reasonCodeId: handoverReasonId,
    });

    assert.deepEqual(result.disputedLineIds, [h.alphaLineId]);
    assert.ok(
      !result.disputedLineIds.includes(h.bravoLineId),
      "an ACCEPTED acknowledgement is not a dispute",
    );
    assert.ok(
      !result.disputedLineIds.includes(earlierLineId),
      "a dispute about a superseded count is not evidence about this one",
    );
    // Ascending, so a caller may compare the array directly.
    assert.deepEqual(result.disputedLineIds, [...result.disputedLineIds].sort());
  });

  test("4.9 the pointer is reported, and not moved", async () => {
    const h = await submittedHandover();
    const pointerBefore = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { stockCountSessionId: true },
    });
    assert.equal(pointerBefore.stockCountSessionId, h.sessionId);

    const result = await requestRecount({
      handoverId: h.handoverId,
      reasonCodeId: handoverReasonId,
    });
    assert.equal(result.supersededSessionId, h.sessionId);

    const pointerAfter = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { stockCountSessionId: true },
    });
    assert.equal(
      pointerAfter.stockCountSessionId,
      h.sessionId,
      "the pointer still names the superseded session until a replacement exists",
    );
  });

  test("4.10 the superseded session and every line are byte-identical", async () => {
    const h = await reviewedHandover();
    const sessionBefore = asText(
      await db.stockCountSession.findUniqueOrThrow({ where: { id: h.sessionId } }),
    );
    const linesBefore = await sessionLinesText(h.sessionId);

    await requestRecount({ handoverId: h.handoverId, reasonCodeId: handoverReasonId });

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: h.sessionId },
    });
    assert.equal(session.status, "CONFIRMED");
    assert.equal(asText(session), sessionBefore);
    assert.equal(await sessionLinesText(h.sessionId), linesBefore);
  });

  test("4.11 the superseded session has zero variance cases, before and after", async () => {
    const h = await reviewedHandover();
    const where = { stockCountLine: { sessionId: h.sessionId } };
    assert.equal(await db.varianceCase.count({ where }), 0, "before the recount");

    await requestRecount({ handoverId: h.handoverId, reasonCodeId: handoverReasonId });

    assert.equal(
      await db.varianceCase.count({ where }),
      0,
      "a recount neither opens a case nor retracts one — there was never one to retract",
    );
  });

  test("4.12 custody has not moved", async () => {
    const h = await submittedHandover();
    assert.ok(h.outgoingStockCustodyId, "the fixture must produce a STOCK custody");
    assert.ok(h.outgoingCashCustodyId, "and a CASH custody");

    await requestRecount({ handoverId: h.handoverId, reasonCodeId: handoverReasonId });

    for (const id of [h.outgoingStockCustodyId, h.outgoingCashCustodyId] as string[]) {
      const period = await db.custodyPeriod.findUniqueOrThrow({ where: { id } });
      assert.equal(period.status, "OPEN", "the outgoing custodian still holds it");
      assert.equal(period.acceptedById, null);
      assert.equal(period.endedAt, null);
    }
  });

  test("4.13 the freeze is still held", async () => {
    const h = await submittedHandover();
    await requestRecount({ handoverId: h.handoverId, reasonCodeId: handoverReasonId });

    const { activeFreezeFor } = await import("@/lib/inventory-freeze");
    const freeze = await activeFreezeFor(db, fx.branchId);
    assert.ok(freeze, "the shelf must stay still between the disputed count and its replacement");
    assert.equal(freeze.handoverId, h.handoverId);

    const row = await db.inventoryFreeze.findUniqueOrThrow({ where: { id: h.freezeId } });
    assert.equal(row.releasedAt, null);
  });

  test("4.14 neither shift moves, and the arriving one is still gated", async () => {
    const h = await submittedHandover();
    const gated = await openIncomingShift();
    const outgoingBefore = asText(
      await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } }),
    );

    await requestRecount({ handoverId: h.handoverId, reasonCodeId: handoverReasonId });

    const outgoing = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(outgoing.status, "AWAITING_HANDOVER");
    assert.ok(outgoing.financiallyClosedAt instanceof Date);
    assert.equal(outgoing.stockClosedAt, null);
    assert.equal(outgoing.closedAt, null);
    assert.equal(asText(outgoing), outgoingBefore);

    const incomingShift = await db.shift.findUniqueOrThrow({ where: { id: gated.id } });
    assert.ok(
      incomingShift.custodyGateReason,
      "the arriving cashier cannot sell a shelf nobody has handed them",
    );
    assert.equal(incomingShift.custodyReadyAt, null);
  });

  test("4.15 no field SH-20 owns is written", async () => {
    const h = await reviewedHandover();
    await requestRecount({ handoverId: h.handoverId, reasonCodeId: handoverReasonId });
    await assertNoLaterStageWrites(h, "after the recount request");
  });

  test("4.16 a handover outside the review window refuses", async () => {
    const draft = await freshHandover();
    await boundCount(draft, exactSpecs());
    await assert.rejects(
      requestRecount({ handoverId: draft.handoverId, reasonCodeId: handoverReasonId }),
      refusalIs(409, NOT_RECOUNTABLE),
    );
    const stillDraft = await db.handoverSession.findUniqueOrThrow({
      where: { id: draft.handoverId },
      select: { status: true, rejectedAt: true },
    });
    assert.equal(stillDraft.status, "DRAFT");
    assert.equal(stillDraft.rejectedAt, null);

    const done = await submittedHandover();
    await db.handoverSession.update({
      where: { id: done.handoverId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    await assert.rejects(
      requestRecount({ handoverId: done.handoverId, reasonCodeId: handoverReasonId }),
      refusalIs(409, NOT_RECOUNTABLE),
    );
    const stillDone = await db.handoverSession.findUniqueOrThrow({
      where: { id: done.handoverId },
      select: { status: true, rejectedAt: true, rejectionReasonCodeId: true },
    });
    assert.equal(stillDone.status, "COMPLETED");
    assert.equal(stillDone.rejectedAt, null);
    assert.equal(stillDone.rejectionReasonCodeId, null);
  });

  test("4.17 tenancy and branch scope are enforced", async () => {
    const h = await submittedHandover();

    await assert.rejects(
      requestRecount({
        handoverId: h.handoverId,
        reasonCodeId: handoverReasonId,
        cafeId: other.cafeId,
        viewerBranchId: null,
      }),
      refusalIs(404, HANDOVER_NOT_FOUND),
    );
    await assert.rejects(
      requestRecount({
        handoverId: h.handoverId,
        reasonCodeId: handoverReasonId,
        viewerBranchId: fx.otherBranchId,
      }),
      refusalIs(403, FOREIGN_BRANCH),
    );
    await assertStillSubmitted(h.handoverId);
  });
});

/** The handover has not moved out of the outgoing hand's submission. */
async function assertStillSubmitted(handoverId: string) {
  const handover = await db.handoverSession.findUniqueOrThrow({
    where: { id: handoverId },
    select: { status: true, rejectedAt: true, rejectionReasonCodeId: true, rejectionNote: true },
  });
  assert.equal(handover.status, "OUTGOING_SUBMITTED");
  assert.equal(handover.rejectedAt, null);
  assert.equal(handover.rejectionReasonCodeId, null);
  assert.equal(handover.rejectionNote, null);
}

// ───────────────────── T5 · the request-recount route ────────────────────
//
// The roadmap's own **Files to create** entry for this stage. Since SH-23 the
// route is guarded by `handover.request_recount` — the act's own key, carried
// by the `handover:participate` bridge and the participating templates, so
// the accounts below hold it exactly as they held `accept`. Case 5.6 proves
// the submit key still does not open it, and 5.7 proves the guard really is
// the recount key: revoking it alone closes this route while acknowledging —
// still `accept`-guarded — keeps working.

const recountPost = (email: string, handoverId: string, body: unknown) =>
  as<{
    status?: string;
    disputedLineIds?: string[];
    supersededSessionId?: string;
    error?: string;
  }>(email, `/api/handovers/${handoverId}/request-recount`, {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("request-recount route", () => {
  test("5.1 POST with a valid reason returns the rejection", async () => {
    const h = await reviewedHandover();

    const r = await recountPost(incoming.email, h.handoverId, {
      reasonCodeId: handoverReasonId,
      note: "نعيد الجرد",
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.body).sort(), [
      "disputedLineIds",
      "status",
      "supersededSessionId",
    ]);
    assert.equal(r.body.status, "REJECTED");
    assert.deepEqual(r.body.disputedLineIds, [h.alphaLineId]);
    assert.equal(r.body.supersededSessionId, h.sessionId);

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, rejectionNote: true },
    });
    assert.equal(handover.status, "REJECTED");
    assert.equal(handover.rejectionNote, "نعيد الجرد");
  });

  test("5.2 the schema refuses a body that writes its own answer", async () => {
    const h = await submittedHandover();
    const before = asText(
      await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } }),
    );

    for (const [field, value] of [
      ["status", "REJECTED"],
      ["disputedLineIds", []],
      ["handoverId", h.handoverId],
    ] as const) {
      const r = await recountPost(incoming.email, h.handoverId, {
        reasonCodeId: handoverReasonId,
        [field]: value,
      });
      assert.equal(r.status, 400, `${field} -> ${r.text}`);
      assert.ok(
        (r.body.error ?? "").includes(field),
        `the refusal must name the unrecognised key, got: ${r.body.error}`,
      );
    }
    assert.equal(
      asText(await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } })),
      before,
      "a refused body must leave the handover exactly where it was",
    );
  });

  test("5.3 an account without handover.request_recount is refused", async () => {
    const h = await submittedHandover();
    const before = asText(
      await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } }),
    );

    const r = await recountPost(fx.waiter.email, h.handoverId, {
      reasonCodeId: handoverReasonId,
    });
    assert.equal(r.status, 403, r.text);
    assert.equal(
      asText(await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } })),
      before,
    );
  });

  test("5.4 a body with no reason is refused by the schema", async () => {
    const h = await submittedHandover();

    const r = await recountPost(incoming.email, h.handoverId, {});
    assert.equal(r.status, 400, r.text);
    assert.ok(
      (r.body.error ?? "").includes("لازم تحدد سبب إعادة الجرد"),
      `the refusal must say what is missing, got: ${r.body.error}`,
    );
    await assertStillSubmitted(h.handoverId);
  });

  test("5.5 tenancy and branch scope are enforced over HTTP", async () => {
    const h = await submittedHandover();

    const foreign = await recountPost(incoming.email, otherHandoverId, {
      reasonCodeId: handoverReasonId,
    });
    assert.equal(foreign.status, 404, foreign.text);

    const wrongBranch = await recountPost(annexIncoming.email, h.handoverId, {
      reasonCodeId: handoverReasonId,
    });
    assert.equal(wrongBranch.status, 403, wrongBranch.text);

    await assertStillSubmitted(h.handoverId);
  });

  test("5.6 the guard is the request_recount key, not the submit key", async () => {
    const h = await submittedHandover();

    // The same account, in the same request pair. It holds
    // `handover.request_recount` through the participation bridge, so it may
    // ask for a recount…
    const recount = await recountPost(incoming.email, h.handoverId, {
      reasonCodeId: handoverReasonId,
    });
    assert.equal(recount.status, 200, recount.text);

    // …and may not submit a handover, because it does not hold that key. A
    // route guarded by `handover.submit` would have refused the call above.
    const submitAttempt = await as<{ error?: string }>(incoming.email, "/api/handovers", {
      method: "POST",
      body: JSON.stringify({ action: "submit", handoverId: h.handoverId }),
    });
    assert.equal(
      submitAttempt.status,
      403,
      "the fixture account must genuinely lack handover.submit",
    );
  });

  test("5.7 revoking request_recount alone closes this route, and only this route", async () => {
    // SH-23's whole point, proven from both sides: an account that keeps
    // `handover.accept` but has `handover.request_recount` revoked may still
    // acknowledge a line — accept guards that — yet may not send the count
    // back. Before SH-23 these two acts were inseparable.
    const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
    const noRecount = await db.user.create({
      data: {
        email: `${fx.marker.toLowerCase()}-norecount@example.invalid`,
        name: `${fx.marker}-norecount`,
        passwordHash: hash,
        role: "CASHIER",
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        permissionOverrides: {
          create: [{ permissionKey: "handover.request_recount", allowed: false }],
        },
      },
      select: { id: true, email: true },
    });
    await login(noRecount.email, COUNT_PASSWORD);

    const h = await submittedHandover();

    // The recount door is shut for this account, and nothing changed.
    const refused = await recountPost(noRecount.email, h.handoverId, {
      reasonCodeId: handoverReasonId,
    });
    assert.equal(refused.status, 403, refused.text);
    await assertStillSubmitted(h.handoverId);

    // The acknowledge door is not: `handover.accept` still guards it.
    const line = await lineOf(h.sessionId, items.alpha.id);
    const ack = await ackPost(noRecount.email, h.handoverId, { stockCountLineId: line.id });
    assert.equal(ack.status, 200, ack.text);
    assert.equal(await ackCount(h.handoverId), 1);
  });
});

// ───────────────────────── T6 · the REJECTED restart ─────────────────────
//
// The outgoing hand counts again. Under the handover row lock, that call
// changes REJECTED to DRAFT, creates a fresh session bound to the SAME
// handover, and replaces only the current-count pointer.
//
// It never edits the prior session. The first count stays CONFIRMED and
// readable, which is what makes it history rather than a mistake, and because
// a handover-bound confirmation defers accountability it carries no variance
// case — so there is nothing about it to retract.
//
// The rejection fields are RETAINED across the restart. They are the record
// of why a second count exists, and the migration's CHECK constrains only the
// REJECTED direction, so keeping them in DRAFT is legal and honest.

const post = <T = Record<string, unknown>>(email: string, body: unknown) =>
  as<T>(email, "/api/handovers", { method: "POST", body: JSON.stringify(body) });

const startCountHttp = (handoverId: string, email: string = fx.cashier.email) =>
  post<{ countSession: { id: string; type: string; scopeItemIds: string[]; reused: boolean } }>(
    email,
    { action: "start_count", handoverId },
  );

const patchLine = (email: string, sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ error?: string }>(email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify({ countedQuantity }),
  });

const submitCount = (email: string, sessionId: string) =>
  as<{ error?: string }>(email, `/api/stock-counts/${sessionId}/submit`, {
    method: "POST",
    body: "{}",
  });

const acceptVariance = (email: string, sessionId: string, lineId: string, reasonCodeId: string) =>
  as<{ error?: string }>(
    email,
    `/api/stock-counts/${sessionId}/lines/${lineId}/accept-variance`,
    { method: "POST", body: JSON.stringify({ reasonCodeId }) },
  );

type ConfirmBody = {
  status?: string;
  varianceCaseIds?: string[];
  alreadyConfirmed?: boolean;
  deferred?: {
    context: string;
    handoverId: string | null;
    openingBranchCustodyPeriodId: string | null;
  } | null;
  error?: string;
};

const confirmCount = (email: string, sessionId: string, idempotencyKey: string) =>
  as<ConfirmBody>(email, `/api/stock-counts/${sessionId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey }),
  });

/**
 * Capture, submit, settle and confirm a session through the real routes.
 *
 * The order is capture, submit, accept, confirm — the one the disposition
 * state machine permits, and the one `count-012` drives. `counted` is applied
 * to alpha; the rest are counted exactly.
 */
async function walkTheCount(sessionId: string, alphaCounted: number) {
  const lines = await db.stockCountLine.findMany({
    where: { sessionId },
    select: { id: true, inventoryItemId: true },
  });
  for (const line of lines) {
    const counted = line.inventoryItemId === items.alpha.id ? alphaCounted : 10;
    const r = await patchLine(fx.manager.email, sessionId, line.id, counted);
    assert.ok(r.status < 300, `capture failed: ${r.text}`);
  }
  const submitted = await submitCount(fx.manager.email, sessionId);
  assert.ok(submitted.status < 300, `count submit failed: ${submitted.text}`);

  const unsettled = await db.stockCountLine.findMany({
    where: { sessionId, disposition: { in: ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"] } },
    select: { id: true },
  });
  for (const line of unsettled) {
    const r = await acceptVariance(fx.manager.email, sessionId, line.id, stockReasonId);
    assert.ok(r.status < 300, `accept-variance failed: ${r.text}`);
  }
  return { lineIds: lines.map((l) => l.id), settled: unsettled.length };
}

/** A handover sent back for a recount, with its superseded evidence. */
async function rejectedHandover() {
  const h = await reviewedHandover();
  const result = await requestRecount({
    handoverId: h.handoverId,
    reasonCodeId: handoverReasonId,
    note: "الأرقام مش مظبوطة",
  });
  return { ...h, supersededSessionId: result.supersededSessionId };
}

describe("REJECTED restart", () => {
  test("6.1 start_count on a REJECTED handover creates the replacement", async () => {
    const h = await rejectedHandover();

    const r = await startCountHttp(h.handoverId);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.countSession.reused, false);
    assert.notEqual(
      r.body.countSession.id,
      h.supersededSessionId,
      "the replacement is a new session, not the old one reopened",
    );

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, stockCountSessionId: true },
    });
    assert.equal(handover.status, "DRAFT");
    assert.equal(handover.stockCountSessionId, r.body.countSession.id);
  });

  test("6.2 the replacement is bound exactly as the first one was", async () => {
    const h = await rejectedHandover();
    const r = await startCountHttp(h.handoverId);
    assert.equal(r.status, 200, r.text);

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: r.body.countSession.id },
    });
    assert.equal(session.accountabilityContext, "HANDOVER");
    assert.equal(session.handoverId, h.handoverId);
    assert.equal(session.status, "DRAFT");
    assert.equal(session.mode, "BLIND");
    assert.equal(session.shiftId, h.shiftId);
    assert.equal(session.custodyPeriodId, h.outgoingStockCustodyId);
    // Derived from the same immutable snapshot the first session used.
    assert.equal(session.type, "CRITICAL");
    assert.equal(session.scopeDerivation, "CRITICAL_ONLY");
  });

  test("6.3 the replacement's lines come from the required-item snapshot", async () => {
    const h = await rejectedHandover();
    // Between the rejection and the restart the shelf changes underneath: a
    // unit is switched and an item is archived. Neither may reach a handover
    // that was planned before either happened.
    await db.inventoryItem.update({
      where: { id: items.alpha.id },
      data: { unit: "LITER" },
    });
    await db.inventoryItem.update({
      where: { id: items.charlie.id },
      data: { archivedAt: new Date(), isActive: false },
    });

    const r = await startCountHttp(h.handoverId);
    assert.equal(r.status, 200, r.text);

    const snapshot = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId, omitted: false },
      select: { inventoryItemId: true, unitSnapshot: true },
    });
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: r.body.countSession.id },
    });

    assert.deepEqual(
      lines.map((l) => l.inventoryItemId).sort(),
      snapshot.map((s) => s.inventoryItemId).sort(),
    );
    for (const line of lines) {
      const snap = snapshot.find((s) => s.inventoryItemId === line.inventoryItemId)!;
      assert.equal(
        line.unit,
        snap.unitSnapshot,
        "the unit is the one the handover was planned in, never today's",
      );
      assert.equal(line.disposition, "PENDING");
      assert.equal(line.countedQuantity, null);
      assert.equal(line.effectiveCountedQuantity, null);
      assert.equal(line.expectedQuantity, null);
      assert.equal(line.varianceQuantity, null);
      assert.equal(line.itemVersion, null);
      assert.equal(line.countedAt, null);
    }
  });

  test("6.4 the restart moves exactly three columns on the handover", async () => {
    const h = await rejectedHandover();
    const before = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
    });

    const r = await startCountHttp(h.handoverId);
    assert.equal(r.status, 200, r.text);

    const after_ = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
    });
    const moved: string[] = [];
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      if (asText(before[key]) !== asText(after_[key])) moved.push(String(key));
    }
    assert.deepEqual(
      moved.sort(),
      ["status", "stockCountSessionId", "updatedAt"],
      "the restart replaces the current-count pointer and the status, nothing else",
    );
  });

  test("6.5 the superseded session survives untouched, and both exist", async () => {
    const h = await rejectedHandover();
    const sessionBefore = asText(
      await db.stockCountSession.findUniqueOrThrow({ where: { id: h.supersededSessionId } }),
    );
    const linesBefore = await sessionLinesText(h.supersededSessionId);

    const r = await startCountHttp(h.handoverId);
    assert.equal(r.status, 200, r.text);

    const superseded = await db.stockCountSession.findUniqueOrThrow({
      where: { id: h.supersededSessionId },
    });
    assert.equal(superseded.status, "CONFIRMED");
    assert.equal(asText(superseded), sessionBefore);
    assert.equal(await sessionLinesText(h.supersededSessionId), linesBefore);

    assert.equal(
      await db.stockCountSession.count({ where: { handoverId: h.handoverId } }),
      2,
      "the superseded evidence and its replacement, and nothing else",
    );
  });

  test("6.6 the freeze is still held and custody has not moved", async () => {
    const h = await rejectedHandover();
    const r = await startCountHttp(h.handoverId);
    assert.equal(r.status, 200, r.text);

    const { activeFreezeFor } = await import("@/lib/inventory-freeze");
    const freeze = await activeFreezeFor(db, fx.branchId);
    assert.ok(freeze);
    assert.equal(freeze.handoverId, h.handoverId);

    for (const id of [h.outgoingStockCustodyId, h.outgoingCashCustodyId] as string[]) {
      const period = await db.custodyPeriod.findUniqueOrThrow({ where: { id } });
      assert.equal(period.status, "OPEN");
      assert.equal(period.acceptedById, null);
    }
  });

  test("6.7 no accepted field is written, and the rejection is retained", async () => {
    const h = await rejectedHandover();
    const r = await startCountHttp(h.handoverId);
    assert.equal(r.status, 200, r.text);

    await assertNoLaterStageWrites(h, "after the restart");

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: {
        status: true,
        rejectionReasonCodeId: true,
        rejectionNote: true,
        rejectedAt: true,
      },
    });
    assert.equal(handover.status, "DRAFT");
    assert.equal(
      handover.rejectionReasonCodeId,
      handoverReasonId,
      "the rejection fields are the record of WHY a second count exists",
    );
    assert.equal(handover.rejectionNote, "الأرقام مش مظبوطة");
    assert.ok(handover.rejectedAt instanceof Date);
  });

  test("6.8 confirming the replacement still opens zero variance cases", async () => {
    const h = await rejectedHandover();
    // A blocking policy deliberately in force. SH-17's deferral is contextual
    // and does not consult it, and this is the case that says so for the
    // SECOND count as well as the first.
    await db.cafeSettings.update({
      where: { cafeId: fx.cafeId },
      data: { varianceBlocksHandover: true, varianceHardBlockAmount: 1 },
    });

    const started = await startCountHttp(h.handoverId);
    assert.equal(started.status, 200, started.text);
    const sessionId = started.body.countSession.id;

    const { lineIds, settled } = await walkTheCount(sessionId, 3);
    assert.ok(settled > 0, "the fixture must produce a real difference to settle");

    const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-replacement-1`);
    assert.ok(confirmed.status < 300, `confirm failed: ${confirmed.text}`);
    assert.equal(confirmed.body.status, "CONFIRMED");
    assert.deepEqual(confirmed.body.varianceCaseIds, []);
    assert.deepEqual(confirmed.body.deferred, {
      context: "HANDOVER",
      handoverId: h.handoverId,
      openingBranchCustodyPeriodId: null,
    });
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: { in: lineIds } } }),
      0,
      "a second handover-bound confirmation is still a proposal, and opens no case",
    );
    assert.equal(
      await db.varianceCase.count({
        where: { stockCountLine: { sessionId: h.supersededSessionId } },
      }),
      0,
      "and the first count still has none either",
    );
  });

  test("6.9 two simultaneous restarts yield one replacement", async () => {
    const h = await rejectedHandover();

    const results = await Promise.allSettled([
      startCountHttp(h.handoverId),
      startCountHttp(h.handoverId),
    ]);
    for (const r of results) assert.equal(r.status, "fulfilled");
    const bodies = results.map(
      (r) =>
        (r as PromiseFulfilledResult<Awaited<ReturnType<typeof startCountHttp>>>).value,
    );
    for (const r of bodies) assert.equal(r.status, 200, r.text);
    assert.equal(
      bodies[0].body.countSession.id,
      bodies[1].body.countSession.id,
      "both callers must receive the same replacement",
    );

    assert.equal(
      await db.stockCountSession.count({ where: { handoverId: h.handoverId } }),
      2,
      "the superseded evidence and exactly one replacement",
    );
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, stockCountSessionId: true },
    });
    assert.equal(handover.status, "DRAFT");
    assert.equal(handover.stockCountSessionId, bodies[0].body.countSession.id);
  });
});

// ──────────────── T7 · end to end, and the concurrency matrix ────────────
//
// Every step an HTTP request. The two business walks the roadmap names —
// shortage then recount then exact, and overage then recount then a
// DIFFERENT non-zero variance — proved against the real application rather
// than against the services they call.
//
// What is being proved is a negative as much as a positive: the first
// evidence produces no accountability case, the recount neither creates nor
// retracts one, the replacement's confirmation still produces none, the old
// evidence stays readable history, and only the replacement is eligible for
// the acceptance SH-20 will build.

const submitHandoverHttp = (handoverId: string, email: string = fx.cashier.email) =>
  post<{ status?: string; error?: string }>(email, { action: "submit", handoverId });

/** The arriving cashier's shift, still unable to sell a shelf nobody gave it. */
async function assertGateClosed(shiftId: string, step: string) {
  const shift = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
  assert.ok(
    shift.custodyGateReason,
    `${step}: the arriving shift must still be gated — custody has not moved`,
  );
  assert.equal(shift.custodyReadyAt, null, `${step}: and cannot be ready`);
}

const caseCountFor = (sessionId: string) =>
  db.varianceCase.count({ where: { stockCountLine: { sessionId } } });

/**
 * The whole disagreement, over HTTP: count, confirm, submit, acknowledge with
 * a differing figure, and send it back.
 *
 * `gatedShiftId`, when given, is checked after every one of the eight steps.
 */
async function walkToRecount(
  h: Handover,
  alphaCounted: number,
  spotCount: number,
  gatedShiftId?: string,
) {
  const check = async (step: string) => {
    if (gatedShiftId) await assertGateClosed(gatedShiftId, step);
  };

  const started = await startCountHttp(h.handoverId);
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  await check("1 start_count");

  const { lineIds } = await walkTheCount(sessionId, alphaCounted);
  await check("2-4 capture, submit, settle");

  const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-${sessionId}`);
  assert.ok(confirmed.status < 300, `confirm failed: ${confirmed.text}`);
  assert.deepEqual(confirmed.body.varianceCaseIds, []);
  assert.equal(
    await caseCountFor(sessionId),
    0,
    "the first evidence is a proposal, and opens no accountability case",
  );
  await check("5 confirm");

  const submitted = await submitHandoverHttp(h.handoverId);
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.body.status, "OUTGOING_SUBMITTED");
  await check("6 handover submit");

  const alphaLine = await lineOf(sessionId, items.alpha.id);
  const acked = await ackPost(incoming.email, h.handoverId, {
    stockCountLineId: alphaLine.id,
    incomingCountedQuantity: spotCount,
    disputeReasonCodeId: handoverReasonId,
    disputeNote: "مش متفقين",
  });
  assert.equal(acked.status, 200, acked.text);
  assert.equal(acked.body.decision, "DISPUTED");
  await check("7 acknowledge");

  const recount = await recountPost(incoming.email, h.handoverId, {
    reasonCodeId: handoverReasonId,
    note: "نعيد",
  });
  assert.equal(recount.status, 200, recount.text);
  assert.deepEqual(recount.body.disputedLineIds, [alphaLine.id]);
  assert.equal(recount.body.supersededSessionId, sessionId);
  assert.equal(
    await caseCountFor(sessionId),
    0,
    "the recount neither creates a case nor retracts one",
  );
  await check("8 request-recount");

  return { sessionId, lineIds, alphaLineId: alphaLine.id, ackId: alphaLine.id };
}

/** Start the replacement, count it, and confirm it. */
async function restartAndConfirm(h: Handover, alphaCounted: number, gatedShiftId?: string) {
  const restarted = await startCountHttp(h.handoverId);
  assert.equal(restarted.status, 200, restarted.text);
  const sessionId = restarted.body.countSession.id;
  if (gatedShiftId) await assertGateClosed(gatedShiftId, "9 restart");

  const { lineIds } = await walkTheCount(sessionId, alphaCounted);
  const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-${sessionId}`);
  assert.ok(confirmed.status < 300, `replacement confirm failed: ${confirmed.text}`);
  assert.equal(confirmed.body.status, "CONFIRMED");
  assert.deepEqual(
    confirmed.body.varianceCaseIds,
    [],
    "the replacement's confirmation opens no case either",
  );
  if (gatedShiftId) await assertGateClosed(gatedShiftId, "10 replacement confirm");
  return { sessionId, lineIds };
}

describe("recount end-to-end", () => {
  test("7.1 shortage, recount, then an exact count", async () => {
    const h = await freshHandover();
    const gated = await openIncomingShift();

    // 3 against a shelf of 10 — a shortage of seven, explained and settled.
    const first = await walkToRecount(h, 3, 9, gated.id);
    const replacement = await restartAndConfirm(h, 10, gated.id);

    assert.notEqual(replacement.sessionId, first.sessionId);
    assert.equal(await caseCountFor(first.sessionId), 0, "the shortage session, still no case");
    assert.equal(
      await caseCountFor(replacement.sessionId),
      0,
      "and the exact replacement opens none",
    );

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, stockCountSessionId: true, acceptedStockCountSessionId: true },
    });
    assert.equal(handover.status, "DRAFT");
    assert.equal(handover.stockCountSessionId, replacement.sessionId);
    assert.equal(handover.acceptedStockCountSessionId, null, "acceptance is SH-20's");

    // The replacement agrees with the shelf: every line's variance is zero.
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: replacement.sessionId },
      select: { varianceQuantity: true },
    });
    for (const line of lines) assert.equal(Number(line.varianceQuantity), 0);
  });

  test("7.2 overage, recount, then a different non-zero variance", async () => {
    const h = await freshHandover();
    const gated = await openIncomingShift();

    // 14 against a shelf of 10 — an overage of four.
    const first = await walkToRecount(h, 14, 11, gated.id);
    const firstAlpha = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: first.sessionId, inventoryItemId: items.alpha.id },
      select: { varianceQuantity: true, reasonCodeId: true },
    });
    assert.equal(Number(firstAlpha.varianceQuantity), 4);

    // The recount finds twelve: a real, different, non-zero variance.
    const replacement = await restartAndConfirm(h, 12, gated.id);
    const secondAlpha = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: replacement.sessionId, inventoryItemId: items.alpha.id },
      select: { varianceQuantity: true, reasonCodeId: true },
    });
    assert.equal(Number(secondAlpha.varianceQuantity), 2);
    assert.notEqual(
      Number(secondAlpha.varianceQuantity),
      Number(firstAlpha.varianceQuantity),
      "the replacement carries the recount's own figure, not the first count's",
    );
    assert.equal(secondAlpha.reasonCodeId, stockReasonId, "and its own reason");

    assert.equal(
      await caseCountFor(first.sessionId),
      0,
      "the first overage produced no final accountability case, and still has none",
    );
    assert.equal(await caseCountFor(replacement.sessionId), 0);
  });

  test("7.3 the arriving shift is non-operational throughout both walks", async () => {
    // The walks above assert the gate after each of their steps through
    // `gatedShiftId`; this case states the invariant on its own and proves it
    // survives the whole sequence rather than only the moments sampled.
    const h = await freshHandover();
    const gated = await openIncomingShift();
    await assertGateClosed(gated.id, "0 before anything");

    await walkToRecount(h, 3, 9, gated.id);
    await restartAndConfirm(h, 10, gated.id);

    const shift = await db.shift.findUniqueOrThrow({ where: { id: gated.id } });
    assert.equal(shift.custodyGateReason, "AWAITING_CUSTODY_TRANSFER");
    assert.equal(shift.custodyReadyAt, null);
    assert.equal(shift.status, "OPEN");
  });

  test("7.4 the superseded session is still readable, with its figures unchanged", async () => {
    const h = await freshHandover();
    const first = await walkToRecount(h, 3, 9);
    const before = await sessionLinesText(first.sessionId);

    await restartAndConfirm(h, 10);

    const r = await as<{ session: { id: string; status: string; lines: unknown[] } }>(
      fx.manager.email,
      `/api/stock-counts/${first.sessionId}`,
    );
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.session.id, first.sessionId);
    assert.equal(r.body.session.status, "CONFIRMED");
    assert.equal(
      await sessionLinesText(first.sessionId),
      before,
      "history is kept, not tidied up",
    );
  });

  test("7.5 only the replacement is eligible for later acceptance", async () => {
    const h = await freshHandover();
    const first = await walkToRecount(h, 3, 9);
    const replacement = await restartAndConfirm(h, 10);

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { stockCountSessionId: true, acceptedStockCountSessionId: true },
    });
    assert.equal(handover.stockCountSessionId, replacement.sessionId);
    assert.equal(handover.acceptedStockCountSessionId, null);

    const superseded = await db.stockCountSession.findUniqueOrThrow({
      where: { id: first.sessionId },
      select: { lockedByHandoverId: true, status: true },
    });
    assert.equal(superseded.lockedByHandoverId, null, "locking the evidence is acceptance");
    assert.equal(superseded.status, "CONFIRMED");

    assert.equal(
      await db.stockCountRebase.count({ where: { session: { handoverId: h.handoverId } } }),
      0,
    );
    assert.equal(
      await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }),
      0,
    );
  });

  test("7.6 a stale acknowledgement is refused, and the old ones are kept", async () => {
    const h = await freshHandover();
    const first = await walkToRecount(h, 3, 9);
    const acksBefore = asText(
      await db.handoverStockAcknowledgement.findMany({
        where: { handoverId: h.handoverId },
        orderBy: { id: "asc" },
      }),
    );
    assert.notEqual(acksBefore, "[]", "the walk must have produced an acknowledgement");

    // The replacement is counted, confirmed and submitted, so the handover is
    // back in review — and the refusal below is therefore about the SESSION
    // the line belongs to rather than about the handover's status.
    const replacement = await restartAndConfirm(h, 10);
    const resubmitted = await submitHandoverHttp(h.handoverId);
    assert.equal(resubmitted.status, 200, resubmitted.text);

    const staleLine = await lineOf(first.sessionId, items.bravo.id);
    const r = await ackPost(incoming.email, h.handoverId, { stockCountLineId: staleLine.id });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.error, OLD_SESSION);

    // The current session's own line still signs perfectly well.
    const liveLine = await lineOf(replacement.sessionId, items.bravo.id);
    const ok = await ackPost(incoming.email, h.handoverId, { stockCountLineId: liveLine.id });
    assert.equal(ok.status, 200, ok.text);

    const acksAfter = await db.handoverStockAcknowledgement.findMany({
      where: { handoverId: h.handoverId, line: { sessionId: first.sessionId } },
      orderBy: { id: "asc" },
    });
    assert.equal(
      asText(acksAfter),
      acksBefore,
      "the acknowledgements made before the recount are history, and are unmodified",
    );
  });
});

// ────────────────────────────── T7 · concurrency ─────────────────────────
//
// Real PostgreSQL, real concurrent HTTP requests. The handover row lock, the
// acknowledgement's `@@unique(handoverId, stockCountLineId)` and the branch's
// partial unique index are exercised as the database rather than as a mock: a
// serialisation bug here produces two reviews of one handover, two rejections
// of one count, or an acknowledgement of evidence nobody is reviewing, and
// none of those is visible to a single-threaded test.

const settledBodies = <T>(results: PromiseSettledResult<T>[]): T[] => {
  for (const r of results) assert.equal(r.status, "fulfilled", "no request may reject outright");
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
};

describe("concurrency", () => {
  test("7.7 two first acknowledgements on different lines open the review once", async () => {
    const h = await submittedHandover();
    const alpha = await lineOf(h.sessionId, items.alpha.id);
    const bravo = await lineOf(h.sessionId, items.bravo.id);

    const bodies = settledBodies(
      await Promise.allSettled([
        ackPost(incoming.email, h.handoverId, { stockCountLineId: alpha.id }),
        ackPost(incoming.email, h.handoverId, { stockCountLineId: bravo.id }),
      ]),
    );
    for (const r of bodies) assert.equal(r.status, 200, r.text);

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, reviewedAt: true },
    });
    assert.equal(handover.status, "INCOMING_REVIEW");
    assert.ok(handover.reviewedAt instanceof Date);

    const rows = await db.handoverStockAcknowledgement.findMany({
      where: { handoverId: h.handoverId },
      select: { id: true, stockCountLineId: true },
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.stockCountLineId).sort(),
      [alpha.id, bravo.id].sort(),
    );
    // One acknowledgement, one record of it.
    for (const row of rows) {
      assert.equal(
        await db.auditLog.count({
          where: { entityId: row.id, action: "HANDOVER_LINE_ACKNOWLEDGED" },
        }),
        1,
      );
    }
  });

  test("7.8 two acknowledgements of the same line produce one signature", async () => {
    const h = await submittedHandover();
    const alpha = await lineOf(h.sessionId, items.alpha.id);

    const bodies = settledBodies(
      await Promise.allSettled([
        ackPost(incoming.email, h.handoverId, { stockCountLineId: alpha.id }),
        ackPost(incoming.email, h.handoverId, { stockCountLineId: alpha.id }),
      ]),
    );
    const codes = bodies.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409], bodies.map((b) => b.text).join(" | "));
    const refused = bodies.find((b) => b.status === 409)!;
    assert.equal(
      refused.body.error,
      ALREADY_ACKNOWLEDGED,
      "the losing racer gets the business refusal, never a raw constraint violation",
    );

    assert.equal(await ackCount(h.handoverId), 1);
  });

  test("7.9 an acknowledgement racing a recount leaves a consistent record", async () => {
    const h = await submittedHandover();
    const alpha = await lineOf(h.sessionId, items.alpha.id);

    const bodies = settledBodies(
      await Promise.allSettled([
        ackPost(incoming.email, h.handoverId, { stockCountLineId: alpha.id }),
        recountPost(incoming.email, h.handoverId, { reasonCodeId: handoverReasonId }),
      ]),
    );
    for (const r of bodies) {
      assert.ok(r.status < 500, `no request may fail with a server error: ${r.text}`);
    }
    const [ackResult, recountResult] = bodies;

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, rejectedAt: true },
    });

    if (recountResult.status === 200) {
      assert.equal(handover.status, "REJECTED");
      assert.ok(handover.rejectedAt instanceof Date);
      const rows = await db.handoverStockAcknowledgement.findMany({
        where: { handoverId: h.handoverId },
        select: { acknowledgedAt: true },
      });
      // The acknowledgement either landed BEFORE the rejection or not at all.
      // A row created after `rejectedAt` would mean somebody signed for
      // evidence that had already been sent back.
      for (const row of rows) {
        assert.ok(
          row.acknowledgedAt <= handover.rejectedAt!,
          "no acknowledgement may be created after the handover was rejected",
        );
      }
      if (ackResult.status !== 200) assert.equal(ackResult.status, 409, ackResult.text);
    } else {
      // The recount lost: the acknowledgement holds and the handover is in
      // review, with the refusal explaining why the recount could not run.
      assert.equal(ackResult.status, 200, ackResult.text);
      assert.equal(recountResult.status, 409, recountResult.text);
      assert.equal(handover.status, "INCOMING_REVIEW");
    }
  });

  test("7.10 two recount requests reject exactly once", async () => {
    const h = await submittedHandover();

    const bodies = settledBodies(
      await Promise.allSettled([
        recountPost(incoming.email, h.handoverId, { reasonCodeId: handoverReasonId }),
        recountPost(incoming.email, h.handoverId, { reasonCodeId: handoverReasonId }),
      ]),
    );
    assert.deepEqual(
      bodies.map((r) => r.status).sort(),
      [200, 409],
      bodies.map((b) => b.text).join(" | "),
    );

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, rejectedAt: true },
    });
    assert.equal(handover.status, "REJECTED");
    assert.ok(handover.rejectedAt instanceof Date);
    assert.equal(
      await db.auditLog.count({
        where: { entityId: h.handoverId, action: "HANDOVER_RECOUNT_REQUESTED" },
      }),
      1,
      "one rejection, one record of it",
    );
  });

  test("7.11 an acknowledgement delivered after the recount is refused", async () => {
    const h = await submittedHandover();
    // The line id is resolved BEFORE the recount — the caller is holding a
    // page that was rendered against the pre-recount pointer.
    const stale = await lineOf(h.sessionId, items.alpha.id);

    const recount = await recountPost(incoming.email, h.handoverId, {
      reasonCodeId: handoverReasonId,
    });
    assert.equal(recount.status, 200, recount.text);

    const late = await ackPost(incoming.email, h.handoverId, { stockCountLineId: stale.id });
    assert.equal(late.status, 409, late.text);
    assert.equal(await ackCount(h.handoverId), 0, "and nothing was written");
  });

  test("7.12 an acknowledgement racing the replacement never signs a superseded line", async () => {
    const h = await submittedHandover();
    const stale = await lineOf(h.sessionId, items.alpha.id);
    const recount = await recountPost(incoming.email, h.handoverId, {
      reasonCodeId: handoverReasonId,
    });
    assert.equal(recount.status, 200, recount.text);
    const supersededSessionId = recount.body.supersededSessionId!;

    // The restart and a late acknowledgement, in flight together.
    const bodies = settledBodies(
      await Promise.allSettled([
        startCountHttp(h.handoverId),
        ackPost(incoming.email, h.handoverId, { stockCountLineId: stale.id }),
      ]),
    );
    for (const r of bodies) assert.ok(r.status < 500, `no server error: ${r.text}`);

    // Asserted as an invariant over the resulting rows rather than over the
    // response codes, because either ordering is legitimate.
    const pointer = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { stockCountSessionId: true },
    });
    const rows = await db.handoverStockAcknowledgement.findMany({
      where: { handoverId: h.handoverId },
      select: { line: { select: { sessionId: true } } },
    });
    for (const row of rows) {
      assert.equal(
        row.line.sessionId,
        pointer.stockCountSessionId,
        "no acknowledgement may name a session the pointer does not",
      );
    }
    assert.equal(
      rows.filter((r) => r.line.sessionId === supersededSessionId).length,
      0,
      "and none may name the superseded one",
    );
  });
});
