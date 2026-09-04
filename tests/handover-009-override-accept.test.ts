// HANDOVER-009 — SH-21: a manager may finish it, and the record says exactly
// what was skipped.
//
// SH-20 refuses an acceptance whose required set is incomplete. That refusal
// is correct, and it is also a trap: a branch whose count cannot be finished
// has a shift that cannot close, a custody that cannot be discharged and a
// shelf that stays frozen. SH-21 is the authorised way out, and the whole
// question is what it costs.
//
// What this suite pins:
//
//   * AN OVERRIDE IS NOT A COUNT. No `StockCountLine` is written for a missing
//     item, no previous figure is carried forward as though somebody had
//     looked, and no quantity is estimated. The item gets a `SYSTEM_CARRIED`
//     boundary flagged `verified: false`, which opens no variance case and
//     names nobody. A manager may waive the requirement to count; nobody may
//     waive having counted.
//
//   * TWO PEOPLE, NOT ONE. The manager authorises and the arriving cashier
//     receives. `exceptionById`, `OpeningException.authorizedById` and the
//     `HANDOVER_MANAGER_EXCEPTION` audit actor are the manager. The rebase,
//     the count lock, the variance cases, both custody transfers, the outgoing
//     `closedById` and the freeze release stay with the custodian, exactly as
//     SH-20 wrote them. A manager who signed the exception did not thereby
//     take the shelf.
//
//   * ONE REFUSAL IS BYPASSED AND NO OTHERS. The status, the SHIFT_TO_SHIFT
//     target, the bound CONFIRMED count, the acknowledgement of the current
//     round, the absence of a dispute, the outgoing custody, the arriving
//     shift and the freeze are all still required.
//
//   * `NO_INCOMING` IS A CLASSIFICATION. It says why the manager overrode. It
//     does not mean "finish with nobody arriving", does not reach BRANCH
//     custody and does not relax the USER recipient. A genuinely absent
//     recipient is SH-22.
//
//   * THE STATUS STAYS `COMPLETED`. The exception columns, the
//     `OpeningException` and the audit carry the manager-exception fact
//     precisely; a fourth terminal status would fork every downstream reader
//     on a distinction those three already record.
//
// ── HOW A REQUIRED ITEM GOES UNCOUNTED ──
//
// `settleRequiredItems` calls an item omitted when the accepted session has no
// LINE for it — not when a line is uncounted, because `submit` already refuses
// a session carrying a null figure, and not when the item leaves the count's
// scope, because `startHandoverCount` builds its lines from the required-item
// snapshot itself rather than from a fresh reading of configuration.
//
// So the gap is opened the way SH-20's own suite opens it, in
// `handover-008`'s "a required item with no line refuses the acceptance": the
// line disappears between the review and the acceptance. The items stay
// ACTIVE, so the boundary still owes each of them a row, and that row is the
// `SYSTEM_CARRIED` one this suite checks. Deactivating them instead would drop
// them from the boundary too, and would prove nothing about carried evidence.
//
// The rollback and concurrency matrices live in the sibling
// `handover-009b-override-rollback.test.ts`.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

const MARKER = tag("HANDOVER009");

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

// Six critical items. Three of them stop being critical after the close, and
// those three are the required set the count never reaches.
const ITEM_KEYS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] as const;
type ItemKey = (typeof ITEM_KEYS)[number];
const items: Record<ItemKey, { id: string; name: string }> = {} as never;
const DROPPED: readonly ItemKey[] = ["delta", "echo", "foxtrot"];

/** The arriving custodian. Never the caller of an override. */
let incoming: { id: string; email: string };
let otherHandoverId: string;

let handoverReasonId: string;
let stockReasonId: string;
/** A reason code of the same cafe in the wrong domain. */
let cashReasonId: string;
/** A retired handover reason. */
let retiredReasonId: string;
/** A live handover reason belonging to the OTHER cafe. */
let foreignReasonId: string;

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
        unit: "KG", isCritical: true, isActive: true, archivedAt: null,
        currentStock: "10", costPerUnit: 450, name: items[key].name,
      },
    });
  }
}

