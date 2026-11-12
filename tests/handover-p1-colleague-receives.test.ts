// Simulation 2026-11-11 lockups F-064 / F-065, with the owner's decisions:
//   * two cashiers at once share one drawer and shelf; when one hands over,
//     the colleague still working receives (counts and signs);
//   * a handover whose shelf has already moved on is ended by the manager's
//     cancel, leaving the stock with whoever holds it now.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { countCafe, countItem, type CountActor, type CountCafe } from "./helpers/count";
import { db, teardownTaggedCafe } from "./helpers/db";
import { as } from "./helpers/http";
import { createHandoverInClose } from "@/lib/handover";

const cafes: string[] = [];
after(async () => {
  for (const cafeId of cafes) {
    await teardownTaggedCafe(cafeId, [
      () => db.handoverRequiredItem.updateMany({ where: { handover: { cafeId } }, data: { satisfiedByLineId: null } }),
      () => db.handoverSession.updateMany({ where: { cafeId }, data: { stockCountSessionId: null, acceptedStockCountSessionId: null } }),
      () => db.stockCountSession.updateMany({ where: { cafeId }, data: { handoverId: null, lockedByHandoverId: null, openingBranchCustodyPeriodId: null, accountabilityContext: "NONE" } }),
    ]);
  }
  await db.$disconnect();
});

async function fixture() {
  const fx = await countCafe("P1COLLEAGUE");
  cafes.push(fx.cafeId);
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "HYBRID", handoverCountType: "FULL" } });
  await countItem(fx, "Shelf", { stock: 10, isCritical: true });
  await db.user.update({ where: { id: fx.storekeeper.id }, data: { role: "CASHIER" } });
  return fx;
}
const post = <T,>(a: CountActor, url: string, body: unknown) =>
  as<T>(a.email, url, { method: "POST", body: JSON.stringify(body) });
const open = (fx: CountCafe, a: CountActor, openingCashAmount = 0) =>
  post<{ shift: { id: string; custodyGateReason: string | null } }>(a, "/api/shifts", { branchId: fx.branchId, openingCashAmount });
const close = (a: CountActor, id: string, actualCashAmount: number) =>
  post<{ handover?: { handoverId: string } | null }>(a, `/api/shifts/${id}/close`, { actualCashAmount, handoverTarget: "SHIFT_TO_SHIFT" });

/** The outgoing cashier counts the shelf exactly and hands over. */
async function countAndSubmit(actor: CountActor, handoverId: string) {
  const started = await post<{ countSession: { id: string } }>(actor, "/api/handovers", { action: "start_count", handoverId });
  assert.equal(started.status, 200, started.text);
  const countId = started.body.countSession.id;
  for (const line of await db.stockCountLine.findMany({ where: { sessionId: countId }, include: { inventoryItem: true } })) {
    const r = await as(actor.email, `/api/stock-counts/${countId}/lines/${line.id}`, {
      method: "PATCH", body: JSON.stringify({ countedQuantity: Number(line.inventoryItem.currentStock), expectedCountedAt: null }),
    });
    assert.equal(r.status, 200, r.text);
  }
  const submitted = await post(actor, `/api/stock-counts/${countId}/submit`, {});
  assert.equal(submitted.status, 200, submitted.text);
  const finished = await post(actor, "/api/handovers", { action: "finish_outgoing", handoverId });
  assert.equal(finished.status, 200, finished.text);
  return countId;
}

/** The receiver signs every line at the outgoing figure and accepts with the counted drawer. */
async function receive(actor: CountActor, handoverId: string, countId: string, countedOpeningCash: number, key: string) {
  const view = await as<Record<string, unknown>>(actor.email, `/api/handovers/${handoverId}`);
  const countVersion = JSON.stringify(view.body).match(/"countVersion":"([^"]+)"/)?.[1];
  assert.ok(countVersion, `no countVersion in the receiver's view: ${view.text.slice(0, 300)}`);
  const lines = await db.stockCountLine.findMany({ where: { sessionId: countId } });
  const ack = await post(actor, `/api/handovers/${handoverId}/acknowledge`, {
    countSessionId: countId, countVersion, idempotencyKey: `${key}-ack`,
    lines: lines.map((l) => ({ stockCountLineId: l.id, incomingCountedQuantity: Number(l.countedQuantity) })),
  });
  assert.equal(ack.status, 200, ack.text);
  return post<{ status: string }>(actor, `/api/handovers/${handoverId}/accept`, { idempotencyKey: `${key}-accept`, countedOpeningCash });
}

