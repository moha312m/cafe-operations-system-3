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
import { login, requireServer } from "./helpers/http";

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
});

beforeEach(async () => {
  await configureBranch();
  await restoreItems();
});

after(async () => {
  await teardownTaggedCafe([fx?.cafeId, other?.cafeId], [], { disconnect: true });
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

// `freshHandover`, `incoming` and the handover reason ids above are consumed
// from T2 onward, when there is a service to point them at. The reference
// here keeps the fixture from reading as dead code until then.
void freshHandover;