/**
 * Empty the branch of everything a previous case created.
 *
 * Order is dictated by the schema's deliberate `Restrict` keys: evidence must
 * outlive the thing it describes, so acknowledgements and boundaries go before
 * lines, count sessions before the handovers that cite them, and handovers
 * before the custody periods naming who was answerable.
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
  await db.stockVarianceSpanCustody.deleteMany({
    where: { span: { varianceCase: { branchId } } },
  });
  await db.stockVarianceSpan.deleteMany({ where: { varianceCase: { branchId } } });
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
  cafeId: string, branchId: string, userId: string, openingCash = 100,
) {
  const last = await db.shift.aggregate({
    where: { branchId }, _max: { shiftNumber: true },
  });
  const shift = await db.shift.create({
    data: {
      cafeId, branchId, cashierId: userId,
      shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: openingCash, expectedCashAmount: openingCash,
    },
  });
  const { ensureCustodyForShift } = await custodyLib();
  await db.$transaction((tx) =>
    ensureCustodyForShift(tx, {
      cafeId, branchId, shiftId: shift.id, userId, openingCashAmount: openingCash,
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

/** A branch in exactly the state SH-16 leaves it. */
async function freshHandover(
  cafe: CountCafe = fx,
  branchId: string = fx.branchId,
  target: "SHIFT_TO_SHIFT" | "BRANCH_CUSTODY" = "SHIFT_TO_SHIFT",
): Promise<Handover> {
  await resetBranch(branchId);
  const shift = await openOperationalShift(cafe.cafeId, branchId, cafe.cashier.id);
  const { closeShiftWithSettlement } = await cashCloseLib();
  const closed = await closeShiftWithSettlement({
    shiftId: shift.id, actualCash: 100, actorId: cafe.cashier.id,
    closedByManager: false, handoverTarget: target, grants: GRANTS_FULL,
  });
  if (!closed.handoverId || !closed.freezeId) {
    throw new Error(`close produced no handover (status ${closed.status})`);
  }
  const handover = await db.handoverSession.findUniqueOrThrow({
    where: { id: closed.handoverId },
    select: {
      outgoingStockCustodyId: true, outgoingCashCustodyId: true,
      requiredItems: { select: { inventoryItemId: true }, orderBy: { itemNameSnapshot: "asc" } },
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

// ───────────────────────────── HTTP drivers ──────────────────────────────

const post = <T = Record<string, unknown>>(email: string, body: unknown) =>
  as<T>(email, "/api/handovers", { method: "POST", body: JSON.stringify(body) });

const startCountHttp = (handoverId: string, email: string = fx.cashier.email) =>
  post<{ countSession: { id: string; reused: boolean } }>(
    email, { action: "start_count", handoverId },
  );

const patchLine = (email: string, sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ error?: string }>(email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity }),
  });

const submitCount = (email: string, sessionId: string) =>
  as<{ error?: string }>(email, `/api/stock-counts/${sessionId}/submit`, {
    method: "POST", body: "{}",
  });

const acceptVariance = (email: string, sessionId: string, lineId: string, reasonCodeId: string) =>
  as<{ error?: string }>(
    email, `/api/stock-counts/${sessionId}/lines/${lineId}/accept-variance`,
    { method: "POST", body: JSON.stringify({ reasonCodeId }) },
  );

const confirmCount = (email: string, sessionId: string, idempotencyKey: string) =>
  as<{ status?: string; error?: string }>(email, `/api/stock-counts/${sessionId}/confirm`, {
    method: "POST", body: JSON.stringify({ idempotencyKey }),
  });

const submitHandoverHttp = (handoverId: string, email: string = fx.cashier.email) =>
  post<{ status?: string; error?: string }>(email, { action: "submit", handoverId });

const ackPost = (email: string, handoverId: string, body: unknown) =>
  as<{ decision?: string; error?: string }>(
    email, `/api/handovers/${handoverId}/acknowledge`,
    { method: "POST", body: JSON.stringify(body) },
  );

/** The endpoint under test. */
const overridePost = (email: string, handoverId: string, body: unknown) =>
  as<{
    status?: string; openingExceptionId?: string; missingItemIds?: string[];
    requiredItems?: { satisfied: number; omitted: string[] };
    incomingShiftId?: string; handoverTarget?: string; error?: string;
  }>(
    email, `/api/handovers/${handoverId}/override-accept`,
    { method: "POST", body: JSON.stringify(body) },
  );

/** A body that is valid in every respect the case under test is not about. */
const goodBody = (extra: Record<string, unknown> = {}) => ({
  idempotencyKey: `${MARKER}-http-${Math.random()}`,
  reasonCodeId: handoverReasonId,
  note: "الجرد اتأخر والفرع لازم يفتح",
  kind: "MANAGER_ADJUSTMENT",
  ...extra,
});

// ────────────────────────── count / review walks ─────────────────────────

async function walkTheCount(sessionId: string, counted: Record<string, number> = {}) {
  const lines = await db.stockCountLine.findMany({
    where: { sessionId }, select: { id: true, inventoryItemId: true },
  });
  for (const line of lines) {
    const figure = counted[line.inventoryItemId] ?? 10;
    const r = await patchLine(fx.manager.email, sessionId, line.id, figure);
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
  const forgiven = await db.stockCountLine.findMany({
    where: { sessionId, disposition: "WITHIN_TOLERANCE", reasonCodeId: null },
    select: { id: true, varianceQuantity: true },
  });
  for (const line of forgiven) {
    if (line.varianceQuantity === null || Number(line.varianceQuantity) === 0) continue;
    await db.stockCountLine.update({
      where: { id: line.id }, data: { reasonCodeId: stockReasonId },
    });
  }
  return lines.map((l) => l.id);
}

/**
 * Leave three required items with no line in the accepted session.
 *
 * The same manoeuvre `handover-008` uses to reach SH-20's step-5 refusal: the
 * line disappears between the review and the acceptance, and settlement is the
 * only thing that can notice. The acknowledgement goes with it, so the
 * evidence gate still sees a fully signed round and the ONLY refusal left for
 * a manager to override is the omission itself.
 *
 * The inventory items are untouched and stay active, which is what makes the
 * boundary assertions meaningful.
 */
async function orphanRequiredItems(sessionId: string) {
  for (const key of DROPPED) {
    const line = await db.stockCountLine.findFirstOrThrow({
      where: { sessionId, inventoryItemId: items[key].id },
      select: { id: true },
    });
    await db.handoverStockAcknowledgement.deleteMany({
      where: { stockCountLineId: line.id },
    });
    await db.stockCountLine.delete({ where: { id: line.id } });
  }
}

/** A confirmed, bound count and a handover at OUTGOING_SUBMITTED. */
async function reviewedHandover(counted: Record<string, number> = {}) {
  const h = await freshHandover();
  const started = await startCountHttp(h.handoverId);
  assert.equal(started.status, 200, started.text);
  const sessionId = started.body.countSession.id;
  await walkTheCount(sessionId, counted);
  const confirmed = await confirmCount(fx.manager.email, sessionId, `${MARKER}-${sessionId}`);
  assert.ok(confirmed.status < 300, `confirm failed: ${confirmed.text}`);
  const submitted = await submitHandoverHttp(h.handoverId);
  assert.equal(submitted.status, 200, submitted.text);
  return { ...h, sessionId };
}

/** The arriving cashier's shift: OPEN, holding nothing, and gated. */
async function openIncomingShift() {
  const shift = await openOperationalShift(fx.cafeId, fx.branchId, incoming.id);
  const row = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
  assert.equal(row.custodyGateReason, "AWAITING_CUSTODY_TRANSFER");
  return shift;
}

async function acknowledgeAll(handoverId: string, sessionId: string) {
  const lines = await db.stockCountLine.findMany({
    where: { sessionId, countedQuantity: { not: null } },
    select: { id: true },
  });
  for (const line of lines) {
    const r = await ackPost(incoming.email, handoverId, { stockCountLineId: line.id });
    assert.equal(r.status, 200, `acknowledge failed: ${r.text}`);
  }
  return lines.map((l) => l.id);
}

/**
 * A handover ready to accept whose required set is INCOMPLETE: three critical
 * items were snapshotted at close and are not in the count.
 */
async function overridableHandover(counted: Record<string, number> = {}) {
  const h = await reviewedHandover(counted);
  const incomingShift = await openIncomingShift();
  const lineIds = await acknowledgeAll(h.handoverId, h.sessionId);
  await orphanRequiredItems(h.sessionId);
  return { ...h, incomingShiftId: incomingShift.id, lineIds };
}

/** A handover ready to accept whose required set is COMPLETE. */
async function completeHandover(counted: Record<string, number> = {}) {
  const h = await reviewedHandover(counted);
  const incomingShift = await openIncomingShift();
  const lineIds = await acknowledgeAll(h.handoverId, h.sessionId);
  return { ...h, incomingShiftId: incomingShift.id, lineIds };
}

// ─────────────────────────────── service calls ───────────────────────────

type OverrideOverrides = Partial<{
  managerId: string;
  incomingUserId: string | null;
  reasonCodeId: string;
  note: string;
  kind: "MANAGER_ADJUSTMENT" | "NO_INCOMING";
  idempotencyKey: string;
  cafeId: string;
  viewerBranchId: string | null;
}>;

async function override(handoverId: string, o: OverrideOverrides = {}) {
  const { overrideAcceptHandover } = await handoverLib();
  return overrideAcceptHandover({
    handoverId,
    managerId: o.managerId ?? fx.manager.id,
    incomingUserId: o.incomingUserId,
    reasonCodeId: o.reasonCodeId ?? handoverReasonId,
    note: o.note ?? "الجرد اتأخر والفرع لازم يفتح",
    kind: o.kind ?? "MANAGER_ADJUSTMENT",
    idempotencyKey: o.idempotencyKey ?? `${MARKER}-${handoverId}-${Math.random()}`,
    cafeId: o.cafeId ?? fx.cafeId,
    viewerBranchId: o.viewerBranchId === undefined ? fx.branchId : o.viewerBranchId,
  });
}

async function accept(handoverId: string, idempotencyKey?: string) {
  const { acceptHandover } = await handoverLib();
  return acceptHandover({
    handoverId,
    incomingUserId: incoming.id,
    idempotencyKey: idempotencyKey ?? `${MARKER}-acc-${handoverId}-${Math.random()}`,
    cafeId: fx.cafeId,
    viewerBranchId: fx.branchId,
  });
}

const statusIs = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;

const droppedIds = () => DROPPED.map((k) => items[k].id).sort();

// ──────────────────────────────── fixture ────────────────────────────────

before(async () => {
  await requireServer();
  fx = await countCafe("HANDOVER009");
  other = await countCafe("HANDOVER009X");

  for (const key of ITEM_KEYS) {
    const created = await countItem(fx, key, { stock: 10, isCritical: true });
    items[key] = { id: created.id, name: created.name };
  }

  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  incoming = await db.user.create({
    data: {
      email: `${fx.marker.toLowerCase()}-incoming@example.invalid`,
      name: `${fx.marker}-incoming`, passwordHash: hash,
      role: "CASHIER", cafeId: fx.cafeId, branchId: fx.branchId,
    },
    select: { id: true, email: true },
  });
  await login(incoming.email, COUNT_PASSWORD);

  handoverReasonId = (await db.reasonCode.create({
    data: {
      cafeId: fx.cafeId, domain: "HANDOVER",
      code: `${MARKER}-HO`, label: "استثناء مدير",
    },
  })).id;
  stockReasonId = (await db.reasonCode.create({
    data: { cafeId: fx.cafeId, domain: "STOCK", code: `${MARKER}-ST`, label: "هالك" },
  })).id;
  cashReasonId = (await db.reasonCode.create({
    data: { cafeId: fx.cafeId, domain: "CASH", code: `${MARKER}-CA`, label: "فرق كاش" },
  })).id;
  retiredReasonId = (await db.reasonCode.create({
    data: {
      cafeId: fx.cafeId, domain: "HANDOVER",
      code: `${MARKER}-OLD`, label: "سبب متوقف", isActive: false,
    },
  })).id;
  foreignReasonId = (await db.reasonCode.create({
    data: {
      cafeId: other.cafeId, domain: "HANDOVER",
      code: `${MARKER}-FGN`, label: "سبب كافيه تاني",
    },
  })).id;

  await countItem(other, "foreign", { stock: 4, isCritical: true });
  await db.cafeSettings.update({
    where: { cafeId: other.cafeId },
    data: {
      stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL",
      periodicFullCountSchedule: "MANUAL_ONLY", periodicFullCountWeekday: null,
    },
  });
  otherHandoverId = (await freshHandover(other, other.branchId)).handoverId;
});

beforeEach(async () => {
  await configureBranch();
  await restoreItems();
});

after(async () => {
  await teardownTaggedCafe(
    [fx?.cafeId, other?.cafeId].filter((id): id is string => Boolean(id)),
    [
      () => resetBranch(fx.branchId),
      () => resetBranch(fx.otherBranchId),
      () => resetBranch(other.branchId),
      () => resetBranch(other.otherBranchId),
    ],
    { disconnect: true },
  );
});

// ═══════════════════ T2 · authority, reason and target ═══════════════════

describe("SH-21 the exception gate", () => {
  test("the fixture really does leave three required items uncounted", async () => {
    const h = await overridableHandover();
    // Six items were required at close; the count reached three of them.
    assert.equal(h.requiredItemIds.length, 6);
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { inventoryItemId: true },
    });
    assert.equal(lines.length, 3, "three of the six required items have no line");
    for (const id of droppedIds()) {
      assert.ok(
        !lines.some((l) => l.inventoryItemId === id),
        "a dropped item must have no count line at all",
      );
    }
    // Every line that remains is signed for, so the acknowledgement gate is
    // not what any refusal below is about.
    const acks = await db.handoverStockAcknowledgement.count({
      where: { handoverId: h.handoverId },
    });
    assert.equal(acks, 3);
  });

  test("an override without a reason code is 400", async () => {
    const h = await overridableHandover();
    const r = await overridePost(
      fx.manager.email, h.handoverId, goodBody({ reasonCodeId: "" }),
    );
    assert.equal(r.status, 400, r.text);
    await assert.rejects(() => override(h.handoverId, { reasonCodeId: "" }), statusIs(400));
  });

  test("a reason from another domain, another cafe or a retired one is 400", async () => {
    const h = await overridableHandover();
    for (const reasonCodeId of [cashReasonId, foreignReasonId, retiredReasonId]) {
      await assert.rejects(() => override(h.handoverId, { reasonCodeId }), statusIs(400));
    }
    // And nothing was written on the way to any of those refusals.
    assert.equal(await db.openingException.count({ where: { handoverId: h.handoverId } }), 0);
    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(row.status, "INCOMING_REVIEW", "the handover is exactly where it was");
  });

  test("a whitespace-only note is 400, and the row lock is never taken for it", async () => {
    const h = await overridableHandover();
    for (const note of ["", "   ", "\t\n  "]) {
      await assert.rejects(() => override(h.handoverId, { note }), statusIs(400));
    }
    const r = await overridePost(fx.manager.email, h.handoverId, goodBody({ note: "   " }));
    assert.equal(r.status, 400, r.text);

    const required = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId },
      select: { omitted: true, omissionNote: true },
    });
    assert.ok(
      required.every((x) => x.omitted === false && x.omissionNote === null),
      "a refused override leaves the required rows exactly as they were",
    );
  });

  test("a cashier is 403 — handover.exception rides shifts:read", async () => {
    const h = await overridableHandover();
    const r = await overridePost(incoming.email, h.handoverId, goodBody());
    assert.equal(r.status, 403, r.text);
    assert.equal(await db.openingException.count({ where: { handoverId: h.handoverId } }), 0);
  });

  test("a BRANCH_CUSTODY target is rejected — this route is shift-to-shift only", async () => {
    const h = await freshHandover(fx, fx.branchId, "BRANCH_CUSTODY");
    await assert.rejects(() => override(h.handoverId), statusIs(409));
    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(row.target, "BRANCH_CUSTODY", "the immutable target is untouched");
    assert.equal(row.resolvedTarget, null);
    assert.equal(row.exceptionById, null);
  });

  test("another cafe's handover is 404 and another branch's is 403", async () => {
    await assert.rejects(
      () => override(otherHandoverId, { cafeId: fx.cafeId }), statusIs(404),
    );
    const h = await overridableHandover();
    await assert.rejects(
      () => override(h.handoverId, { viewerBranchId: fx.otherBranchId }), statusIs(403),
    );
  });

  test("the route refuses managerId and incomingShiftId BY NAME", async () => {
    const h = await overridableHandover();
    for (const field of ["managerId", "incomingShiftId"] as const) {
      const r = await overridePost(
        fx.manager.email, h.handoverId,
        goodBody({ [field]: field === "managerId" ? incoming.id : h.incomingShiftId }),
      );
      assert.equal(r.status, 400, `${field} must be refused: ${r.text}`);
      assert.match(r.text, new RegExp(field));
    }
  });

  test("a named incomingUserId must be the arriving shift's own cashier", async () => {
    const h = await overridableHandover();
    // The manager is not the recipient, and naming them does not make them one.
    await assert.rejects(
      () => override(h.handoverId, { incomingUserId: fx.manager.id }), statusIs(409),
    );
    await assert.rejects(
      () => override(h.handoverId, { incomingUserId: fx.cashier.id }), statusIs(409),
    );
    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(row.status, "INCOMING_REVIEW", "a mismatch changes nothing");

    // The true recipient is accepted, and it is the one the service derives.
    const result = await override(h.handoverId, { incomingUserId: incoming.id });
    assert.equal(result.status, "COMPLETED");
  });

  test("an unsigned line of the current round still refuses the override", async () => {
    const h = await reviewedHandover();
    await openIncomingShift();
    await orphanRequiredItems(h.sessionId);
    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId, countedQuantity: { not: null } },
      select: { id: true },
    });
    for (const line of lines.slice(0, -1)) {
      const r = await ackPost(incoming.email, h.handoverId, { stockCountLineId: line.id });
      assert.equal(r.status, 200, r.text);
    }
    await assert.rejects(() => override(h.handoverId), statusIs(409));
    assert.equal(await db.openingException.count({ where: { handoverId: h.handoverId } }), 0);
    assert.equal(await db.stockCountRebase.count({ where: { sessionId: h.sessionId } }), 0);
  });

  test("with no arriving shift the override is refused, not redirected to the branch", async () => {
    const h = await reviewedHandover();
    await orphanRequiredItems(h.sessionId);
    // No `openIncomingShift`, so there is nobody to receive custody. NO_INCOMING
    // classifies the manager's reason; it does not conjure a recipient.
    await assert.rejects(() => override(h.handoverId, { kind: "NO_INCOMING" }), statusIs(409));
    assert.equal(
      await db.custodyPeriod.count({ where: { branchId: fx.branchId, holderType: "BRANCH" } }),
      0,
      "SH-21 never reaches BRANCH custody",
    );
  });
});

