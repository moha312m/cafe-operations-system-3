// SHIFT-CF-002 — the three operational fixes through the real service layer and
// routes, against the disposable database only.
//
//   1. Items + EVERY_SHIFT saved under a NO_SHIFT_COUNT café persist HYBRID; the
//      effective configuration is enabled and the close owes the materials.
//   2. EGP 500 left in the drawer at close — on an uncounted close and through a
//      real branch-custody night — is the next shift's opening, and its expected
//      drawer is opening + cash sales (500, then 800 after a 300 sale).
//   3. The open screen's carry-forward says 500 before the next shift opens.
//   4. The variance board's richer select and filters run against the schema.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, purgeOrderTracesFor, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

const GRANTS_FULL = { handoverSubmit: true, handoverException: true };
const cashCloseLib = () => import("@/lib/cash-close");
const custodyLib = () => import("@/lib/custody");
const configLib = () => import("@/lib/handover-config");

let fx: CountCafe;
const items: { id: string; name: string }[] = [];

async function purgeDisposition(branchId: string) {
  await db.$transaction(async (tx) => {
    const guards: [string, string][] = [
      ["CashDeliveryDeclaration", "CashDeliveryDeclaration_immutable_guard"],
      ["ShiftCashDisposition", "ShiftCashDisposition_immutable_guard"],
    ];
    for (const [t, g] of guards) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${g}"`);
    await tx.$executeRawUnsafe(`DELETE FROM "CashDeliveryDeclaration" WHERE "branchId" = $1`, branchId);
    await tx.$executeRawUnsafe(`DELETE FROM "ShiftCashDisposition" WHERE "branchId" = $1`, branchId);
    for (const [t, g] of guards) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${g}"`);
  });
}

async function resetBranch(branchId: string) {
  await purgeDisposition(branchId);
  await db.handoverStockAcknowledgement.deleteMany({ where: { handover: { branchId } } });
  await db.handoverStockBoundary.deleteMany({ where: { handover: { branchId } } });
  await db.handoverRequiredItem.updateMany({ where: { handover: { branchId } }, data: { satisfiedByLineId: null } });
  await db.handoverSession.updateMany({ where: { branchId }, data: { stockCountSessionId: null, acceptedStockCountSessionId: null } });
  await db.shift.updateMany({ where: { branchId }, data: { cashVarianceCaseId: null } });
  await db.stockVarianceSpanCustody.deleteMany({ where: { span: { varianceCase: { branchId } } } });
  await db.stockVarianceSpan.deleteMany({ where: { varianceCase: { branchId } } });
  await db.varianceCase.deleteMany({ where: { branchId } });
  await db.stockCountSession.updateMany({ where: { branchId }, data: { lockedByHandoverId: null, handoverId: null, accountabilityContext: "NONE" } });
  await db.stockCountRebase.deleteMany({ where: { session: { branchId } } });
  await db.stockCountSession.deleteMany({ where: { branchId } });
  await db.inventoryFreeze.deleteMany({ where: { branchId } });
  await db.openingException.deleteMany({ where: { branchId } });
  await db.handoverCarriedOrder.deleteMany({ where: { branchId } });
  await db.shiftMaterialsDecision.deleteMany({ where: { branchId } });
  await db.handoverSession.deleteMany({ where: { branchId } });
  await db.tenderReconciliation.deleteMany({ where: { branchId } });
  await db.payment.deleteMany({ where: { branchId } });
  await db.inventoryTransaction.deleteMany({ where: { branchId } });
  await purgeOrderTracesFor({ branchId });
  await db.order.deleteMany({ where: { branchId } });
  await db.shiftPlaceReceipt.deleteMany({ where: { branchId } });
  await db.shiftCustody.deleteMany({ where: { shift: { branchId } } });
  await db.custodyParticipant.deleteMany({ where: { custodyPeriod: { branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
  await db.shift.deleteMany({ where: { branchId } });
}

/** A café that does not count at handover, and a branch that inherits it. */
async function configureNoCount() {
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: { stockCountPolicy: "NO_SHIFT_COUNT", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY", periodicFullCountWeekday: null, varianceBlocksHandover: false, varianceHardBlockAmount: null },
  });
  await db.branch.update({
    where: { id: fx.branchId },
    data: { stockCountPolicyOverride: null, handoverCountTypeOverride: null, periodicFullCountScheduleOverride: null, periodicFullCountWeekdayOverride: null, materialsCountCadence: "EVERY_SHIFT", materialsCountWeekday: null, materialsCountCutoff: null, materialsScheduleSince: null },
  });
  await db.inventoryItem.updateMany({ where: { branchId: fx.branchId }, data: { isCritical: false, isActive: true, archivedAt: null, currentStock: "10" } });
  await db.branchOpeningSettings.deleteMany({ where: { branchId: fx.branchId } });
}

async function openOperationalShift(userId: string, openingCash = 0) {
  const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
  const shift = await db.shift.create({
    data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId, shiftNumber: (last._max.shiftNumber ?? 0) + 1, openingCashAmount: openingCash, expectedCashAmount: openingCash },
  });
  const { ensureCustodyForShift } = await custodyLib();
  await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: shift.id, userId, openingCashAmount: openingCash }));
  return shift;
}

