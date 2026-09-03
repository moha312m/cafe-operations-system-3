// HANDOVER-006 — SH-18: the outgoing hand submits, and the incoming one looks
// for itself.
//
// SH-16 closed the money and froze the shelf. SH-17 built deferred
// accountability but left it unreachable: nothing in the application could
// create a count session whose `accountabilityContext` was HANDOVER. SH-18 is
// the workflow that reaches it — a count that answers to a named handover, a
// stated closing position derived and never persisted, a submit that refuses
// with every reason at once, and an incoming review that is blind until the
// reviewer has taken their own look.
//
// Three facts this suite exists to pin, because each one has a plausible
// wrong implementation:
//
//   1. Scope comes from the IMMUTABLE `HandoverRequiredItem` snapshot, never
//      from today's branch configuration. A handover planned under SELECTED
//      stays SELECTED even if an owner flips the branch to FULL mid-shift,
//      and an item archived after the close is still owed a count.
//
//   2. Every non-zero variance needs a reason to submit, REGARDLESS of the
//      tolerance verdict and regardless of any blocking policy. Tolerance
//      answers "is this worth investigating"; a handover asks "what do you
//      say happened", and inside-tolerance is not an answer.
//
//   3. The incoming reviewer's pre-acknowledgement view is blind STRUCTURALLY.
//      `redactCountTargets` is a no-op here — the bound session is CONFIRMED
//      and the reviewer neither initiated it nor counted a line — so a view
//      that merely called it would ship a blindness test that passes while
//      leaking every target. The projection names no quantity column at all.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";

const MARKER = tag("HANDOVER006");

type HandoverLib = typeof import("@/lib/handover");
const handoverLib = (): Promise<HandoverLib> => import("@/lib/handover");
type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");

const statusIs = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;

/** Both handover grants, so the close itself is never the thing refusing. */
const GRANTS_FULL = { handoverSubmit: true, handoverException: true };

let fx: CountCafe;
/** A second tenant. Nothing in it may ever be reachable from the first. */
let other: CountCafe;

/** Three critical items, so SELECTED mode has a scope that is not the shelf. */
const ITEM_KEYS = ["alpha", "bravo", "charlie"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];
const items: Record<ItemKey, { id: string; name: string }> = {} as never;
/** One ordinary item, so FULL and SELECTED are observably different scopes. */
let ordinaryItemId: string;
let otherHandoverId: string;

// ───────────────────────────── the SH-16 reality ─────────────────────────
//
// Every case starts from a real close: `closeShiftWithSettlement` is what
// creates the DRAFT handover, its immutable required-item snapshot, its
// durable freeze and its custody links, all in one transaction. Building
// those by hand would test a fixture rather than the state SH-18 inherits.