// ═════════════ T3 · omission settlement, and never a fabricated count ═════

describe("SH-21 omission settlement", () => {
  test("ordinary accept refuses the incomplete set and the override completes it", async () => {
    const h = await overridableHandover();
    await assert.rejects(() => accept(h.handoverId), statusIs(409));
    // The refusal rolled back the settlement it had already written.
    const before = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId }, select: { omitted: true, omissionNote: true },
    });
    assert.ok(before.every((x) => x.omitted === false && x.omissionNote === null));

    const result = await override(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.missingItemIds.length, 3);
    assert.deepEqual([...result.missingItemIds].sort(), droppedIds());
  });

  test("the three rows read omitted with the manager's note and no satisfying line", async () => {
    const note = "المخزن كان مقفول والمدير أذن بالتسليم";
    const h = await overridableHandover();
    await override(h.handoverId, { note });

    const required = await db.handoverRequiredItem.findMany({
      where: { handoverId: h.handoverId },
      select: {
        inventoryItemId: true, omitted: true,
        omissionNote: true, satisfiedByLineId: true,
      },
    });
    const missing = required.filter((r) => r.omitted);
    assert.equal(missing.length, 3);
    assert.deepEqual(missing.map((m) => m.inventoryItemId).sort(), droppedIds());
    for (const row of missing) {
      assert.equal(row.omissionNote, note, "the manager's stated reason, on the row");
      assert.equal(row.satisfiedByLineId, null, "nothing satisfied it");
    }
    // The counted three are satisfied and carry no omission note.
    const satisfied = required.filter((r) => !r.omitted);
    assert.equal(satisfied.length, 3);
    for (const row of satisfied) {
      assert.notEqual(row.satisfiedByLineId, null);
      assert.equal(row.omissionNote, null);
    }
  });

  test("an override manufactures no count line and no ledger movement for a missing item", async () => {
    const h = await overridableHandover();
    await override(h.handoverId);

    const lines = await db.stockCountLine.findMany({
      where: { sessionId: h.sessionId }, select: { inventoryItemId: true },
    });
    assert.equal(lines.length, 3, "still exactly the three the count reached");
    for (const id of droppedIds()) {
      assert.ok(!lines.some((l) => l.inventoryItemId === id));
      assert.equal(
        await db.stockCountRebase.count({ where: { sessionId: h.sessionId, inventoryItemId: id } }),
        0,
        "an uncounted item is not rebased",
      );
    }
  });

  test("an override with a complete required set still succeeds and still records itself", async () => {
    // A5/A6: the manager deliberately invoked the exception path. It is not
    // silently redirected to an ordinary accept, and the authority is still
    // reconstructible afterwards.
    const h = await completeHandover();
    const result = await override(h.handoverId);
    assert.equal(result.status, "COMPLETED");
    assert.deepEqual(result.missingItemIds, []);
    assert.deepEqual(result.requiredItems.omitted, []);
    assert.equal(
      await db.handoverRequiredItem.count({ where: { handoverId: h.handoverId, omitted: true } }),
      0,
      "no required row is marked omitted when none was missing",
    );
    assert.ok(result.openingExceptionId, "the exception is still written");
    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(row.exceptionById, fx.manager.id);
  });
});

