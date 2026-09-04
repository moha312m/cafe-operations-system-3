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
import { readFileSync } from "node:fs";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import bcrypt from "bcryptjs";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

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
/**
 * A café account that may READ a handover and not submit one.
 *
 * No system role holds `handover.view` without `handover.submit`, so the
 * distinction is made the way the application itself makes it — a per-user
 * override on top of a role — rather than by inventing a role for the test.
 */
let viewerOnly: { id: string; email: string };

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
      // Stated rather than inherited: the submit predicate must be provably
      // independent of it, and a case that turns it on must start from off.
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
  await requireServer();
  fx = await countCafe("HANDOVER006");
  other = await countCafe("HANDOVER006X");

  for (const key of ITEM_KEYS) {
    const created = await countItem(fx, key, { stock: 10, isCritical: true });
    items[key] = { id: created.id, name: created.name };
  }
  const ordinary = await countItem(fx, "ordinary", { stock: 5, isCritical: false });
  ordinaryItemId = ordinary.id;
  // The annex needs a critical item of its own, or its SELECTED-mode config
  // has no scope and no shift there could ever close into a handover.
  await countItem(fx, "annex", { stock: 8, isCritical: true, branchId: fx.otherBranchId });

  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  viewerOnly = await db.user.create({
    data: {
      email: `${fx.marker.toLowerCase()}-viewer@example.invalid`,
      name: `${fx.marker}-viewer`,
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
  await login(viewerOnly.email, COUNT_PASSWORD);

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

  // `REJECTED` is deliberately NOT in this list.
  //
  // It was, at SH-18, because nothing could yet ask for a recount and a
  // handover in that status had no way forward. SH-19 is the stage the
  // adjacent comment in `startHandoverCount` always pointed at: the outgoing
  // hand starts the replacement count, and `REJECTED → DRAFT` happens under
  // the handover row lock. `handover-007` cases 6.1–6.9 own that contract in
  // full — the fresh bound session, the pointer-only replacement, the
  // untouched prior evidence and the concurrent restart.
  //
  // Every OTHER non-DRAFT status still refuses here, which is what this case
  // is for now: the predicate must have widened by exactly one member.
  test("refuses a handover that is not DRAFT", async () => {
    for (const status of ["OUTGOING_SUBMITTED", "INCOMING_REVIEW", "COMPLETED"] as const) {
      const h = await freshHandover();
      await db.handoverSession.update({
        where: { id: h.handoverId },
        data: {
          status,
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

// ────────────────────────── T2 · closing position ────────────────────────
//
// The position is DERIVED. Nothing here is allowed to write it down: the
// moment a satisfaction is persisted it stops being a reading of the current
// evidence and starts being a claim somebody has to keep in step.

/** Write a line's figures directly. Capture is `count-010`'s subject, not this one. */
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
      itemVersion: counted === null ? null : BigInt(1),
      expectedBasis: counted === null ? null : "LOCKED_ITEM_VERSION",
      disposition: counted === null ? "PENDING" : "WITHIN_TOLERANCE",
      reasonCodeId: spec.reasonCodeId ?? null,
      costImpact: spec.costImpact ?? null,
      costImpactAvailable: spec.costImpactAvailable ?? false,
    },
  });
  return line.id;
}

const position = async (handoverId: string) => {
  const { deriveClosingPosition } = await handoverLib();
  return db.$transaction((tx) => deriveClosingPosition(tx, handoverId));
};

/** A STOCK reason code this suite owns. */
async function stockReason(label: string) {
  return db.reasonCode.create({
    data: { cafeId: fx.cafeId, domain: "STOCK", code: `${MARKER}-${label}`, label },
  });
}

describe("closing position", () => {
  test("counts required items satisfied and missing from bound evidence", async () => {
    const h = await freshHandover();
    const started = await startCount(h.handoverId);
    await fillLine(started.countSessionId, items.alpha.id, { counted: 10, expected: 10 });
    await fillLine(started.countSessionId, items.bravo.id, { counted: 4, expected: 4 });
    // charlie is left as the fixture created it: PENDING, never counted.

    const p = await position(h.handoverId);
    assert.equal(p.handoverId, h.handoverId);
    assert.equal(p.mode, "SELECTED");
    assert.equal(p.requiredItemTrigger, "REGULAR_MODE");
    assert.equal(p.required.total, 3);
    assert.equal(p.required.satisfied, 2);
    assert.deepEqual(p.required.missingItemIds, [items.charlie.id]);
    assert.equal(p.stock.countSessionId, started.countSessionId);
    assert.equal(p.stock.countedLines, 2);
    assert.equal(p.stock.uncountedActiveItems, 1);
    assert.equal(p.stock.nonZeroVarianceLines, 0);
    assert.deepEqual(p.stock.linesMissingReason, []);
    assert.deepEqual(p.prospectiveVariances, []);
  });

  test("derives satisfaction without persisting satisfiedByLineId", async () => {
    const h = await freshHandover();
    const started = await startCount(h.handoverId);
    for (const key of ITEM_KEYS) {
      await fillLine(started.countSessionId, items[key].id, { counted: 6, expected: 6 });
    }

    const p = await position(h.handoverId);
    assert.equal(p.required.satisfied, 3);
    assert.deepEqual(p.required.missingItemIds, []);
    assert.equal(
      await db.handoverRequiredItem.count({
        where: { handoverId: h.handoverId, satisfiedByLineId: { not: null } },
      }),
      0,
      "SH-20 owns satisfiedByLineId; SH-18 may only derive satisfaction",
    );
  });

  test("measures variance through effective evidence", async () => {
    const h = await freshHandover();
    const started = await startCount(h.handoverId);
    const reason = await stockReason("correction");
    const alphaLine = await fillLine(started.countSessionId, items.alpha.id, {
      counted: 10,
      expected: 12,
      reasonCodeId: reason.id,
    });
    await fillLine(started.countSessionId, items.bravo.id, { counted: 4, expected: 4 });
    await fillLine(started.countSessionId, items.charlie.id, { counted: 7, expected: 7 });

    // An approved correction supersedes the figure without a second look at
    // the shelf: the corrected quantity is what the business acts on.
    await db.stockCountCorrection.create({
      data: {
        lineId: alphaLine,
        oldCountedQuantity: 10,
        newCountedQuantity: 8,
        reasonCodeId: reason.id,
        actorId: fx.cashier.id,
        status: "APPROVED",
        approvedById: fx.manager.id,
        approvedAt: new Date(),
      },
    });

    const p = await position(h.handoverId);
    assert.equal(p.stock.nonZeroVarianceLines, 1);
    assert.equal(p.prospectiveVariances.length, 1);
    const entry = p.prospectiveVariances[0];
    assert.equal(entry.lineId, alphaLine);
    assert.equal(
      entry.quantityVariance,
      -4,
      "the corrected 8 against an expected 12, not the original 10",
    );
    assert.equal(entry.reasonPresent, true);
  });

  test("reports an unavailable amount as null, never zero", async () => {
    const h = await freshHandover();
    const started = await startCount(h.handoverId);
    const reason = await stockReason("unpriced");
    await fillLine(started.countSessionId, items.alpha.id, {
      counted: 5,
      expected: 8,
      reasonCodeId: reason.id,
      costImpact: null,
      costImpactAvailable: false,
    });
    await fillLine(started.countSessionId, items.bravo.id, {
      counted: 3,
      expected: 5,
      reasonCodeId: reason.id,
      costImpact: 90,
      costImpactAvailable: true,
    });
    await fillLine(started.countSessionId, items.charlie.id, { counted: 7, expected: 7 });

    const p = await position(h.handoverId);
    const byItem = new Map(
      await Promise.all(
        p.prospectiveVariances.map(async (v) => {
          const line = await db.stockCountLine.findUniqueOrThrow({
            where: { id: v.lineId },
            select: { inventoryItemId: true },
          });
          return [line.inventoryItemId, v] as const;
        }),
      ),
    );
    assert.equal(byItem.get(items.alpha.id)!.amountVariance, null);
    assert.equal(byItem.get(items.bravo.id)!.amountVariance, 90);
    assert.equal(p.stock.nonZeroVarianceLines, 2);
  });

  test("lists pre-existing branch cases and excludes this count's lines", async () => {
    const h = await freshHandover();
    const started = await startCount(h.handoverId);
    for (const key of ITEM_KEYS) {
      await fillLine(started.countSessionId, items[key].id, { counted: 6, expected: 6 });
    }
    const ownLine = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId: started.countSessionId },
      select: { id: true },
    });

    // An unrelated count at the same branch, and a case raised from it.
    const unrelated = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        type: "CRITICAL",
        status: "CONFIRMED",
        scopeDerivation: "CRITICAL_ONLY",
        initiatedById: fx.cashier.id,
        confirmedAt: new Date(),
        lines: {
          create: [{ inventoryItemId: ordinaryItemId, unit: "KG", disposition: "PENDING" }],
        },
      },
      select: { id: true, lines: { select: { id: true } } },
    });
    const foreignCase = await db.varianceCase.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        type: "STOCK",
        status: "OPEN",
        stockCountLineId: unrelated.lines[0].id,
        openedById: fx.manager.id,
      },
    });
    // A case with no line at all — a cash difference — is still a
    // pre-existing case at this branch and must not vanish into SQL's NULL.
    const cashCase = await db.varianceCase.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        type: "CASH",
        status: "UNDER_INVESTIGATION",
        shiftId: h.shiftId,
        openedById: fx.manager.id,
      },
    });
    // And one raised from THIS count's own line, which is not "pre-existing".
    const ownCase = await db.varianceCase.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        type: "STOCK",
        status: "OPEN",
        stockCountLineId: ownLine.id,
        openedById: fx.manager.id,
      },
    });

    const p = await position(h.handoverId);
    assert.ok(p.openVarianceCaseIds.includes(foreignCase.id));
    assert.ok(p.openVarianceCaseIds.includes(cashCase.id));
    assert.ok(
      !p.openVarianceCaseIds.includes(ownCase.id),
      "a case raised from this count's own line is not a pre-existing one",
    );
  });
});

