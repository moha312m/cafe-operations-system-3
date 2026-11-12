// P1 — a branch no shift can open on gets a way out, and the routes that put
// branches there stop doing it. Owner decisions 2026-11-11:
//   Q1 a manager «إصلاح عهدة الفرع» with reason + note; the shelf goes to the
//      branch uncounted and the waiting cashier does the morning count;
//   Q2 a shift that never received the shelf closes money-only, and a
//      handover already stuck that way can be ended by the manager's cancel;
//   Q3 on an unverified branch morning a second cashier waits.
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
  const fx = await countCafe("P1RECOVER");
  cafes.push(fx.cafeId);
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "HYBRID", handoverCountType: "FULL" } });
  await countItem(fx, "Shelf", { stock: 10, isCritical: true });
  // A second person allowed to open a shift.
  await db.user.update({ where: { id: fx.storekeeper.id }, data: { role: "CASHIER" } });
  return fx;
}

const post = <T,>(a: CountActor, url: string, body: unknown) =>
  as<T>(a.email, url, { method: "POST", body: JSON.stringify(body) });
const open = (fx: CountCafe, a: CountActor, openingCashAmount = 1000) =>
  post<{ shift: { id: string; custodyGateReason: string | null }; openingBlocker?: { code: string } }>(
    a, "/api/shifts", { branchId: fx.branchId, openingCashAmount },
  );
const close = (a: CountActor, id: string, handoverTarget?: string, actualCashAmount = 1000) =>
  post<{ handover?: { handoverId: string } | null }>(a, `/api/shifts/${id}/close`, { actualCashAmount, handoverTarget });
const reason = (fx: CountCafe, code: string) =>
  db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code, label: code } });
const repair = (fx: CountCafe, a: CountActor, body: Record<string, unknown>) =>
  post<{ repaired: string; alreadyRepaired: boolean; branchStockCustodyId: string | null; openedCashCustodyId: string | null; closedCashCustodyId: string | null; closingCashAmount: number | null; waitingShiftId: string | null }>(
    a, `/api/branches/${fx.branchId}/custody-repair`, body,
  );
const openPeriods = (fx: CountCafe) =>
  db.custodyPeriod.findMany({ where: { branchId: fx.branchId, status: "OPEN" }, include: { shiftLinks: true } });

/** A branch-custody morning: last night's handover ended into the branch. */
async function branchMorning(fx: CountCafe) {
  const night = await open(fx, fx.manager);
  assert.equal(night.status, 201, night.text);
  const closed = await close(fx.manager, night.body.shift.id, "BRANCH_CUSTODY");
  assert.equal(closed.status, 200, closed.text);
  const r = await reason(fx, `NIGHT_${Date.now()}`);
  const ended = await post(fx.owner, `/api/handovers/${closed.body.handover!.handoverId}/cancel`, { reasonCodeId: r.id, note: "night" });
  assert.equal(ended.status, 200, ended.text);
}

test("Q2: a morning cashier who never received the shelf closes money-only — no handover, no freeze", async () => {
  const fx = await fixture();
  await branchMorning(fx);
  const morning = await open(fx, fx.cashier);
  assert.equal(morning.body.shift.custodyGateReason, "AWAITING_OPENING_VERIFICATION");
  const handoversBefore = await db.handoverSession.count({ where: { branchId: fx.branchId } });

  const closed = await close(fx.cashier, morning.body.shift.id, "SHIFT_TO_SHIFT", 1000);
  assert.equal(closed.status, 200, closed.text);
  assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), handoversBefore);
  assert.equal(await db.inventoryFreeze.count({ where: { branchId: fx.branchId, releasedAt: null } }), 0);
  const shift = await db.shift.findUniqueOrThrow({ where: { id: morning.body.shift.id } });
  assert.equal(shift.status, "CLOSED");
  assert.equal(await db.shiftMaterialsDecision.count({ where: { shiftId: shift.id } }), 0);
  const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: shift.id, action: "SHIFT_CLOSED" } });
  assert.equal((audit.details as { shiftHeldStock: boolean }).shiftHeldStock, false);
  // The drawer is discharged; the shelf is still the branch's, untouched.
  const periods = await openPeriods(fx);
  assert.deepEqual(periods.map((p) => `${p.scope}:${p.holderType}`), ["STOCK:BRANCH"]);

  // The next cashier opens onto the same morning count with a drawer of their own.
  const next = await open(fx, fx.storekeeper);
  assert.equal(next.status, 201, next.text);
  assert.equal(next.body.shift.custodyGateReason, "AWAITING_OPENING_VERIFICATION");
  const drawer = (await openPeriods(fx)).find((p) => p.scope === "CASH")!;
  assert.deepEqual(drawer.shiftLinks.map((l) => l.shiftId), [next.body.shift.id]);
});