// ═══════════ T4 · boundary, variance and the exception's own record ══════

describe("SH-21 boundary and variance", () => {
  test("a missing item gets a SYSTEM_CARRIED, unverified boundary and no case", async () => {
    const h = await overridableHandover();
    await override(h.handoverId);

    const boundaries = await db.handoverStockBoundary.findMany({
      where: { handoverId: h.handoverId },
      select: {
        inventoryItemId: true, source: true, verified: true,
        stockCountLineId: true, quantity: true,
      },
    });
    // One row per active item — the six, counted or carried.
    assert.equal(boundaries.length, 6);
    for (const id of droppedIds()) {
      const row = boundaries.find((b) => b.inventoryItemId === id);
      assert.ok(row, "an uncounted required item still owes a boundary row");
      assert.equal(row.source, "SYSTEM_CARRIED");
      assert.equal(row.verified, false);
      assert.equal(row.stockCountLineId, null, "it is carried, not counted");
      assert.equal(
        await db.varianceCase.count({
          where: {
            acceptedHandoverId: h.handoverId,
            stockCountLine: { inventoryItemId: id },
          },
        }),
        0,
        "an unverified boundary opens no case and names nobody",
      );
    }
  });

  test("a counted variance still opens its case, attributed and unassigned", async () => {
    const h = await overridableHandover({ [items.alpha.id]: 4 });
    const result = await override(h.handoverId);

    assert.equal(result.varianceCaseIds.length, 1, "one case, for the counted difference");
    const kase = await db.varianceCase.findUniqueOrThrow({
      where: { id: result.varianceCaseIds[0] },
      include: { varianceSpan: true, stockCountLine: true },
    });
    assert.equal(kase.stockCountLine?.inventoryItemId, items.alpha.id);
    assert.equal(kase.acceptedHandoverId, h.handoverId);
    assert.equal(kase.status, "OPEN");
    assert.equal(
      kase.assignedResponsibilityUserId, null,
      "an override never blames anybody",
    );

    // The verdict is SH-17's, re-derived by nothing here. An override changes
    // who may finish the acceptance; it does not change what the evidence
    // means, so this is exactly the branch `handover-008` pins for an ordinary
    // accept of the same shape.
    if (kase.attribution === "VERIFIED_SHIFT") {
      assert.equal(kase.shiftId, h.shiftId, "the shift that was answerable");
      assert.equal(kase.varianceSpan, null);
    } else if (kase.attribution === "PERIOD_UNRESOLVED") {
      assert.equal(
        kase.shiftId, null,
        "an unresolved span must not carry a shift — a reader would take it as the answer",
      );
      assert.ok(kase.varianceSpan, "an unresolved verdict is accompanied by its span");
      assert.deepEqual(result.spanIds, [kase.varianceSpan.id]);
    } else {
      assert.ok(
        ["BRANCH_CUSTODY", "NOT_APPLICABLE"].includes(kase.attribution),
        `unexpected attribution ${kase.attribution}`,
      );
    }

    // And no case was opened for any of the three nobody looked at.
    for (const id of droppedIds()) {
      assert.equal(
        await db.varianceCase.count({
          where: { branchId: fx.branchId, stockCountLine: { inventoryItemId: id } },
        }),
        0,
      );
    }
  });

  test("the OpeningException is written once, linked, authorised and financially silent", async () => {
    const note = "الوردية الجديدة اتأخرت";
    const h = await overridableHandover();
    const result = await override(h.handoverId, { kind: "NO_INCOMING", note });

    const exceptions = await db.openingException.findMany({
      where: { handoverId: h.handoverId },
    });
    assert.equal(exceptions.length, 1, "exactly one");
    const ex = exceptions[0];
    assert.equal(ex.id, result.openingExceptionId);
    assert.equal(ex.kind, "NO_INCOMING", "the kind the manager asked for");
    assert.equal(ex.authorizedById, fx.manager.id, "the manager, never the custodian");
    assert.equal(ex.reasonCodeId, handoverReasonId);
    assert.equal(ex.note, note);
    assert.equal(ex.cafeId, fx.cafeId);
    assert.equal(ex.branchId, fx.branchId);
    // Nothing financial was overridden, so no amount is invented — a zero here
    // would read as a figure somebody counted.
    assert.equal(ex.proposedAmount, null);
    assert.equal(ex.actualAmount, null);
    assert.equal(ex.varianceAmount, null);
    assert.equal(ex.custodyPeriodId, null, "no BRANCH custody path is reachable");
  });

  test("the handover ends COMPLETED with the exception columns filled", async () => {
    const note = "أذن المدير";
    const h = await overridableHandover();
    const before = new Date();
    await override(h.handoverId, { note });

    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    // A8: COMPLETED, not MANAGER_EXCEPTION and not ACCEPTED.
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.exceptionById, fx.manager.id);
    assert.equal(row.exceptionReason, note);
    assert.ok(row.exceptionAt && row.exceptionAt >= before);
    assert.equal(
      row.exceptionAt?.getTime(), row.acceptedAt?.getTime(),
      "one instant: the authority and the acceptance are the same fact",
    );
    // A9: no destination divergence.
    assert.equal(row.target, "SHIFT_TO_SHIFT");
    assert.equal(row.resolvedTarget, "SHIFT_TO_SHIFT");
  });

  test("an ordinary accept writes no exception columns and no OpeningException", async () => {
    const h = await completeHandover();
    await accept(h.handoverId);
    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.exceptionById, null);
    assert.equal(row.exceptionReason, null);
    assert.equal(row.exceptionAt, null);
    assert.equal(await db.openingException.count({ where: { handoverId: h.handoverId } }), 0);
  });

  test("the CHECK refuses a MANAGER_EXCEPTION status with a null exceptionById", async () => {
    const h = await overridableHandover();
    // A direct raw write, because no service path can produce this row — which
    // is the point: the database is the last line, not the service.
    await assert.rejects(
      () => db.$executeRawUnsafe(
        `UPDATE "HandoverSession" SET "status" = 'MANAGER_EXCEPTION', "exceptionById" = NULL WHERE "id" = $1`,
        h.handoverId,
      ),
      /HandoverSession_exception_authority_required/,
    );
  });
});