// ─────────────────────────────── T3 · submit ─────────────────────────────
//
// The rule this block exists to pin: EVERY non-zero variance needs a reason,
// whatever tolerance says and whatever the blocking policy says. Tolerance
// answers "is this worth investigating"; a handover asks "what do you say
// happened", and "it was within tolerance" is not an answer to that.

type Refused = InstanceType<HandoverLib["HandoverSubmitRefusedError"]>;

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

/**
 * The refusal a submit produced, or a failure saying it produced none.
 *
 * The shape is checked rather than assumed: any thrown value would otherwise
 * satisfy a test whose point is that the REFUSAL carried its evidence.
 */
async function refusalFrom(handoverId: string): Promise<Refused> {
  try {
    await submit(handoverId);
  } catch (error) {
    const refused = error as Refused;
    assert.ok(
      Array.isArray(refused?.refusals) && refused?.position !== undefined,
      `expected a HandoverSubmitRefusedError carrying its evidence, got: ${String(error)}`,
    );
    return refused;
  }
  throw new Error("expected the submit to be refused, but it succeeded");
}

const codesOf = (r: Refused) => r.refusals.map((x) => x.code).sort();

/**
 * Delete a required item's line out from under the bound session.
 *
 * A CORRUPTION, deliberately, and the only way to reach `REQUIRED_ITEMS_MISSING`
 * at submit any more. `startHandoverCount` builds one line per required item
 * from the immutable snapshot, so a required item with no line cannot happen
 * through any sequence of real actions — which is exactly why the refusal now
 * fires on it. A shelf nobody reached is a gap the count can state (see "a
 * count with shelves nobody reached still states a position"); a required item
 * with no line at all means the bound session is not the count this handover
 * planned, and nobody can count their way out of that.
 */
async function unlinkRequiredItem(sessionId: string, inventoryItemId: string) {
  const line = await db.stockCountLine.findFirstOrThrow({
    where: { sessionId, inventoryItemId },
    select: { id: true },
  });
  await db.handoverStockAcknowledgement.deleteMany({ where: { stockCountLineId: line.id } });
  await db.stockCountLine.delete({ where: { id: line.id } });
}

type FillSpec = Parameters<typeof fillLine>[2] & { itemId: string };

/** A bound count in a stated status, with the given lines written. */
async function boundCount(
  h: Handover,
  specs: FillSpec[],
  status: "DRAFT" | "SUBMITTED" | "CONFIRMED" = "CONFIRMED",
) {
  const started = await startCount(h.handoverId);
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
          ? { confirmedAt: new Date(), confirmedById: fx.cashier.id }
          : {}),
      },
    });
  }
  return started.countSessionId;
}