test("Q2: a handover already stuck without stock custody can be ended by the manager's cancel", async () => {
  const fx = await fixture();
  await branchMorning(fx);
  const morning = await open(fx, fx.cashier);
  const branchStock = (await openPeriods(fx)).find((p) => p.scope === "STOCK")!;
  // The shape the old close left: money settled, a handover naming no stock, a freeze.
  await db.shift.update({ where: { id: morning.body.shift.id }, data: { status: "AWAITING_HANDOVER", actualCashAmount: 1000, financiallyClosedAt: new Date(), handoverRequired: true } });
  const { handoverId } = await db.$transaction((tx) => createHandoverInClose(tx, {
    cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: morning.body.shift.id,
    outgoingUserId: fx.cashier.id, at: new Date(), target: "SHIFT_TO_SHIFT",
  }));
  assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } })).outgoingStockCustodyId, null);

  const r = await reason(fx, "STUCK");
  const ended = await post<{ branchCustodyPeriodId: string | null; freezeReleased: boolean; boundaryLines: number }>(
    fx.owner, `/api/handovers/${handoverId}/cancel`, { reasonCodeId: r.id, note: "closed before the morning count" },
  );
  assert.equal(ended.status, 200, ended.text);
  assert.equal(ended.body.freezeReleased, true);
  assert.equal(ended.body.boundaryLines, 0);
  assert.equal(ended.body.branchCustodyPeriodId, null);
  const handover = await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId } });
  assert.equal(handover.status, "COMPLETED");
  assert.equal(handover.exceptionById, fx.owner.id);
  assert.equal(await db.handoverStockBoundary.count({ where: { handoverId } }), 0);
  assert.equal(await db.openingException.count({ where: { handoverId, kind: "NO_INCOMING" } }), 1);
  assert.equal(await db.auditLog.count({ where: { entityId: handoverId, action: "HANDOVER_CANCELLED" } }), 1);
  assert.equal((await db.shift.findUniqueOrThrow({ where: { id: morning.body.shift.id } })).status, "CLOSED");
  // The shelf is left exactly as it was: the same branch period, still open.
  const stockNow = (await openPeriods(fx)).filter((p) => p.scope === "STOCK");
  assert.deepEqual(stockNow.map((p) => p.id), [branchStock.id]);
  // Replay answers, it does not repeat.
  const again = await post<{ alreadyCompleted: boolean }>(fx.owner, `/api/handovers/${handoverId}/cancel`, { reasonCodeId: r.id, note: "again" });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.alreadyCompleted, true);
});

test("Q3: on an unverified branch morning the second cashier waits, and nothing of their shift remains", async () => {
  const fx = await fixture();
  await branchMorning(fx);
  const first = await open(fx, fx.cashier);
  assert.equal(first.status, 201, first.text);
  const shiftsBefore = await db.shift.count({ where: { branchId: fx.branchId } });
  const second = await open(fx, fx.storekeeper);
  assert.equal(second.status, 409, second.text);
  assert.match(second.text, /مستني الجرد الافتتاحي/);
  assert.equal(await db.shift.count({ where: { branchId: fx.branchId } }), shiftsBefore);
  // The first cashier's drawer has no second holder, and their count can start.
  const drawer = (await openPeriods(fx)).find((p) => p.scope === "CASH")!;
  assert.equal(drawer.shiftLinks.length, 1);
  const start = await post(fx.manager, "/api/custody/opening-verification", { action: "start_count", branchId: fx.branchId, shiftId: first.body.shift.id });
  assert.equal(start.status, 200, start.text);
});