// ═══════════ T5/T7 · actor split, custody, shift, freeze and audit ═══════

describe("SH-21 actor split and custody", () => {
  test("the manager authorises and the arriving custodian receives", async () => {
    const h = await overridableHandover();
    const result = await override(h.handoverId);

    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    // The manager owns the exception facts, and only those.
    assert.equal(row.exceptionById, fx.manager.id);
    // Every SH-20 operational fact still names the custodian.
    assert.equal(row.incomingUserId, incoming.id);
    assert.equal(row.incomingShiftId, h.incomingShiftId);

    const predecessor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: h.outgoingStockCustodyId as string },
      select: { acceptedById: true, status: true },
    });
    assert.equal(
      predecessor.acceptedById, incoming.id,
      "A3: the predecessor records who accepted it — the custodian",
    );
    assert.equal(predecessor.status, "TRANSFERRED", "handed on, not merely closed");

    const successor = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: result.incomingStockCustodyId as string },
      select: {
        openedById: true, holderType: true, responsibleShiftId: true,
        scope: true, status: true,
        participants: { select: { userId: true, role: true } },
      },
    });
    assert.equal(successor.openedById, incoming.id, "A3: successor opened by the custodian");
    assert.equal(successor.holderType, "USER", "A2: USER-to-USER custody only");
    assert.equal(successor.responsibleShiftId, h.incomingShiftId);
    assert.equal(successor.status, "OPEN");
    assert.deepEqual(
      successor.participants.map((p) => p.userId), [incoming.id],
      "the manager is not made a custodian by signing the exception",
    );

    // A4: step 13 closes the outgoing shift in the custodian's name.
    const outgoing = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(outgoing.status, "CLOSED");
    assert.equal(outgoing.closedById, incoming.id);
    assert.notEqual(outgoing.closedById, fx.manager.id);
    assert.ok(outgoing.stockClosedAt);

    // The rebase and the count lock are the custodian's acts too.
    const rebases = await db.stockCountRebase.findMany({
      where: { sessionId: h.sessionId }, select: { rebasedById: true },
    });
    assert.ok(rebases.length > 0);
    assert.ok(rebases.every((r) => r.rebasedById === incoming.id));
  });

  test("the arriving shift may sell, and the freeze is released last", async () => {
    const h = await overridableHandover();
    await override(h.handoverId);

    const arriving = await db.shift.findUniqueOrThrow({ where: { id: h.incomingShiftId } });
    assert.equal(arriving.custodyGateReason, null, "the gate is cleared");
    assert.ok(arriving.custodyReadyAt, "and readiness is evidenced");

    const freeze = await db.inventoryFreeze.findUniqueOrThrow({ where: { id: h.freezeId } });
    assert.ok(freeze.releasedAt, "the freeze is released, in the same commit");
    assert.equal(
      freeze.releasedById, incoming.id,
      "A3: the freeze release is an operational act of the custodian",
    );
    // The accepted evidence is now immutable.
    const session = await db.stockCountSession.findUniqueOrThrow({ where: { id: h.sessionId } });
    assert.equal(session.status, "LOCKED");
    assert.equal(session.lockedByHandoverId, h.handoverId);
  });

  test("the cash drawer moves to the custodian, at the figure the close counted", async () => {
    const h = await overridableHandover();
    const result = await override(h.handoverId);
    assert.ok(result.incomingCashCustodyId, "SHIFT_TO_SHIFT hands the till over too");

    const cash = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: result.incomingCashCustodyId as string },
      select: {
        scope: true, holderType: true, openedById: true,
        participants: { select: { userId: true } },
      },
    });
    assert.equal(cash.scope, "CASH");
    assert.equal(cash.holderType, "USER");
    assert.equal(cash.openedById, incoming.id);
    assert.deepEqual(cash.participants.map((p) => p.userId), [incoming.id]);

    // The financial close evidence is untouched by the override.
    const outgoing = await db.shift.findUniqueOrThrow({ where: { id: h.shiftId } });
    assert.equal(Number(outgoing.actualCashAmount), 100);
    assert.ok(outgoing.financiallyClosedAt);
  });

  test("two audit rows: the acceptance by the custodian, the exception by the manager", async () => {
    const note = "قرار المدير";
    const h = await overridableHandover();
    const result = await override(h.handoverId, { note, kind: "MANAGER_ADJUSTMENT" });

    const accepted = await db.auditLog.findFirstOrThrow({
      where: { entityId: h.handoverId, action: "HANDOVER_ACCEPTED" },
    });
    assert.equal(accepted.userId, incoming.id, "the acceptance is the custodian's act");

    const exception = await db.auditLog.findMany({
      where: { entityId: h.handoverId, action: "HANDOVER_MANAGER_EXCEPTION" },
    });
    assert.equal(exception.length, 1);
    assert.equal(exception[0].userId, fx.manager.id, "the override is the manager's act");
    const details = exception[0].details as Record<string, unknown>;
    assert.equal(details.note, note);
    assert.equal(details.reasonCodeId, handoverReasonId);
    assert.equal(details.kind, "MANAGER_ADJUSTMENT");
    assert.equal(details.openingExceptionId, result.openingExceptionId);
    assert.deepEqual([...(details.missingItemIds as string[])].sort(), droppedIds());
  });

  test("an ordinary accept writes no HANDOVER_MANAGER_EXCEPTION row", async () => {
    const h = await completeHandover();
    await accept(h.handoverId);
    assert.equal(
      await db.auditLog.count({
        where: { entityId: h.handoverId, action: "HANDOVER_MANAGER_EXCEPTION" },
      }),
      0,
    );
  });
});