describe("submit", () => {
  test("returns every applicable refusal in one result", async () => {
    const h = await freshHandover();
    const sessionId = await boundCount(
      h,
      [
        // A difference nobody explained…
        { itemId: items.alpha.id, counted: 8, expected: 10 },
        { itemId: items.bravo.id, counted: 4, expected: 4 },
      ],
      "SUBMITTED", // …on a count nobody confirmed.
    );
    // …and charlie has no line at all, which is the integrity gap.
    await unlinkRequiredItem(sessionId, items.charlie.id);

    const refused = await refusalFrom(h.handoverId);
    assert.equal(refused.status, 409);
    assert.deepEqual(codesOf(refused), [
      "COUNT_NOT_CONFIRMED",
      "REQUIRED_ITEMS_MISSING",
      "VARIANCE_REASON_MISSING",
    ]);
    assert.equal(
      new Set(codesOf(refused)).size,
      refused.refusals.length,
      "a code may appear at most once",
    );
    assert.equal(refused.position.handoverId, h.handoverId);
    assert.equal(refused.position.required.total, 3);
  });

  test("a count with shelves nobody reached still states a position, and names the gap", async () => {
    // SH-21 reachability. Stating a closing position with a gap in it is a
    // legitimate act: the outgoing hand says what they saw AND says what they
    // did not. Refusing here made SH-20's step-5 refusal and SH-21's manager
    // exception unreachable — the state they act on could not be produced by
    // any sequence of real actions, only by deleting a row.
    //
    // The gap does not vanish; it moves to where somebody answers for it. The
    // position still names all three unreached items, the incoming custodian
    // reviews them, and the ACCEPTANCE is where the refusal now lives.
    const h = await freshHandover();
    await boundCount(h, [
      { itemId: items.alpha.id, counted: 6, expected: 6 },
      // bravo and charlie keep their lines and stay PENDING — in scope,
      // nobody reached them.
    ]);

    const result = await submit(h.handoverId);
    assert.equal(result.status, "OUTGOING_SUBMITTED");
    assert.equal(result.alreadySubmitted, false);
    assert.deepEqual(
      [...result.position.required.missingItemIds].sort(),
      [items.bravo.id, items.charlie.id].sort(),
      "the evidence gap is stated, not erased",
    );
    assert.deepEqual(result.position.required.unlinkedItemIds, [], "and every item has a line");
    assert.equal(result.position.required.satisfied, 1);
    assert.equal(result.position.stock.uncountedActiveItems, 2);

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, submittedAt: true, acceptedAt: true, completedAt: true },
    });
    assert.equal(handover.status, "OUTGOING_SUBMITTED");
    assert.ok(handover.submittedAt !== null);

    // Nothing irreversible followed from it. A stated position is a claim,
    // not a transfer.
    assert.equal(handover.acceptedAt, null);
    assert.equal(handover.completedAt, null);
    assert.equal(
      await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }), 0,
      "no boundary",
    );
    assert.equal(
      await db.stockCountRebase.count({ where: { line: { session: { handoverId: h.handoverId } } } }),
      0,
      "no rebase",
    );
    assert.equal(
      await db.inventoryFreeze.count({
        where: { handoverId: h.handoverId, releasedAt: { not: null } },
      }),
      0,
      "the freeze is still on",
    );
    assert.equal(
      await db.handoverRequiredItem.count({ where: { handoverId: h.handoverId, omitted: true } }),
      0,
      "and no omission was committed — that is the acceptance's to decide",
    );
    const outgoing = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.notEqual(outgoing.status, "CLOSED", "the outgoing shift is not stock-closed");
  });

  test("refuses COUNT_NOT_CONFIRMED", async () => {
    const h = await freshHandover();
    await boundCount(
      h,
      ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 6, expected: 6 })),
      "SUBMITTED",
    );

    const refused = await refusalFrom(h.handoverId);
    assert.deepEqual(codesOf(refused), ["COUNT_NOT_CONFIRMED"]);

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, submittedAt: true },
    });
    assert.equal(handover.status, "DRAFT");
    assert.equal(handover.submittedAt, null);
  });

  test("refuses REQUIRED_ITEMS_MISSING and names the items", async () => {
    const h = await freshHandover();
    const sessionId = await boundCount(h, [
      { itemId: items.alpha.id, counted: 6, expected: 6 },
    ]);
    // bravo and charlie have no lines: the count bound here is not the count
    // this handover planned.
    await unlinkRequiredItem(sessionId, items.bravo.id);
    await unlinkRequiredItem(sessionId, items.charlie.id);

    const refused = await refusalFrom(h.handoverId);
    assert.deepEqual(codesOf(refused), ["REQUIRED_ITEMS_MISSING"]);
    const missing = refused.refusals.find((r) => r.code === "REQUIRED_ITEMS_MISSING")!;
    assert.deepEqual([...missing.ids].sort(), [items.bravo.id, items.charlie.id].sort());
    assert.equal(missing.count, 2);
    assert.ok(
      missing.message.includes(items.bravo.name) && missing.message.includes(items.charlie.name),
      `the refusal must name the items, got: ${missing.message}`,
    );
  });

  test("an inside-tolerance non-zero variance still requires a reason", async () => {
    const h = await freshHandover();
    // A bound so wide the difference below is comfortably inside it.
    const rule = await db.toleranceRule.create({
      data: { cafeId: fx.cafeId, scope: "CAFE", quantityTolerance: 50, percentTolerance: 90 },
    });
    try {
      await boundCount(h, [
        { itemId: items.alpha.id, counted: 8, expected: 10 },
        { itemId: items.bravo.id, counted: 4, expected: 4 },
        { itemId: items.charlie.id, counted: 7, expected: 7 },
      ]);

      const refused = await refusalFrom(h.handoverId);
      assert.deepEqual(
        codesOf(refused),
        ["VARIANCE_REASON_MISSING"],
        "tolerance answers a different question and may not excuse a missing reason",
      );
      const missing = refused.refusals.find((r) => r.code === "VARIANCE_REASON_MISSING")!;
      assert.equal(missing.ids.length, 1);
      assert.deepEqual(missing.ids, refused.position.stock.linesMissingReason);
    } finally {
      await db.toleranceRule.delete({ where: { id: rule.id } });
    }
  });

  test("zero variance requires no reason", async () => {
    const h = await freshHandover();
    await boundCount(
      h,
      ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 6, expected: 6 })),
    );

    const result = await submit(h.handoverId);
    assert.equal(result.status, "OUTGOING_SUBMITTED");
    assert.equal(result.alreadySubmitted, false);
    assert.equal(result.position.stock.nonZeroVarianceLines, 0);
    assert.deepEqual(result.position.stock.linesMissingReason, []);
  });

  test("a very large priced variance with a valid reason submits", async () => {
    const h = await freshHandover();
    // The café's policy says a priced difference of 1 or more stops a
    // handover. The submit predicate must not be reading it.
    await db.cafeSettings.update({
      where: { cafeId: fx.cafeId },
      data: { varianceBlocksHandover: true, varianceHardBlockAmount: 1 },
    });
    const reason = await stockReason("large-shortage");
    await boundCount(h, [
      {
        itemId: items.alpha.id,
        counted: 0,
        expected: 500,
        reasonCodeId: reason.id,
        costImpact: 99999,
        costImpactAvailable: true,
      },
      { itemId: items.bravo.id, counted: 4, expected: 4 },
      { itemId: items.charlie.id, counted: 7, expected: 7 },
    ]);

    const result = await submit(h.handoverId);
    assert.equal(result.status, "OUTGOING_SUBMITTED");
    assert.equal(result.position.stock.nonZeroVarianceLines, 1);
    const entry = result.position.prospectiveVariances[0];
    assert.equal(entry.quantityVariance, -500);
    assert.equal(entry.amountVariance, 99999);
    assert.equal(entry.reasonPresent, true);
  });

  test("existing OPEN and UNDER_INVESTIGATION cases do not block", async () => {
    const h = await freshHandover();
    await boundCount(
      h,
      ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 6, expected: 6 })),
    );

    const unrelated = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        type: "CRITICAL",
        status: "CONFIRMED",
        scopeDerivation: "CRITICAL_ONLY",
        initiatedById: fx.cashier.id,
        confirmedAt: new Date(),
        lines: {
          create: [{ inventoryItemId: ordinaryItemId, unit: "KG", disposition: "PENDING" }],
        },
      },
      select: { lines: { select: { id: true } } },
    });
    const openCase = await db.varianceCase.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        type: "STOCK",
        status: "OPEN",
        blocking: true,
        financialImpact: 5000,
        financialImpactAvailable: true,
        amountVariance: -5000,
        stockCountLineId: unrelated.lines[0].id,
        openedById: fx.manager.id,
      },
    });
    const investigating = await db.varianceCase.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        type: "CASH",
        status: "UNDER_INVESTIGATION",
        blocking: true,
        shiftId: h.shiftId,
        openedById: fx.manager.id,
      },
    });

    const result = await submit(h.handoverId);
    assert.equal(result.status, "OUTGOING_SUBMITTED");
    assert.ok(result.position.openVarianceCaseIds.includes(openCase.id));
    assert.ok(result.position.openVarianceCaseIds.includes(investigating.id));
  });

  test("moves DRAFT to OUTGOING_SUBMITTED and sets submittedAt", async () => {
    const h = await freshHandover();
    await boundCount(
      h,
      ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 6, expected: 6 })),
    );

    await submit(h.handoverId);
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: {
        status: true,
        submittedAt: true,
        reviewedAt: true,
        acceptedAt: true,
        completedAt: true,
        rejectedAt: true,
        resolvedTarget: true,
        acceptedStockCountSessionId: true,
      },
    });
    assert.equal(handover.status, "OUTGOING_SUBMITTED");
    assert.ok(handover.submittedAt instanceof Date);
    assert.equal(handover.reviewedAt, null);
    assert.equal(handover.acceptedAt, null);
    assert.equal(handover.completedAt, null);
    assert.equal(handover.rejectedAt, null);
    assert.equal(handover.resolvedTarget, null);
    assert.equal(handover.acceptedStockCountSessionId, null);

    // The later-stage stock facts are still nobody's.
    assert.equal(await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }), 0);
    assert.equal(
      await db.handoverStockAcknowledgement.count({ where: { handoverId: h.handoverId } }),
      0,
    );
    const shift = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(shift.status, "AWAITING_HANDOVER");
    assert.equal(shift.stockClosedAt, null);
    const freeze = await db.inventoryFreeze.findUniqueOrThrow({ where: { id: h.freezeId } });
    assert.equal(freeze.releasedAt, null);
  });

  test("a refused submit writes nothing", async () => {
    const h = await freshHandover();
    const sessionId = await boundCount(
      h,
      [
        { itemId: items.alpha.id, counted: 8, expected: 10 },
        { itemId: items.bravo.id, counted: 4, expected: 4 },
        { itemId: items.charlie.id, counted: 7, expected: 7 },
      ],
    );
    const handoverBefore = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
    });
    const sessionBefore = await db.stockCountSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const requiredBefore = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId },
      orderBy: { id: "asc" },
    });

    await refusalFrom(h.handoverId);

    assert.deepEqual(
      await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } }),
      handoverBefore,
    );
    assert.deepEqual(
      await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } }),
      sessionBefore,
    );
    assert.deepEqual(
      await db.handoverRequiredItem.findMany({
        where: { handoverId: h.handoverId },
        orderBy: { id: "asc" },
      }),
      requiredBefore,
    );
  });

  test("a repeated submit is idempotent", async () => {
    const h = await freshHandover();
    await boundCount(
      h,
      ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 6, expected: 6 })),
    );

    const first = await submit(h.handoverId);
    const stamped = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { submittedAt: true },
    });

    const second = await submit(h.handoverId);
    assert.equal(first.alreadySubmitted, false);
    assert.equal(second.alreadySubmitted, true);
    assert.equal(second.status, "OUTGOING_SUBMITTED");
    assert.equal(second.position.handoverId, h.handoverId);

    const after = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { submittedAt: true },
    });
    assert.deepEqual(after.submittedAt, stamped.submittedAt);
  });

  test("submitHandover depends on no blocking policy and no tolerance", () => {
    const source = readFileSync("src/lib/handover.ts", "utf8");
    for (const pattern of [
      /\bcaseIsBlocking\b/,
      /\bwithinTolerance\b/,
      /\bresolveStockTolerance\b/,
      /from\s+["']@\/lib\/tolerance["']/,
      /from\s+["']@\/lib\/variance-case["']/,
    ]) {
      assert.ok(
        !pattern.test(source),
        `src/lib/handover.ts must not reach for ${pattern}: a handover asks what happened, not whether it was tolerable`,
      );
    }
  });
});