/** The branch's effective handover configuration, restated from scratch. */
async function configureBranch() {
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: {
      stockCountPolicy: "HYBRID",
      handoverCountType: "CRITICAL",
      periodicFullCountSchedule: "MANUAL_ONLY",
      periodicFullCountWeekday: null,
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

/** Put the three critical items back the way the fixture created them. */
async function restoreItems() {
  for (const key of ITEM_KEYS) {
    await db.inventoryItem.update({
      where: { id: items[key].id },
      data: { unit: "KG", isCritical: true, isActive: true, archivedAt: null },
    });
  }
  await db.inventoryItem.update({
    where: { id: ordinaryItemId },
    data: { isCritical: false, isActive: true, archivedAt: null },
  });
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
  // `accountabilityContext` and `handoverId` move together — the database's
  // own CHECK refuses a HANDOVER context with no handover named.
  await db.stockCountSession.updateMany({
    where: { branchId },
    data: { lockedByHandoverId: null, handoverId: null, accountabilityContext: "NONE" },
  });
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

export type Handover = {
  handoverId: string;
  shiftId: string;
  freezeId: string;
  requiredItemIds: string[];
  outgoingStockCustodyId: string | null;
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
  };
}

/** The service call under test, with the outgoing custodian as the actor. */
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

before(async () => {
  fx = await countCafe("HANDOVER006");
  other = await countCafe("HANDOVER006X");

  for (const key of ITEM_KEYS) {
    const created = await countItem(fx, key, { stock: 10, isCritical: true });
    items[key] = { id: created.id, name: created.name };
  }
  const ordinary = await countItem(fx, "ordinary", { stock: 5, isCritical: false });
  ordinaryItemId = ordinary.id;

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
  const foreign = await freshHandover(other, other.branchId);
  otherHandoverId = foreign.handoverId;
});

beforeEach(async () => {
  await configureBranch();
  await restoreItems();
});

after(async () => {
  await teardownTaggedCafe([fx?.cafeId, other?.cafeId], [], { disconnect: true });
});

// ─────────────────────────────── T1 · start_count ────────────────────────

describe("start_count", () => {
  test("binds the session to the handover with accountabilityContext HANDOVER", async () => {
    const h = await freshHandover();
    const started = await startCount(h.handoverId);

    assert.equal(started.reused, false);
    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: started.countSessionId },
    });
    assert.equal(session.accountabilityContext, "HANDOVER");
    assert.equal(session.handoverId, h.handoverId);
    assert.equal(session.status, "DRAFT");

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { stockCountSessionId: true },
    });
    assert.equal(handover.stockCountSessionId, started.countSessionId);
  });

  test("derives scope and type from the immutable snapshot, not live config", async () => {
    const h = await freshHandover();

    // Between the close and the start, the owner flips the branch to FULL and
    // an item leaves the shelf. Neither may reach a handover already planned.
    await db.branch.update({
      where: { id: fx.branchId },
      data: { handoverCountTypeOverride: "FULL" },
    });
    await db.inventoryItem.update({
      where: { id: items.charlie.id },
      data: { archivedAt: new Date(), isActive: false },
    });

    const started = await startCount(h.handoverId);
    assert.deepEqual([...started.scopeItemIds].sort(), [...h.requiredItemIds].sort());
    assert.equal(started.type, "CRITICAL");
    assert.ok(
      !started.scopeItemIds.includes(ordinaryItemId),
      "a FULL-mode item must not enter a SELECTED handover's scope",
    );

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: started.countSessionId },
      select: { type: true, scopeDerivation: true, lines: { select: { inventoryItemId: true } } },
    });
    assert.equal(session.type, "CRITICAL");
    assert.equal(session.scopeDerivation, "CRITICAL_ONLY");
    assert.deepEqual(
      session.lines.map((l) => l.inventoryItemId).sort(),
      [...h.requiredItemIds].sort(),
    );
  });

  test("takes each line's unit from unitSnapshot, not the live item", async () => {
    const h = await freshHandover();
    const snapshot = await db.handoverRequiredItem.findFirstOrThrow({
      where: { handoverId: h.handoverId, inventoryItemId: items.alpha.id },
      select: { unitSnapshot: true },
    });
    assert.equal(snapshot.unitSnapshot, "KG");

    // The shelf is restocked in litres after the close. The count still owes
    // the unit the handover was planned in.
    await db.inventoryItem.update({
      where: { id: items.alpha.id },
      data: { unit: "LITER" },
    });

    const started = await startCount(h.handoverId);
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: started.countSessionId, inventoryItemId: items.alpha.id },
      select: { unit: true },
    });
    assert.equal(line.unit, "KG");
  });

  test("binds shift and custody to the outgoing handover's own", async () => {
    const h = await freshHandover();
    assert.ok(h.outgoingStockCustodyId, "the fixture must produce a STOCK custody to discharge");

    const started = await startCount(h.handoverId);
    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: started.countSessionId },
      select: { shiftId: true, custodyPeriodId: true },
    });
    assert.equal(session.shiftId, h.shiftId);
    assert.equal(session.custodyPeriodId, h.outgoingStockCustodyId);
  });

  test("replaces only the current-count pointer and edits no prior session", async () => {
    const h = await freshHandover();

    // Recount history: an earlier bound session, already closed out, that the
    // handover no longer points at. Nothing may edit or delete it.
    const prior = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        shiftId: h.shiftId,
        type: "CRITICAL",
        status: "LOCKED",
        lockedAt: new Date(),
        scopeDerivation: "CRITICAL_ONLY",
        initiatedById: fx.cashier.id,
        accountabilityContext: "HANDOVER",
        handoverId: h.handoverId,
      },
    });
    const before = await db.stockCountSession.findUniqueOrThrow({ where: { id: prior.id } });

    const started = await startCount(h.handoverId);
    assert.notEqual(started.countSessionId, prior.id);

    const after = await db.stockCountSession.findUniqueOrThrow({ where: { id: prior.id } });
    assert.deepEqual(after, before);

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { stockCountSessionId: true },
    });
    assert.equal(handover.stockCountSessionId, started.countSessionId);
    assert.equal(
      await db.stockCountSession.count({ where: { handoverId: h.handoverId } }),
      2,
      "the prior session survives alongside the new one",
    );
  });

  test("is idempotent — a retry returns the same session and creates none", async () => {
    const h = await freshHandover();
    const first = await startCount(h.handoverId);
    const second = await startCount(h.handoverId);

    assert.equal(second.countSessionId, first.countSessionId);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.deepEqual(second.scopeItemIds, first.scopeItemIds);
    assert.equal(await db.stockCountSession.count({ where: { handoverId: h.handoverId } }), 1);
  });

  test("refuses a handover that is not DRAFT", async () => {
    const reason = await db.reasonCode.create({
      data: { cafeId: fx.cafeId, domain: "HANDOVER", code: `${MARKER}-REJ`, label: "refused" },
    });

    for (const status of ["OUTGOING_SUBMITTED", "INCOMING_REVIEW", "REJECTED", "COMPLETED"] as const) {
      const h = await freshHandover();
      await db.handoverSession.update({
        where: { id: h.handoverId },
        data: {
          status,
          ...(status === "REJECTED"
            ? { rejectedAt: new Date(), rejectionReasonCodeId: reason.id }
            : {}),
          ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
        },
      });

      await assert.rejects(
        startCount(h.handoverId),
        statusIs(409),
        `${status} must refuse a handover-bound count start`,
      );
      assert.equal(
        await db.stockCountSession.count({ where: { handoverId: h.handoverId } }),
        0,
        `${status} must create no session`,
      );
    }
  });

  test("refuses another cafe's handover as 404 and another branch as 403", async () => {
    const h = await freshHandover();

    // Another tenant's handover is not confirmed to exist at all.
    await assert.rejects(
      startCount(otherHandoverId, { cafeId: fx.cafeId }),
      statusIs(404),
    );
    // The café is the viewer's; the branch is not.
    await assert.rejects(
      startCount(h.handoverId, { viewerBranchId: fx.otherBranchId }),
      statusIs(403),
    );
    assert.equal(await db.stockCountSession.count({ where: { handoverId: h.handoverId } }), 0);
    assert.equal(await db.stockCountSession.count({ where: { handoverId: otherHandoverId } }), 0);
  });

  test("refuses when the SH-16 state is not the handover state", async () => {
    const mutations: Array<[string, () => Promise<unknown>, (h: Handover) => Promise<unknown>]> = [
      [
        "shift reopened",
        async () => undefined,
        (h) => db.shift.update({ where: { id: h.shiftId }, data: { status: "CLOSED" } }),
      ],
      [
        "financial close erased",
        async () => undefined,
        (h) => db.shift.update({ where: { id: h.shiftId }, data: { financiallyClosedAt: null } }),
      ],
      [
        "stock already closed",
        async () => undefined,
        (h) => db.shift.update({ where: { id: h.shiftId }, data: { stockClosedAt: new Date() } }),
      ],
      [
        "freeze released",
        async () => undefined,
        (h) =>
          db.inventoryFreeze.update({
            where: { id: h.freezeId },
            data: { releasedAt: new Date(), releasedById: fx.cashier.id },
          }),
      ],
    ];

    for (const [label, , mutate] of mutations) {
      const h = await freshHandover();
      await mutate(h);
      const shiftBefore = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });

      await assert.rejects(startCount(h.handoverId), statusIs(409), `${label} must refuse`);

      const shiftAfter = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
      assert.deepEqual(shiftAfter, shiftBefore, `${label} must not write the shift`);
      assert.equal(
        await db.stockCountSession.count({ where: { handoverId: h.handoverId } }),
        0,
        `${label} must create no session`,
      );
    }
  });

  test("writes no later-stage field", async () => {
    const h = await freshHandover();
    const started = await startCount(h.handoverId);

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: started.countSessionId },
      select: { lockedByHandoverId: true, openingBranchCustodyPeriodId: true, idempotencyKey: true },
    });
    assert.equal(session.lockedByHandoverId, null);
    assert.equal(session.openingBranchCustodyPeriodId, null);
    assert.equal(session.idempotencyKey, null);

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: {
        resolvedTarget: true,
        acceptedStockCountSessionId: true,
        submittedAt: true,
        reviewedAt: true,
        acceptedAt: true,
        completedAt: true,
        status: true,
      },
    });
    assert.equal(handover.resolvedTarget, null);
    assert.equal(handover.acceptedStockCountSessionId, null);
    assert.equal(handover.submittedAt, null);
    assert.equal(handover.reviewedAt, null);
    assert.equal(handover.acceptedAt, null);
    assert.equal(handover.completedAt, null);
    assert.equal(handover.status, "DRAFT");

    assert.equal(await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }), 0);
    assert.equal(
      await db.handoverStockAcknowledgement.count({ where: { handoverId: h.handoverId } }),
      0,
    );
    assert.equal(
      await db.handoverRequiredItem.count({
        where: { handoverId: h.handoverId, satisfiedByLineId: { not: null } },
      }),
      0,
    );
    assert.equal(
      await db.handoverRequiredItem.count({
        where: { handoverId: h.handoverId, OR: [{ omitted: true }, { omissionNote: { not: null } }] },
      }),
      0,
    );

    const freeze = await db.inventoryFreeze.findUniqueOrThrow({ where: { id: h.freezeId } });
    assert.equal(freeze.releasedAt, null);

    const shift = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(shift.status, "AWAITING_HANDOVER");
    assert.equal(shift.stockClosedAt, null);
    assert.equal(shift.closedAt, null);
  });
});