/** A served takeaway paid in cash into `shiftId`, then the shift's totals recomputed by the real writer. */
async function cashSale(shiftId: string, amount: number) {
  const order = await db.order.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: Math.floor(Math.random() * 2_000_000_000), type: "TAKEAWAY", status: "SERVED",
      subtotal: amount, total: amount, paidAmount: amount, remainingAmount: 0, paymentStatus: "PAID", createdById: fx.cashier.id,
      items: { create: { productName: "شاي تجريبي", quantity: 1, unitPrice: amount, lineTotal: amount } },
    },
  });
  await db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId: order.id, shiftId, cashierId: fx.cashier.id, receivedById: fx.cashier.id, amount, method: "CASH", type: "COLLECTION", status: "PAID" } });
  const { recomputeShiftTotals } = await import("@/lib/shifts");
  return recomputeShiftTotals(shiftId);
}

before(async () => {
  await requireServer();
  fx = await countCafe("SHIFTCF002");
  for (const k of ["alpha", "bravo"]) {
    const created = await countItem(fx, k, { stock: 10, isCritical: false });
    items.push({ id: created.id, name: created.name });
  }
});

beforeEach(async () => {
  await resetBranch(fx.branchId);
  await configureNoCount();
});

after(async () => {
  await teardownTaggedCafe([fx?.cafeId].filter((id): id is string => Boolean(id)), [() => resetBranch(fx.branchId), () => resetBranch(fx.otherBranchId)], { disconnect: true });
});