// ────────────────────── T4 · incoming blind review ───────────────────────
//
// The reviewer counts before they are told what to find, or the count they
// take is not evidence. `redactCountTargets` cannot deliver that here and the
// tests are built so a naive call to it fails: the bound session is CONFIRMED
// and the reviewer neither started it nor counted a line, so `countIsBlindTo`
// is false and the redactor is a no-op. Blindness has to be in the shape of
// the response.

/** The nine keys a pre-acknowledgement view may not contain, at any depth. */
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
 *
 * The live object is walked directly rather than through `JSON.stringify`,
 * because a leaked `itemVersion` is a BigInt and would make serialisation
 * throw before the assertion could name the field.
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

async function incomingView(
  handoverId: string,
  overrides: Partial<{ viewerId: string; cafeId: string; viewerBranchId: string | null }> = {},
) {
  const { incomingHandoverView } = await handoverLib();
  return incomingHandoverView(handoverId, overrides.viewerId ?? fx.manager.id, {
    cafeId: overrides.cafeId ?? fx.cafeId,
    viewerBranchId:
      overrides.viewerBranchId === undefined ? fx.branchId : overrides.viewerBranchId,
  });
}

/** A handover that has actually been submitted, with its confirmed evidence. */
async function submittedHandover(
  specs?: FillSpec[],
): Promise<Handover & { sessionId: string }> {
  const h = await freshHandover();
  const sessionId = await boundCount(
    h,
    specs ?? ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 6, expected: 6 })),
  );
  await submit(h.handoverId);
  return { ...h, sessionId };
}