test("Q1: a waiting shift whose branch lost its shelf is repaired onto the morning count, on the record and once", async () => {
  const fx = await fixture();
  await branchMorning(fx);
  const waiting = await open(fx, fx.cashier);
  // The 5434 demo-branch shape: the branch's shelf period gone, the waiter's drawer still open.
  await db.custodyPeriod.updateMany({ where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" }, data: { status: "CLOSED", endedAt: new Date() } });
  const blocked = await open(fx, fx.storekeeper);
  assert.equal(blocked.status, 409, blocked.text);
  assert.deepEqual(blocked.body.openingBlocker, { code: "CASH_WITHOUT_STOCK" });

  const r = await reason(fx, "REPAIR");
  // Who, and with what.
  assert.equal((await repair(fx, fx.cashier, { reasonCodeId: r.id, note: "x", idempotencyKey: "cashier-try-1" })).status, 403);
  assert.equal((await repair(fx, fx.owner, { note: "x", idempotencyKey: "no-reason-1" })).status, 400);
  assert.equal((await repair(fx, fx.owner, { reasonCodeId: r.id, note: "  ", idempotencyKey: "no-note-1" })).status, 400);

  const key = `repair-${Date.now()}`;
  const fixed = await repair(fx, fx.owner, { reasonCodeId: r.id, note: "shelf record lost", idempotencyKey: key });
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(fixed.body.repaired, "CASH_WITHOUT_STOCK");
  assert.equal(fixed.body.waitingShiftId, waiting.body.shift.id);
  assert.equal(fixed.body.closedCashCustodyId, null);
  const periods = await openPeriods(fx);
  assert.deepEqual(periods.map((p) => `${p.scope}:${p.holderType}`).sort(), ["CASH:USER", "STOCK:BRANCH"]);
  assert.equal(periods.find((p) => p.scope === "STOCK")!.id, fixed.body.branchStockCustodyId);
  assert.equal((await db.shift.findUniqueOrThrow({ where: { id: waiting.body.shift.id } })).custodyGateReason, "AWAITING_OPENING_VERIFICATION");
  const exception = await db.openingException.findFirstOrThrow({ where: { branchId: fx.branchId, kind: "MANAGER_ADJUSTMENT" } });
  assert.equal(exception.authorizedById, fx.owner.id);
  assert.equal(exception.reasonCodeId, r.id);
  assert.equal(exception.custodyPeriodId, fixed.body.branchStockCustodyId);
  assert.equal(await db.auditLog.count({ where: { entityId: fx.branchId, action: "BRANCH_CUSTODY_REPAIRED" } }), 1);

  // A lost response retried with the same key replays; a new key finds nothing to do.
  const replay = await repair(fx, fx.owner, { reasonCodeId: r.id, note: "shelf record lost", idempotencyKey: key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.body.alreadyRepaired, true);
  assert.equal(replay.body.branchStockCustodyId, fixed.body.branchStockCustodyId);
  const fresh = await repair(fx, fx.owner, { reasonCodeId: r.id, note: "again", idempotencyKey: `${key}-b` });
  assert.equal(fresh.status, 409, fresh.text);
  assert.equal(await db.custodyPeriod.count({ where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" } }), 1);
  assert.equal(await db.auditLog.count({ where: { entityId: fx.branchId, action: "BRANCH_CUSTODY_REPAIRED" } }), 1);

  // The waiting cashier's morning count can now start.
  const start = await post(fx.manager, "/api/custody/opening-verification", { action: "start_count", branchId: fx.branchId, shiftId: waiting.body.shift.id });
  assert.equal(start.status, 200, start.text);
});

test("Q1: a drawer nobody's open shift uses is closed at its last counted figure, and the next shift opens", async () => {
  const fx = await fixture();
  const night = await open(fx, fx.manager);
  // Historical shape: the night shift closed with 750 counted, its drawer period left open, no shelf.
  await db.shift.update({ where: { id: night.body.shift.id }, data: { status: "CLOSED", closedAt: new Date(), actualCashAmount: 750 } });
  await db.custodyPeriod.updateMany({ where: { branchId: fx.branchId, scope: "STOCK" }, data: { status: "CLOSED", endedAt: new Date() } });
  const blocked = await open(fx, fx.cashier);
  assert.equal(blocked.status, 409, blocked.text);

  const r = await reason(fx, "ORPHAN");
  const fixed = await repair(fx, fx.owner, { reasonCodeId: r.id, note: "drawer left open", idempotencyKey: `orphan-${Date.now()}` });
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(fixed.body.closingCashAmount, 750);
  assert.equal(fixed.body.waitingShiftId, null);
  const drawer = await db.custodyPeriod.findUniqueOrThrow({ where: { id: fixed.body.closedCashCustodyId! } });
  assert.equal(drawer.status, "CLOSED");
  assert.equal(drawer.closingCashAmount?.toString(), "750");
  const next = await open(fx, fx.cashier);
  assert.equal(next.status, 201, next.text);
  assert.equal(next.body.shift.custodyGateReason, "AWAITING_OPENING_VERIFICATION");
});

test("Q1: a trading shift with no drawer custody gets one at its own opening amount", async () => {
  const fx = await fixture();
  const holder = await open(fx, fx.manager, 400);
  await db.custodyPeriod.updateMany({ where: { branchId: fx.branchId, scope: "CASH" }, data: { status: "CLOSED", endedAt: new Date() } });
  await db.shiftCustody.deleteMany({ where: { shiftId: holder.body.shift.id, scope: "CASH" } });
  const r = await reason(fx, "NODRAWER");
  const fixed = await repair(fx, fx.owner, { reasonCodeId: r.id, note: "drawer record missing", idempotencyKey: `nodrawer-${Date.now()}` });
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(fixed.body.repaired, "STOCK_WITHOUT_CASH");
  const drawer = await db.custodyPeriod.findUniqueOrThrow({ where: { id: fixed.body.openedCashCustodyId! }, include: { shiftLinks: true, participants: true } });
  assert.equal(drawer.openingCashAmount?.toString(), "400");
  assert.deepEqual(drawer.shiftLinks.map((l) => l.shiftId), [holder.body.shift.id]);
  assert.deepEqual(drawer.participants.map((p) => p.userId), [fx.manager.id]);
  const colleague = await open(fx, fx.cashier);
  assert.equal(colleague.status, 201, colleague.text);
});

test("Q1: the repair refuses a healthy branch and a branch with a live handover", async () => {
  const fx = await fixture();
  const r = await reason(fx, "NOPE");
  const healthy = await repair(fx, fx.owner, { reasonCodeId: r.id, note: "check", idempotencyKey: `healthy-${Date.now()}` });
  assert.equal(healthy.status, 409, healthy.text);
  const shift = await open(fx, fx.manager);
  const closed = await close(fx.manager, shift.body.shift.id, "BRANCH_CUSTODY");
  assert.equal(closed.status, 200, closed.text);
  const live = await repair(fx, fx.owner, { reasonCodeId: r.id, note: "check", idempotencyKey: `live-${Date.now()}` });
  assert.equal(live.status, 409, live.text);
  assert.match(live.text, /تسليم عهدة شغال/);
  assert.equal(await db.auditLog.count({ where: { entityId: fx.branchId, action: "BRANCH_CUSTODY_REPAIRED" } }), 0);
});