// ═══════════════════════ T5 · replay and idempotency ═════════════════════

describe("SH-21 replay", () => {
  test("the same key replays the persisted exception and writes nothing twice", async () => {
    const key = `${MARKER}-replay-${Math.random()}`;
    const h = await overridableHandover();
    const first = await override(h.handoverId, { idempotencyKey: key });

    const counts = async () => ({
      exceptions: await db.openingException.count({ where: { handoverId: h.handoverId } }),
      boundaries: await db.handoverStockBoundary.count({ where: { handoverId: h.handoverId } }),
      cases: await db.varianceCase.count({ where: { acceptedHandoverId: h.handoverId } }),
      audits: await db.auditLog.count({
        where: { entityId: h.handoverId, action: "HANDOVER_MANAGER_EXCEPTION" },
      }),
      rebases: await db.stockCountRebase.count({ where: { sessionId: h.sessionId } }),
    });
    const before = await counts();

    const second = await override(h.handoverId, { idempotencyKey: key });
    assert.equal(second.alreadyAccepted, true);
    assert.equal(
      second.openingExceptionId, first.openingExceptionId,
      "the exact same exception, read back from persisted state",
    );
    assert.deepEqual(second.missingItemIds, first.missingItemIds);
    assert.equal(second.rebase, null, "a replay rebased nothing and does not claim to");
    assert.deepEqual(await counts(), before, "no second write of anything");
  });

  test("a different key is a claim to a second acceptance, and is refused", async () => {
    const h = await overridableHandover();
    await override(h.handoverId, { idempotencyKey: `${MARKER}-one-${Math.random()}` });
    await assert.rejects(
      () => override(h.handoverId, { idempotencyKey: `${MARKER}-two-${Math.random()}` }),
      statusIs(409),
    );
    assert.equal(await db.openingException.count({ where: { handoverId: h.handoverId } }), 1);
  });

  test("an ordinary completion replayed under the override path does not gain an exception", async () => {
    const key = `${MARKER}-ordinary-${Math.random()}`;
    const h = await completeHandover();
    await accept(h.handoverId, key);

    // The key matches, so this is not "somebody else's acceptance" — it is
    // this caller's own, and it had no exception. Fabricating one now, or
    // answering with a null id, would both misreport the record.
    await assert.rejects(() => override(h.handoverId, { idempotencyKey: key }), statusIs(409));
    assert.equal(await db.openingException.count({ where: { handoverId: h.handoverId } }), 0);
    const row = await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } });
    assert.equal(row.exceptionById, null, "no authority was retro-fitted");
  });

  test("an override that completed refuses a later ordinary accept under a new key", async () => {
    const h = await overridableHandover();
    await override(h.handoverId);
    await assert.rejects(() => accept(h.handoverId), statusIs(409));
    assert.equal(await db.openingException.count({ where: { handoverId: h.handoverId } }), 1);
  });
});