/** The reviewer takes their own look at one line. SH-19 writes these for real. */
async function acknowledgeOneLine(handoverId: string, sessionId: string) {
  const line = await db.stockCountLine.findFirstOrThrow({
    where: { sessionId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return db.handoverStockAcknowledgement.create({
    data: {
      handoverId,
      stockCountLineId: line.id,
      incomingCountedQuantity: 6,
      handedOverQuantity: 6,
      varianceQuantity: 0,
      decision: "ACCEPTED",
      acknowledgedById: fx.manager.id,
    },
  });
}

describe("incoming blind review", () => {
  test("pre-acknowledgement, no quantity key exists anywhere in the view", async () => {
    const h = await submittedHandover([
      // A real, priced, non-zero difference — the most valuable thing to leak.
      {
        itemId: items.alpha.id,
        counted: 2,
        expected: 9,
        reasonCodeId: (await stockReason("blind-leak")).id,
        costImpact: 1234,
        costImpactAvailable: true,
      },
      { itemId: items.bravo.id, counted: 4, expected: 4 },
      { itemId: items.charlie.id, counted: 7, expected: 7 },
    ]);

    const view = await incomingView(h.handoverId);
    assert.equal(view.acknowledged, false);
    assertNoQuantityKeys(view);
    assert.equal(view.count?.sessionId, h.sessionId);
    assert.equal(view.count?.status, "CONFIRMED");
    assert.equal(
      view.count?.lines.length,
      3,
      "blindness withholds the figures, not the existence of the lines",
    );
  });

  test("pre-acknowledgement still shows what there is to review", async () => {
    const h = await submittedHandover();
    const view = await incomingView(h.handoverId);

    assert.equal(view.handoverId, h.handoverId);
    assert.equal(view.status, "OUTGOING_SUBMITTED");
    assert.equal(view.branchId, fx.branchId);
    assert.equal(view.target, "SHIFT_TO_SHIFT");
    assert.equal(view.mode, "SELECTED");
    assert.equal(view.requiredItemTrigger, "REGULAR_MODE");
    assert.equal(view.outgoingUserId, fx.cashier.id);
    assert.ok(view.submittedAt instanceof Date);

    assert.equal(view.requiredItems.length, 3);
    const alpha = view.requiredItems.find((r) => r.inventoryItemId === items.alpha.id)!;
    assert.equal(alpha.itemNameSnapshot, items.alpha.name);
    assert.equal(alpha.unitSnapshot, "KG");
    assert.equal(alpha.isCriticalSnapshot, true);

    const lines = view.count!.lines as Array<Record<string, unknown>>;
    for (const line of lines) {
      assert.ok(line.id, "a reviewer needs the line to acknowledge against");
      assert.ok(line.inventoryItemId);
      assert.ok(line.unit);
      assert.ok(line.disposition);
      assert.ok(line.countedAt, "whether it was counted is not a target");
      assert.ok((line.inventoryItem as { name?: string })?.name);
    }
  });

  test("post-acknowledgement discloses the count through the existing redactor", async () => {
    const h = await submittedHandover([
      { itemId: items.alpha.id, counted: 2, expected: 9, reasonCodeId: (await stockReason("ack")).id },
      { itemId: items.bravo.id, counted: 4, expected: 4 },
      { itemId: items.charlie.id, counted: 7, expected: 7 },
    ]);
    await acknowledgeOneLine(h.handoverId, h.sessionId);

    // The reviewer neither initiated the session nor counted a line, so the
    // existing redactor lets them see it once they have looked for themselves.
    const view = await incomingView(h.handoverId, { viewerId: fx.manager.id });
    assert.equal(view.acknowledged, true);
    const lines = view.count!.lines as Array<Record<string, unknown>>;
    const alphaLine = lines.find((l) => l.inventoryItemId === items.alpha.id)!;
    assert.ok("expectedQuantity" in alphaLine);
    assert.ok("varianceQuantity" in alphaLine);
    assert.ok("effectiveCountedQuantity" in alphaLine);
    assert.equal(Number(alphaLine.expectedQuantity), 9);
    assert.equal(Number(alphaLine.varianceQuantity), -7);
  });

  test("the redaction rule is the existing one", async () => {
    const h = await freshHandover();
    const sessionId = await boundCount(
      h,
      ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 6, expected: 6 })),
    );
    await submit(h.handoverId);
    // A still-blind session, and a viewer who is its initiator: the one case
    // `countIsBlindTo` is actually true for.
    await db.stockCountSession.update({
      where: { id: sessionId },
      data: { status: "DRAFT", mode: "BLIND", confirmedAt: null, confirmedById: null },
    });
    await acknowledgeOneLine(h.handoverId, sessionId);

    const view = await incomingView(h.handoverId, { viewerId: fx.cashier.id });
    assert.equal(view.acknowledged, true);

    const { getCountSessionForViewer } = await import("@/lib/stock-count");
    const reference = await getCountSessionForViewer({
      sessionId,
      cafeId: fx.cafeId,
      viewerId: fx.cashier.id,
      viewerBranchId: fx.branchId,
    });
    assert.equal(reference.blind, true, "the fixture must exercise a genuinely blind session");

    const referenceLine = reference.lines[0] as Record<string, unknown>;
    const viewLine = (view.count!.lines as Array<Record<string, unknown>>).find(
      (l) => l.id === referenceLine.id,
    )!;
    for (const field of ["expectedQuantity", "varianceQuantity", "costImpact"]) {
      assert.equal(
        field in viewLine,
        field in referenceLine,
        `${field} must be withheld by exactly the rule the count route already applies`,
      );
      assert.equal(field in viewLine, false);
    }
  });

  test("refuses statuses outside the review window", async () => {
    const reason = await db.reasonCode.create({
      data: { cafeId: fx.cafeId, domain: "HANDOVER", code: `${MARKER}-REV`, label: "refused" },
    });

    // DRAFT: there is nothing to review yet.
    const draft = await freshHandover();
    await assert.rejects(incomingView(draft.handoverId), statusIs(409), "DRAFT must refuse");

    for (const status of ["ACCEPTED", "COMPLETED", "MANAGER_EXCEPTION", "REJECTED"] as const) {
      const h = await submittedHandover();
      await db.handoverSession.update({
        where: { id: h.handoverId },
        data: {
          status,
          ...(status === "REJECTED"
            ? { rejectedAt: new Date(), rejectionReasonCodeId: reason.id }
            : {}),
          ...(status === "MANAGER_EXCEPTION"
            ? { exceptionById: fx.manager.id, exceptionAt: new Date(), exceptionReason: "test" }
            : {}),
          ...(status === "ACCEPTED" ? { acceptedAt: new Date() } : {}),
          ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
        },
      });
      await assert.rejects(incomingView(h.handoverId), statusIs(409), `${status} must refuse`);
    }
  });

  test("enforces tenancy and branch scope", async () => {
    const h = await submittedHandover();

    // Another tenant's handover is not confirmed to exist at all.
    await assert.rejects(
      incomingView(h.handoverId, { cafeId: other.cafeId }),
      statusIs(404),
    );
    await assert.rejects(
      incomingView(otherHandoverId, { cafeId: fx.cafeId }),
      statusIs(404),
    );
    // The café is the viewer's; the branch is not.
    await assert.rejects(
      incomingView(h.handoverId, { viewerBranchId: fx.otherBranchId }),
      statusIs(403),
    );
  });

  test("viewing writes nothing", async () => {
    const h = await submittedHandover();
    const before = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    const sessionBefore = await db.stockCountSession.findUniqueOrThrow({
      where: { id: h.sessionId },
    });

    await incomingView(h.handoverId);
    await incomingView(h.handoverId, { viewerId: fx.storekeeper.id });

    assert.deepEqual(
      await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } }),
      before,
    );
    assert.deepEqual(
      await db.stockCountSession.findUniqueOrThrow({ where: { id: h.sessionId } }),
      sessionBefore,
    );
    assert.equal(
      await db.handoverStockAcknowledgement.count({ where: { handoverId: h.handoverId } }),
      0,
      "SH-19 writes acknowledgements; looking at a handover must not",
    );
    assert.equal(before.reviewedAt, null);
    assert.equal(await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }), 0);
    assert.equal(
      await db.handoverRequiredItem.count({
        where: { handoverId: h.handoverId, satisfiedByLineId: { not: null } },
      }),
      0,
    );
  });
});