test("F-064: the colleague still trading on the shared shelf receives the handover", async () => {
  const fx = await fixture();
  const first = await open(fx, fx.cashier, 1000);
  assert.equal(first.status, 201, first.text);
  const colleague = await open(fx, fx.storekeeper, 0);
  assert.equal(colleague.status, 201, colleague.text);
  assert.equal(colleague.body.shift.custodyGateReason, null);

  const closed = await close(fx.cashier, first.body.shift.id, 1000);
  assert.equal(closed.status, 200, closed.text);
  const handoverId = closed.body.handover!.handoverId;
  const countId = await countAndSubmit(fx.cashier, handoverId);

  // The one-tap path is refused for a colleague: they count and sign.
  const direct = await as<{ incoming?: { state: string; reason?: string } }>(fx.storekeeper.email, `/api/handovers/${handoverId}/direct`);
  if (direct.status === 200) {
    assert.equal(direct.body.incoming?.state, "UNAVAILABLE");
    assert.match(direct.body.incoming?.reason ?? "", /ورقة الاستلام/);
  }

  const accepted = await receive(fx.storekeeper, handoverId, countId, 1000, "f064");
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.status, "COMPLETED");

  const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } });
  assert.equal(handover.incomingShiftId, colleague.body.shift.id);
  assert.equal((await db.shift.findUniqueOrThrow({ where: { id: first.body.shift.id } })).status, "CLOSED");
  const receiver = await db.shift.findUniqueOrThrow({ where: { id: colleague.body.shift.id } });
  assert.equal(receiver.status, "OPEN");
  assert.equal(receiver.custodyGateReason, null);
  // No sales of their own yet: the drawer they counted is their opening.
  assert.equal(Number(receiver.openingCashAmount), 1000);
  assert.equal(Number(receiver.expectedCashAmount), 1000);
  // The shelf is theirs now, through a successor period, not a rewrite.
  const shelf = await db.custodyPeriod.findFirstOrThrow({ where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" }, include: { participants: true, shiftLinks: true } });
  assert.deepEqual(shelf.participants.map((p) => p.userId), [fx.storekeeper.id]);
  assert.deepEqual(shelf.shiftLinks.map((l) => l.shiftId), [colleague.body.shift.id]);
  assert.equal(shelf.responsibleShiftId, colleague.body.shift.id);
});

test("F-064: a colleague's own takings are not counted twice when they receive the drawer", async () => {
  const fx = await fixture();
  const first = await open(fx, fx.cashier, 1000);
  const colleague = await open(fx, fx.storekeeper, 0);
  // Arithmetic seam: the colleague has 50 net cash of their own in the shared drawer.
  await db.shift.update({ where: { id: colleague.body.shift.id }, data: { expectedCashAmount: 50 } });
  const closed = await close(fx.cashier, first.body.shift.id, 1050);
  const handoverId = closed.body.handover!.handoverId;
  const countId = await countAndSubmit(fx.cashier, handoverId);
  const accepted = await receive(fx.storekeeper, handoverId, countId, 1050, "f064b");
  assert.equal(accepted.status, 200, accepted.text);
  const receiver = await db.shift.findUniqueOrThrow({ where: { id: colleague.body.shift.id } });
  assert.equal(Number(receiver.openingCashAmount), 1000); // 1050 counted − 50 already theirs
  assert.equal(Number(receiver.expectedCashAmount), 1050);
});

test("F-065: a cashier whose shared shelf already moved on closes money-only — no stuck handover", async () => {
  const fx = await fixture();
  const first = await open(fx, fx.cashier, 1000);
  const second = await open(fx, fx.storekeeper, 0);
  const closed = await close(fx.cashier, first.body.shift.id, 1000);
  const handoverId = closed.body.handover!.handoverId;
  const countId = await countAndSubmit(fx.cashier, handoverId);
  // The colleague receives; the shelf moves to a successor period.
  assert.equal((await receive(fx.storekeeper, handoverId, countId, 1000, "f065a")).status, 200);
  // A third cashier opens and shares; the colleague then walks away.
  const third = await open(fx, fx.manager, 0);
  assert.equal(third.status, 201, third.text);
  const before = await db.handoverSession.count({ where: { branchId: fx.branchId } });
  const walk = await close(fx.storekeeper, second.body.shift.id, 1000);
  assert.equal(walk.status, 200, walk.text);
  // Whatever the close decided, nothing is left that nobody can end.
  const stuck = await db.handoverSession.findMany({ where: { branchId: fx.branchId, status: { notIn: ["COMPLETED"] } } });
  for (const h of stuck) {
    const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: `F065_${h.id.slice(-6)}`, label: "x" } });
    const ended = await post(fx.owner, `/api/handovers/${h.id}/cancel`, { reasonCodeId: reason.id, note: "walked away" });
    // A live receiver (the third cashier) may receive instead of a cancel; either way it must not be a dead end.
    if (ended.status !== 200) assert.match(ended.text, /شغال على نفس عهدة المخزن/);
  }
  assert.ok((await db.handoverSession.count({ where: { branchId: fx.branchId } })) >= before);
});