describe("bug 1 — selected items + EVERY_SHIFT", () => {
  test("save persists HYBRID; the effective config is enabled and the close owes the materials", async () => {
    const { updateBranchHandoverConfig, resolveBranchHandoverConfig } = await configLib();
    // The panel's save now leaves `enabled` out unless the checkbox changed.
    const saved = await updateBranchHandoverConfig({
      cafeId: fx.cafeId, branchId: fx.branchId, actorId: fx.owner.id,
      patch: { mode: "SELECTED", selectedItemIds: items.map((i) => i.id), materials: { cadence: "EVERY_SHIFT", weekday: null, cutoff: null } },
    });
    assert.equal(saved.enabled, true);
    assert.equal(saved.mode, "SELECTED");
    assert.deepEqual([...saved.selectedItemIds].sort(), items.map((i) => i.id).sort());
    const branch = await db.branch.findUniqueOrThrow({ where: { id: fx.branchId }, select: { stockCountPolicyOverride: true } });
    assert.equal(branch.stockCountPolicyOverride, "HYBRID", "not NO_SHIFT_COUNT");
    assert.equal((await resolveBranchHandoverConfig(fx.cafeId, fx.branchId)).enabled, true);

    const shift = await openOperationalShift(fx.cashier.id, 0);
    // Screen 1 names the items the materials step will ask for.
    const flow = await as<{ stage: string; handover: { enabled: boolean }; materials: { duePreview: boolean }; dueItemsPreview: { id: string; name: string; unit: string }[] }>(fx.cashier.email, `/api/shifts/close-flow?branchId=${fx.branchId}`);
    assert.equal(flow.status, 200, flow.text);
    assert.equal(flow.body.stage, "MONEY");
    assert.equal(flow.body.handover.enabled, true);
    assert.equal(flow.body.materials.duePreview, true);
    assert.deepEqual(flow.body.dueItemsPreview.map((i) => i.name).sort(), items.map((i) => i.name).sort());

    const { closeShiftWithSettlement } = await cashCloseLib();
    const closed = await closeShiftWithSettlement({ shiftId: shift.id, actualCash: 0, actorId: fx.cashier.id, closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", directHandover: true, grants: GRANTS_FULL });
    assert.equal(closed.handoverRequired, true, "the materials step is not skipped");
    assert.equal(closed.materials?.due, true);
    assert.equal(closed.materials?.reason, "EVERY_SHIFT");
    assert.equal(closed.requiredItemCount, 2);
  });

  test("an inheriting branch stays off under a deliberate café NO_SHIFT_COUNT until saved; an explicit switch-off wins", async () => {
    const { updateBranchHandoverConfig, resolveBranchHandoverConfig } = await configLib();
    await db.inventoryItem.update({ where: { id: items[0].id }, data: { isCritical: true } });
    assert.equal((await resolveBranchHandoverConfig(fx.cafeId, fx.branchId)).enabled, false, "reading infers nothing");
    // The legacy panel payload: the checkbox said off while items were picked. Explicit off is honoured.
    const off = await updateBranchHandoverConfig({ cafeId: fx.cafeId, branchId: fx.branchId, actorId: fx.owner.id, patch: { enabled: false, mode: "SELECTED", selectedItemIds: [items[0].id], materials: { cadence: "EVERY_SHIFT", weekday: null, cutoff: null } } });
    assert.equal(off.enabled, false);
    assert.equal((await db.branch.findUniqueOrThrow({ where: { id: fx.branchId } })).stockCountPolicyOverride, "NO_SHIFT_COUNT");
    // The panel now sends the switch-on the item tick implies.
    const on = await updateBranchHandoverConfig({ cafeId: fx.cafeId, branchId: fx.branchId, actorId: fx.owner.id, patch: { enabled: true, mode: "SELECTED", selectedItemIds: [items[0].id] } });
    assert.equal(on.enabled, true);
    assert.equal((await db.branch.findUniqueOrThrow({ where: { id: fx.branchId } })).stockCountPolicyOverride, "HYBRID");
  });
});

describe("bug 2 — the drawer left at close is the next opening", () => {
  test("uncounted close: 500 retained → next opening 500, expected 500, then 800 after a 300 cash sale", async () => {
    const first = await openOperationalShift(fx.cashier.id, 0);
    await cashSale(first.id, 500);
    const { closeShiftWithSettlement } = await cashCloseLib();
    const closed = await closeShiftWithSettlement({ shiftId: first.id, actualCash: 500, actorId: fx.cashier.id, closedByManager: false, retainAllCash: true, grants: GRANTS_FULL });
    assert.equal(closed.status, "CLOSED");
    const disposition = await db.shiftCashDisposition.findUniqueOrThrow({ where: { shiftId: first.id } });
    assert.equal(Number(disposition.retainedAmount), 500);
    assert.equal(Number(disposition.deliveredAmount), 0);
    assert.equal(disposition.handoverId, null);

    // The open screen says so before anyone opens.
    const active = await as<{ shift: null; carryforward: { source: string; expectedOpeningCash: string; previousShiftNumber: number; previousCashierName: string } }>(fx.manager.email, `/api/shifts/active?branchId=${fx.branchId}`);
    assert.equal(active.status, 200, active.text);
    assert.equal(active.body.carryforward.source, "CASH_DISPOSITION");
    assert.equal(active.body.carryforward.expectedOpeningCash, "500.00");
    assert.equal(active.body.carryforward.previousShiftNumber, first.shiftNumber);
    assert.equal(active.body.carryforward.previousCashierName, fx.cashier.name);

    const second = await openOperationalShift(fx.manager.id, 0);
    const opened = await db.shift.findUniqueOrThrow({ where: { id: second.id } });
    assert.equal(Number(opened.openingCashAmount), 500);
    assert.equal(Number(opened.expectedCashAmount), 500, "expected before the first sale");
    const link = await db.shiftCustody.findUniqueOrThrow({ where: { shiftId_scope: { shiftId: second.id, scope: "CASH" } }, include: { custodyPeriod: true } });
    assert.equal(Number(link.custodyPeriod.openingCashAmount), 500);
    const after = await cashSale(second.id, 300);
    assert.equal(Number(after?.expectedCashAmount), 800, "opening + cash sales");
  });

  test("branch-custody night: 500 retained at close → the branch-custody morning opens with 500", async () => {
    const { updateBranchHandoverConfig } = await configLib();
    await updateBranchHandoverConfig({ cafeId: fx.cafeId, branchId: fx.branchId, actorId: fx.owner.id, patch: { enabled: true, mode: "SELECTED", selectedItemIds: items.map((i) => i.id), materials: { cadence: "EVERY_SHIFT", weekday: null, cutoff: null } } });
    // The manager closes their own last shift into branch custody, overnight drawer storage off.
    const night = await openOperationalShift(fx.manager.id, 0);
    await cashSale(night.id, 500);
    const { closeShiftWithSettlement } = await cashCloseLib();
    const closed = await closeShiftWithSettlement({ shiftId: night.id, actualCash: 500, actorId: fx.manager.id, closedByManager: false, handoverTarget: "BRANCH_CUSTODY", retainAllCash: true, grants: GRANTS_FULL });
    assert.equal(closed.handoverTarget, "BRANCH_CUSTODY");
    assert.ok(closed.handoverId);
    const disposition = await db.shiftCashDisposition.findUniqueOrThrow({ where: { shiftId: night.id } });
    assert.equal(disposition.handoverId, closed.handoverId, "recorded under the branch-custody handover");
    assert.equal(Number(disposition.retainedAmount), 500);

    // Count, sign and save to branch custody exactly as the Done screen does.
    const post = <T = Record<string, unknown>>(path: string, body: unknown) => as<T>(fx.manager.email, path, { method: "POST", body: JSON.stringify(body) });
    const started = await post<{ countSession: { id: string } }>("/api/handovers", { action: "start_count", handoverId: closed.handoverId });
    assert.equal(started.status, 200, started.text);
    const sessionId = started.body.countSession.id;
    const lines = await db.stockCountLine.findMany({ where: { sessionId }, select: { id: true } });
    for (const line of lines) {
      const r = await as(fx.manager.email, `/api/stock-counts/${sessionId}/lines/${line.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: 10 }) });
      assert.ok(r.status < 300, r.text);
    }
    const finished = await post<{ status: string }>("/api/handovers", { action: "finish_outgoing", handoverId: closed.handoverId });
    assert.equal(finished.status, 200, finished.text);
    for (const line of lines) {
      const r = await post(`/api/handovers/${closed.handoverId}/acknowledge`, { stockCountLineId: line.id });
      assert.ok(r.status < 300, r.text);
    }
    const converted = await post(`/api/handovers/${closed.handoverId}/to-branch-custody`, { idempotencyKey: `shiftcf002-branch-${closed.handoverId}` });
    assert.equal(converted.status, 200, converted.text);
    const stock = await db.custodyPeriod.findFirstOrThrow({ where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" } });
    assert.equal(stock.holderType, "BRANCH");
    assert.equal(await db.custodyPeriod.count({ where: { branchId: fx.branchId, scope: "CASH", status: "OPEN" } }), 0, "nobody holds the drawer overnight");

    const carried = await as<{ carryforward: { source: string; expectedOpeningCash: string } }>(fx.cashier.email, `/api/shifts/active?branchId=${fx.branchId}`);
    assert.equal(carried.body.carryforward.source, "CASH_DISPOSITION");
    assert.equal(carried.body.carryforward.expectedOpeningCash, "500.00");

    const morning = await openOperationalShift(fx.cashier.id, 0);
    const opened = await db.shift.findUniqueOrThrow({ where: { id: morning.id } });
    // Stock handover v2 (owner decision 2026-11-12): the morning shift takes the
    // branch-held shelf at once — no opening-verification gate.
    assert.equal(opened.custodyGateReason, null);
    assert.equal(Number(opened.openingCashAmount), 500);
    assert.equal(Number(opened.expectedCashAmount), 500);
    const cash = await db.custodyPeriod.findFirstOrThrow({ where: { branchId: fx.branchId, scope: "CASH", status: "OPEN" } });
    assert.equal(Number(cash.openingCashAmount), 500);
  });

  test("never twice: the shift after an un-dispositioned close opens with what it states", async () => {
    const first = await openOperationalShift(fx.cashier.id, 0);
    const { closeShiftWithSettlement } = await cashCloseLib();
    await closeShiftWithSettlement({ shiftId: first.id, actualCash: 0, actorId: fx.cashier.id, closedByManager: false, retainAllCash: true, grants: GRANTS_FULL });
    const second = await openOperationalShift(fx.manager.id, 0);
    await closeShiftWithSettlement({ shiftId: second.id, actualCash: 0, actorId: fx.manager.id, closedByManager: false, grants: GRANTS_FULL });
    const third = await openOperationalShift(fx.cashier.id, 75);
    assert.equal(Number((await db.shift.findUniqueOrThrow({ where: { id: third.id } })).openingCashAmount), 75);
  });

  test("the disposition editor accepts a branch-custody handover (it used to refuse it)", async () => {
    const { updateBranchHandoverConfig } = await configLib();
    await updateBranchHandoverConfig({ cafeId: fx.cafeId, branchId: fx.branchId, actorId: fx.owner.id, patch: { enabled: true, mode: "SELECTED", selectedItemIds: items.map((i) => i.id), materials: { cadence: "EVERY_SHIFT", weekday: null, cutoff: null } } });
    const night = await openOperationalShift(fx.manager.id, 0);
    await cashSale(night.id, 600);
    const { closeShiftWithSettlement } = await cashCloseLib();
    const closed = await closeShiftWithSettlement({ shiftId: night.id, actualCash: 600, actorId: fx.manager.id, closedByManager: false, handoverTarget: "BRANCH_CUSTODY", grants: GRANTS_FULL });
    const recorded = await as<{ disposition?: { retainedAmount: number; retainedCustody: { status: string } } }>(fx.manager.email, `/api/shifts/${night.id}/cash-disposition`, {
      method: "POST", headers: { "Idempotency-Key": `shiftcf002-disp-${night.id}` },
      body: JSON.stringify({ deliveries: [{ destination: "OWNER", recipientId: fx.owner.id, amount: 100 }], retainedAmount: 500 }),
    });
    assert.equal(recorded.status, 201, recorded.text);
    assert.equal(recorded.body.disposition?.retainedAmount, 500);
    assert.equal(recorded.body.disposition?.retainedCustody.status, "IN_DRAWER_FOR_NEXT_SHIFT", "no receiver to accept a branch night");
    assert.equal((await db.shiftCashDisposition.findUniqueOrThrow({ where: { shiftId: night.id } })).handoverId, closed.handoverId);
  });
});

describe("bug 3 — the variance board", () => {
  test("the richer select and the new filters and summary run against the schema", async () => {
    const shift = await openOperationalShift(fx.cashier.id, 0);
    const { closeShiftWithSettlement } = await cashCloseLib();
    await closeShiftWithSettlement({ shiftId: shift.id, actualCash: 40, actorId: fx.cashier.id, closedByManager: false, reason: "زيادة فكة", grants: GRANTS_FULL });
    const board = await as<{ cases: { type: string; branch: { name: string }; cashShift: { shiftNumber: number; cashier: { name: string }; cashReasonNote: string } }[]; summary: { totalCashOverageAmount: string; totalCashShortageAmount: string; openByType: Record<string, number> } }>(
      fx.owner.email, `/api/variances?branchId=${fx.branchId}&userId=${fx.cashier.id}&from=2020-01-01`,
    );
    assert.equal(board.status, 200, board.text);
    const cash = board.body.cases.find((c) => c.type === "CASH");
    assert.ok(cash, "the cash case is listed for its cashier");
    assert.equal(cash.branch.name.endsWith("main"), true);
    assert.equal(cash.cashShift.shiftNumber, shift.shiftNumber);
    assert.equal(cash.cashShift.cashier.name, fx.cashier.name);
    assert.equal(cash.cashShift.cashReasonNote, "زيادة فكة");
    assert.equal(board.body.summary.totalCashOverageAmount, "40.00");
    assert.equal(board.body.summary.totalCashShortageAmount, "0.00");
    assert.equal(board.body.summary.openByType.CASH, 1);
    const nobody = await as<{ cases: unknown[] }>(fx.owner.email, `/api/variances?branchId=${fx.branchId}&userId=${fx.waiter.id}`);
    assert.equal(nobody.body.cases.length, 0);
  });
});