// ──────────────────────────────── T5 · routes ────────────────────────────
//
// Two actions, one handover named explicitly, and nothing else accepted. The
// route may not infer WHICH handover from the branch: a café with a handover
// open is exactly the situation where guessing is most plausible and most
// dangerous, and there is no code path here that creates a `HandoverSession`.

const post = <T = Record<string, unknown>>(email: string, body: unknown) =>
  as<T>(email, "/api/handovers", { method: "POST", body: JSON.stringify(body) });

describe("routes", () => {
  test("POST start_count returns the bound session", async () => {
    const h = await freshHandover();
    const r = await post<{ countSession: { id: string; type: string; scopeItemIds: string[]; reused: boolean } }>(
      fx.cashier.email,
      { action: "start_count", handoverId: h.handoverId },
    );

    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.countSession.reused, false);
    assert.equal(r.body.countSession.type, "CRITICAL");
    assert.deepEqual(
      [...r.body.countSession.scopeItemIds].sort(),
      [...h.requiredItemIds].sort(),
    );
    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: r.body.countSession.id },
      select: { accountabilityContext: true, handoverId: true },
    });
    assert.equal(session.accountabilityContext, "HANDOVER");
    assert.equal(session.handoverId, h.handoverId);
  });

  test("POST submit returns the closing position", async () => {
    const h = await freshHandover();
    await boundCount(
      h,
      ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 6, expected: 6 })),
    );

    const r = await post<{
      status: string;
      alreadySubmitted: boolean;
      position: { handoverId: string; required: { total: number } };
    }>(fx.cashier.email, { action: "submit", handoverId: h.handoverId });

    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, "OUTGOING_SUBMITTED");
    assert.equal(r.body.alreadySubmitted, false);
    assert.equal(r.body.position.handoverId, h.handoverId);
    assert.equal(r.body.position.required.total, 3);
  });

  test("POST refuses an unknown key", async () => {
    const h = await freshHandover();
    const before = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });

    const r = await post<{ error: string }>(fx.cashier.email, {
      action: "submit",
      handoverId: h.handoverId,
      countedQuantity: 5,
    });

    assert.equal(r.status, 400, r.text);
    assert.ok(
      r.body.error.includes("countedQuantity"),
      `the refusal must name the unrecognised key, got: ${r.body.error}`,
    );
    assert.deepEqual(
      await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } }),
      before,
    );
  });

  test("POST refuses an unknown action and creates no handover", async () => {
    const h = await freshHandover();
    const handoversBefore = await db.handoverSession.count();

    for (const body of [
      { action: "start", handoverId: h.handoverId },
      { action: "accept", handoverId: h.handoverId },
      { action: "start_count" },
    ]) {
      const r = await post(fx.cashier.email, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.text}`);
    }

    assert.equal(
      await db.handoverSession.count(),
      handoversBefore,
      "no route action may create a HandoverSession — the close is its only writer",
    );
  });

  test("POST requires handover.submit; GET requires handover.view", async () => {
    const h = await freshHandover();

    for (const action of ["start_count", "submit"] as const) {
      const r = await post(viewerOnly.email, { action, handoverId: h.handoverId });
      assert.equal(r.status, 403, `${action} -> ${r.text}`);
    }
    // The same account can still read.
    const readable = await as(viewerOnly.email, `/api/handovers?branchId=${fx.branchId}`);
    assert.equal(readable.status, 200, readable.text);

    // A waiter holds no handover key at all.
    const denied = await as(fx.waiter.email, `/api/handovers?branchId=${fx.branchId}`);
    assert.equal(denied.status, 403, denied.text);
    const deniedDetail = await as(fx.waiter.email, `/api/handovers/${h.handoverId}`);
    assert.equal(deniedDetail.status, 403, deniedDetail.text);
  });

  test("GET /api/handovers lists without a single quantity", async () => {
    const mine = await freshHandover();
    const annex = await freshHandover(fx, fx.otherBranchId);

    const r = await as<{ handovers: Array<{ id: string; branchId: string }> }>(
      fx.manager.email,
      "/api/handovers",
    );
    assert.equal(r.status, 200, r.text);
    assertNoQuantityKeys(r.body.handovers, "handovers");

    const ids = r.body.handovers.map((x) => x.id);
    assert.ok(ids.includes(mine.handoverId));
    assert.ok(
      !ids.includes(annex.handoverId),
      "a branch-pinned reader sees their own branch and no other",
    );
    assert.ok(!ids.includes(otherHandoverId), "another café's handovers are not listed");
    for (const row of r.body.handovers) assert.equal(row.branchId, fx.branchId);

    // The status filter narrows rather than widens.
    const filtered = await as<{ handovers: Array<{ id: string; status: string }> }>(
      fx.manager.email,
      "/api/handovers?status=OUTGOING_SUBMITTED",
    );
    assert.equal(filtered.status, 200, filtered.text);
    for (const row of filtered.body.handovers) assert.equal(row.status, "OUTGOING_SUBMITTED");
  });

  test("GET /api/handovers/[id] is the blind review over HTTP", async () => {
    const h = await submittedHandover([
      {
        itemId: items.alpha.id,
        counted: 2,
        expected: 9,
        reasonCodeId: (await stockReason("http-blind")).id,
        costImpact: 4321,
        costImpactAvailable: true,
      },
      { itemId: items.bravo.id, counted: 4, expected: 4 },
      { itemId: items.charlie.id, counted: 7, expected: 7 },
    ]);

    const r = await as<{ handover: { acknowledged: boolean; count: { lines: unknown[] } } }>(
      fx.manager.email,
      `/api/handovers/${h.handoverId}`,
    );
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.handover.acknowledged, false);
    assertNoQuantityKeys(r.body.handover, "handover");
    // And the raw text, so no serialiser can smuggle one through a key the
    // walk did not visit.
    for (const key of QUANTITY_KEYS) {
      assert.ok(!r.text.includes(key), `the serialised body names ${key}`);
    }
    assert.equal(r.body.handover.count.lines.length, 3);

    // Another café's id is not confirmed to exist.
    const foreign = await as(fx.manager.email, `/api/handovers/${otherHandoverId}`);
    assert.equal(foreign.status, 404, foreign.text);
  });

  test("the refusal aggregate survives serialisation", async () => {
    const h = await freshHandover();
    const sessionId = await boundCount(
      h,
      [
        { itemId: items.alpha.id, counted: 8, expected: 10 },
        { itemId: items.bravo.id, counted: 4, expected: 4 },
      ],
      "SUBMITTED",
    );
    await unlinkRequiredItem(sessionId, items.charlie.id);

    const r = await post<{
      error: string;
      refusals: Array<{ code: string; count: number; ids: string[]; message: string }>;
      position: { required: { total: number } };
    }>(fx.cashier.email, { action: "submit", handoverId: h.handoverId });

    assert.equal(r.status, 409, r.text);
    assert.ok(Array.isArray(r.body.refusals));
    assert.deepEqual(r.body.refusals.map((x) => x.code).sort(), [
      "COUNT_NOT_CONFIRMED",
      "REQUIRED_ITEMS_MISSING",
      "VARIANCE_REASON_MISSING",
    ]);
    assert.ok(r.body.error, "the ordinary { error } shape is preserved beside the list");
    assert.equal(r.body.position.required.total, 3);
  });
});

// ───────────────────────────── T5 · concurrency ──────────────────────────
//
// Real PostgreSQL, two real HTTP requests in flight at once. The row lock and
// both partial unique indexes are exercised as the database, not as a mock:
// a serialisation bug here produces two counts of one shelf, or two
// transitions of one handover, and neither is visible to a single-threaded
// test.

describe("concurrency", () => {
  test("two simultaneous start_count requests yield one session", async () => {
    const h = await freshHandover();

    const [a, b] = await Promise.allSettled([
      post<{ countSession: { id: string } }>(fx.cashier.email, {
        action: "start_count",
        handoverId: h.handoverId,
      }),
      post<{ countSession: { id: string } }>(fx.cashier.email, {
        action: "start_count",
        handoverId: h.handoverId,
      }),
    ]);
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "fulfilled");
    const first = (a as PromiseFulfilledResult<Awaited<ReturnType<typeof post>>>).value;
    const second = (b as PromiseFulfilledResult<Awaited<ReturnType<typeof post>>>).value;
    assert.equal(first.status, 200, first.text);
    assert.equal(second.status, 200, second.text);

    const idA = (first.body as { countSession: { id: string } }).countSession.id;
    const idB = (second.body as { countSession: { id: string } }).countSession.id;
    assert.equal(idA, idB, "both callers must receive the same count");

    assert.equal(
      await db.stockCountSession.count({ where: { handoverId: h.handoverId } }),
      1,
      "exactly one session may exist for the handover",
    );
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { stockCountSessionId: true },
    });
    assert.equal(handover.stockCountSessionId, idA);
  });

  test("two simultaneous submits transition once", async () => {
    const h = await freshHandover();
    await boundCount(
      h,
      ITEM_KEYS.map((k) => ({ itemId: items[k].id, counted: 6, expected: 6 })),
    );

    const results = await Promise.allSettled([
      post<{ status: string; alreadySubmitted: boolean }>(fx.cashier.email, {
        action: "submit",
        handoverId: h.handoverId,
      }),
      post<{ status: string; alreadySubmitted: boolean }>(fx.cashier.email, {
        action: "submit",
        handoverId: h.handoverId,
      }),
    ]);
    for (const r of results) assert.equal(r.status, "fulfilled");
    const bodies = results.map(
      (r) => (r as PromiseFulfilledResult<{ status: number; body: { status: string; alreadySubmitted: boolean }; text: string }>).value,
    );
    for (const r of bodies) assert.equal(r.status, 200, r.text);
    for (const r of bodies) assert.equal(r.body.status, "OUTGOING_SUBMITTED");

    assert.equal(
      bodies.filter((r) => r.body.alreadySubmitted === false).length,
      1,
      "exactly one caller may perform the transition",
    );

    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { status: true, submittedAt: true },
    });
    assert.equal(handover.status, "OUTGOING_SUBMITTED");
    assert.ok(handover.submittedAt instanceof Date);
    assert.equal(
      await db.auditLog.count({
        where: { entityId: h.handoverId, action: "HANDOVER_SUBMITTED" },
      }),
      1,
      "one transition, one record of it",
    );
  });
});

// ─────────────────────── T6 · SH-17 reachability ─────────────────────────
//
// SH-17 built deferred accountability and nothing could reach it. A count
// answering to a handover confirms WITHOUT opening a single generic variance
// case, because a proposal nobody has accepted is not a finding to
// investigate and naming a custody on it would be an accusation made before
// the evidence was agreed. That behaviour has existed since SH-17 and had no
// caller: `POST /api/stock-counts` creates `accountabilityContext = NONE`.
//
// This block walks the real application path — every step an HTTP request,
// none a service call — and proves the deferral is now reachable, that it
// still opens nothing, and that the ordinary count path was left exactly as
// it was.

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

const patchLine = (email: string, sessionId: string, lineId: string, countedQuantity: number) =>
  as(email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify({ countedQuantity }),
  });

const submitCount = (email: string, sessionId: string) =>
  as<{ error?: string }>(email, `/api/stock-counts/${sessionId}/submit`, {
    method: "POST",
    body: "{}",
  });

const confirmCount = (email: string, sessionId: string, idempotencyKey: string) =>
  as<ConfirmBody>(email, `/api/stock-counts/${sessionId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey }),
  });