// ═════════════════════════ T6 · the HTTP door ════════════════════════════

describe("SH-21 over HTTP", () => {
  test("a manager completes it end to end, and the response names what was skipped", async () => {
    const h = await overridableHandover();
    const r = await overridePost(fx.manager.email, h.handoverId, goodBody());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, "COMPLETED");
    assert.equal(r.body.handoverTarget, "SHIFT_TO_SHIFT");
    assert.equal(r.body.incomingShiftId, h.incomingShiftId);
    assert.equal(r.body.missingItemIds?.length, 3);
    assert.deepEqual([...(r.body.missingItemIds ?? [])].sort(), droppedIds());
    assert.ok(r.body.openingExceptionId);

    const ex = await db.openingException.findUniqueOrThrow({
      where: { id: r.body.openingExceptionId as string },
    });
    assert.equal(
      ex.authorizedById, fx.manager.id,
      "the manager comes from the session, and there is no body field that could say otherwise",
    );
  });

  test("an unknown field is refused rather than quietly dropped", async () => {
    const h = await overridableHandover();
    const r = await overridePost(
      fx.manager.email, h.handoverId, goodBody({ resolvedTarget: "BRANCH_CUSTODY" }),
    );
    assert.equal(r.status, 400, r.text);
  });

  test("a bad kind is refused and no exception is written", async () => {
    const h = await overridableHandover();
    for (const kind of ["CASH_MISMATCH", "FIRST_OPENING", "nonsense"]) {
      const r = await overridePost(fx.manager.email, h.handoverId, goodBody({ kind }));
      assert.equal(r.status, 400, `${kind}: ${r.text}`);
    }
    assert.equal(await db.openingException.count({ where: { handoverId: h.handoverId } }), 0);
  });

  test("a missing retry key is refused in the cafe's own language", async () => {
    const h = await overridableHandover();
    const body = goodBody() as Record<string, unknown>;
    delete body.idempotencyKey;
    const r = await overridePost(fx.manager.email, h.handoverId, body);
    assert.equal(r.status, 400, r.text);
    assert.match(r.text, /إعادة المحاولة/);
  });

  test("a handover that does not exist is 404, and so is another cafe's", async () => {
    const missing = await overridePost(fx.manager.email, "hnd_nope_009", goodBody());
    assert.equal(missing.status, 404, missing.text);
    const foreign = await overridePost(fx.manager.email, otherHandoverId, goodBody());
    assert.equal(foreign.status, 404, foreign.text);
  });

  test("no raw database error reaches the client", async () => {
    const h = await overridableHandover();
    const r = await overridePost(
      fx.manager.email, h.handoverId, goodBody({ reasonCodeId: "reason_does_not_exist" }),
    );
    assert.equal(r.status, 400, r.text);
    assert.doesNotMatch(r.text, /prisma|Invalid `|P20\d\d|constraint/i);
  });
});