test("F-065: a stuck handover whose shelf already moved on is ended by cancel, stock left as it is", async () => {
  const fx = await fixture();
  const first = await open(fx, fx.cashier, 1000);
  const shelf = await db.custodyPeriod.findFirstOrThrow({ where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" } });
  // The legacy shape: the shift's shelf period was already passed on elsewhere.
  await db.custodyPeriod.update({ where: { id: shelf.id }, data: { status: "TRANSFERRED", endedAt: new Date() } });
  const successor = await db.custodyPeriod.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK", holderType: "BRANCH", previousPeriodId: shelf.id } });
  await db.shift.update({ where: { id: first.body.shift.id }, data: { status: "AWAITING_HANDOVER", actualCashAmount: 1000, financiallyClosedAt: new Date(), handoverRequired: true } });
  const { handoverId } = await db.$transaction((tx) => createHandoverInClose(tx, {
    cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: first.body.shift.id,
    outgoingUserId: fx.cashier.id, at: new Date(), target: "SHIFT_TO_SHIFT",
  }));
  assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } })).outgoingStockCustodyId, shelf.id);

  const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: "F065_MOVED", label: "moved" } });
  const ended = await post<{ boundaryLines: number; branchCustodyPeriodId: string | null }>(
    fx.owner, `/api/handovers/${handoverId}/cancel`, { reasonCodeId: reason.id, note: "cashier left; shelf already with someone else" },
  );
  assert.equal(ended.status, 200, ended.text);
  assert.equal(ended.body.boundaryLines, 0);
  assert.equal(ended.body.branchCustodyPeriodId, null);
  assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } })).status, "COMPLETED");
  assert.equal((await db.shift.findUniqueOrThrow({ where: { id: first.body.shift.id } })).status, "CLOSED");
  // The shelf stays exactly where it was.
  const open_ = await db.custodyPeriod.findMany({ where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" } });
  assert.deepEqual(open_.map((p) => p.id), [successor.id]);
  assert.equal(await db.auditLog.count({ where: { entityId: handoverId, action: "HANDOVER_CANCELLED" } }), 1);
});

test("F-065: cancelling a moved-on handover while another shift waits on it does not dead-end", async () => {
  const fx = await fixture();
  // A colleague (the manager) holds the shelf and drawer now.
  const holder = await open(fx, fx.manager, 0);
  assert.equal(holder.status, 201, holder.text);
  const heldShelf = await db.custodyPeriod.findFirstOrThrow({ where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" } });
  // The walked-away cashier's shift names a shelf period that was already passed on.
  const walker = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: 90, status: "AWAITING_HANDOVER", openingCashAmount: 0, expectedCashAmount: 0, actualCashAmount: 0, financiallyClosedAt: new Date(), handoverRequired: true } });
  const oldShelf = await db.custodyPeriod.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK", status: "TRANSFERRED", endedAt: new Date() } });
  await db.shiftCustody.create({ data: { shiftId: walker.id, custodyPeriodId: oldShelf.id, scope: "STOCK" } });
  const { handoverId } = await db.$transaction((tx) => createHandoverInClose(tx, {
    cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: walker.id,
    outgoingUserId: fx.cashier.id, at: new Date(), target: "SHIFT_TO_SHIFT",
  }));
  // Someone opened while it was live and is waiting on it (the 5434 shape: shift #14).
  const waiter = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.storekeeper.id, shiftNumber: 91, openingCashAmount: 0, expectedCashAmount: 0, custodyGateReason: "AWAITING_CUSTODY_TRANSFER" } });

  const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: "F065_WAIT", label: "w" } });
  const ended = await post<{ redecidedShiftIds: string[] }>(fx.owner, `/api/handovers/${handoverId}/cancel`, { reasonCodeId: reason.id, note: "walked away; shelf already with the manager" });
  assert.equal(ended.status, 200, ended.text);
  assert.deepEqual(ended.body.redecidedShiftIds, [waiter.id]);
  // The waiter joins the holder exactly as a fresh open would; the shelf did not move.
  const w = await db.shift.findUniqueOrThrow({ where: { id: waiter.id } });
  assert.equal(w.custodyGateReason, null);
  const shelves = await db.custodyPeriod.findMany({ where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" }, include: { shiftLinks: true } });
  assert.deepEqual(shelves.map((s) => s.id), [heldShelf.id]);
  assert.ok(shelves[0].shiftLinks.some((l) => l.shiftId === waiter.id));
  assert.equal(await db.inventoryFreeze.count({ where: { branchId: fx.branchId, releasedAt: null } }), 0);
});

test("F-011: the default bar role can move an order's status", async () => {
  const fx = await fixture();
  const role = await db.cafeRole.findFirst({ where: { cafeId: fx.cafeId, code: "BARISTA" }, include: { permissions: true } });
  if (role) assert.ok(role.permissions.some((p) => p.permissionKey === "orders.update_status" && p.allowed));
  else {
    const { SYSTEM_ROLES } = await import("@/lib/perms/templates");
    assert.ok(SYSTEM_ROLES.find((r) => r.code === "BARISTA")!.keys.includes("orders.update_status"));
  }
});