const acceptVariance = (email: string, sessionId: string, lineId: string, reasonCodeId: string) =>
  as<{ error?: string }>(
    email,
    `/api/stock-counts/${sessionId}/lines/${lineId}/accept-variance`,
    { method: "POST", body: JSON.stringify({ reasonCodeId }) },
  );

/**
 * The whole SH-18 → SH-17 walk, over HTTP.
 *
 * Capture leaves a line COUNTED, and `COUNTED → VARIANCE_CONFIRMED` is not a
 * legal move: submission is what turns a figure into a verdict, and only a
 * line already judged OUTSIDE_TOLERANCE — or sent to RECOUNT_REQUIRED by the
 * café's recount policy — may then be accepted. So the order is capture,
 * submit, accept, confirm: the same order `count-012` drives, and the one the
 * disposition map in `count-disposition.ts` permits.
 */
async function walkTheRealPath(h: Handover, reasonCodeId: string) {
  const started = await post<{ countSession: { id: string } }>(fx.cashier.email, {
    action: "start_count",
    handoverId: h.handoverId,
  });
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;

  const lines = await db.stockCountLine.findMany({
    where: { sessionId },
    select: { id: true, inventoryItemId: true },
  });
  assert.equal(lines.length, 3);

  // One deliberate, real difference; the rest exact.
  for (const line of lines) {
    const counted = line.inventoryItemId === items.alpha.id ? 3 : 0;
    const r = await patchLine(fx.manager.email, sessionId, line.id, counted);
    assert.ok(r.status < 300, `capture failed: ${r.text}`);
  }

  const submitted = await submitCount(fx.manager.email, sessionId);
  assert.ok(submitted.status < 300, `count submit failed: ${submitted.text}`);

  const unsettled = await db.stockCountLine.findMany({
    where: { sessionId, disposition: { in: ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"] } },
    select: { id: true },
  });
  assert.ok(unsettled.length > 0, "the fixture must produce a real difference to accept");
  for (const line of unsettled) {
    const r = await acceptVariance(fx.manager.email, sessionId, line.id, reasonCodeId);
    assert.ok(r.status < 300, `accept-variance failed: ${r.text}`);
  }

  return { sessionId, lineIds: lines.map((l) => l.id) };
}

describe("SH-17 reachability", () => {
  test("the real HTTP path reaches HANDOVER-bound confirmation", async () => {
    const h = await freshHandover();
    const reason = await stockReason("sh17-walk");
    const { sessionId, lineIds } = await walkTheRealPath(h, reason.id);

    // Bound, and bound to THIS handover.
    const bound = await db.stockCountSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { accountabilityContext: true, handoverId: true },
    });
    assert.equal(bound.accountabilityContext, "HANDOVER");
    assert.equal(bound.handoverId, h.handoverId);

    const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-walk-1`);
    assert.ok(confirmed.status < 300, `confirm failed: ${confirmed.text}`);
    assert.equal(confirmed.body.status, "CONFIRMED");

    // Deferred accountability, returned rather than acted on.
    assert.deepEqual(confirmed.body.deferred, {
      context: "HANDOVER",
      handoverId: h.handoverId,
      openingBranchCustodyPeriodId: null,
    });

    // And every later-stage field still nobody's.
    const handover = await db.handoverSession.findUniqueOrThrow({
      where: { id: h.handoverId },
      select: { acceptedStockCountSessionId: true, resolvedTarget: true, status: true },
    });
    assert.equal(handover.acceptedStockCountSessionId, null);
    assert.equal(handover.resolvedTarget, null);
    assert.equal(handover.status, "DRAFT");

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { lockedByHandoverId: true, openingBranchCustodyPeriodId: true },
    });
    assert.equal(session.lockedByHandoverId, null);
    assert.equal(session.openingBranchCustodyPeriodId, null);

    assert.equal(await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }), 0);
    assert.equal(
      await db.handoverRequiredItem.count({
        where: { handoverId: h.handoverId, satisfiedByLineId: { not: null } },
      }),
      0,
    );
    const freeze = await db.inventoryFreeze.findUniqueOrThrow({ where: { id: h.freezeId } });
    assert.equal(freeze.releasedAt, null);
    const shift = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(shift.status, "AWAITING_HANDOVER");
    assert.equal(shift.stockClosedAt, null);
    assert.ok(lineIds.length > 0);
  });

  test("contextual confirmation creates zero generic variance cases", async () => {
    const h = await freshHandover();
    const reason = await stockReason("sh17-nocases");
    const { sessionId, lineIds } = await walkTheRealPath(h, reason.id);

    const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-nocases-1`);
    assert.ok(confirmed.status < 300, confirmed.text);

    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: { in: lineIds } } }),
      0,
      "a handover-bound confirmation is a proposal, and opens no case",
    );
    assert.deepEqual(confirmed.body.varianceCaseIds, []);
  });

  test("confirmation returns deferred accountability on first call and on replay", async () => {
    const h = await freshHandover();
    const reason = await stockReason("sh17-replay");
    const { sessionId, lineIds } = await walkTheRealPath(h, reason.id);

    const key = `${MARKER}-replay-1`;
    const first = await confirmCount(fx.manager.email, sessionId, key);
    assert.ok(first.status < 300, first.text);
    assert.equal(first.body.alreadyConfirmed, false);

    const replay = await confirmCount(fx.manager.email, sessionId, key);
    assert.ok(replay.status < 300, replay.text);
    assert.equal(replay.body.alreadyConfirmed, true);
    assert.deepEqual(
      replay.body.deferred,
      first.body.deferred,
      "a retry that dropped the binding would leave acceptance nothing to key on",
    );
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: { in: lineIds } } }),
      0,
      "and still no case on the replay",
    );
  });

  test("an ordinary count start is still accountabilityContext NONE", async () => {
    // No handover, no freeze: the branch as it is on an ordinary day.
    await resetBranch(fx.branchId);
    const reason = await stockReason("ordinary");

    const started = await as<{ session: { id: string } }>(
      fx.manager.email,
      "/api/stock-counts",
      { method: "POST", body: JSON.stringify({ type: "CRITICAL" }) },
    );
    assert.equal(started.status, 201, started.text);
    const sessionId = started.body.session.id;

    const ordinary = await db.stockCountSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { accountabilityContext: true, handoverId: true },
    });
    assert.equal(ordinary.accountabilityContext, "NONE");
    assert.equal(ordinary.handoverId, null);

    const lines = await db.stockCountLine.findMany({
      where: { sessionId },
      select: { id: true, inventoryItemId: true },
    });
    for (const line of lines) {
      const counted = line.inventoryItemId === items.alpha.id ? 3 : 0;
      const r = await patchLine(fx.manager.email, sessionId, line.id, counted);
      assert.ok(r.status < 300, `capture failed: ${r.text}`);
    }
    const submitted = await submitCount(fx.manager.email, sessionId);
    assert.ok(submitted.status < 300, submitted.text);
    const unsettled = await db.stockCountLine.findMany({
      where: { sessionId, disposition: { in: ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"] } },
      select: { id: true },
    });
    for (const line of unsettled) {
      const r = await acceptVariance(fx.manager.email, sessionId, line.id, reason.id);
      assert.ok(r.status < 300, r.text);
    }

    const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-ordinary-1`);
    assert.ok(confirmed.status < 300, confirmed.text);
    assert.equal(
      confirmed.body.deferred,
      null,
      "a count answering to nobody defers nothing",
    );
    assert.ok(
      (confirmed.body.varianceCaseIds ?? []).length > 0,
      "and opens its cases the ordinary way, immediately",
    );
  });
});
