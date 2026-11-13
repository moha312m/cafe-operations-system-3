// SHV2-006 — C2: accepting a handover the outgoing employee never finished.
//
// v2 makes a DRAFT handover acceptable ("DRAFT accepted"), while the outgoing
// employee may still press "start count" on it. The two requests take the
// same rows in opposite orders (acceptance: Shift → Handover; count start:
// Handover → Shift through the new count's foreign key). This suite:
//
//   1. races "start count" against "accept" on the same handover, 32 times in
//      a row at one branch, over HTTP (two server connections), and requires:
//      no 500, no deadlock in PostgreSQL's own counter, one completion, at
//      most one count, one snapshot row per item, one stock custody holder;
//   2. requires every acceptance without a CONFIRMED outgoing count to be
//      recorded as an UNCOUNTED handover (audit row, manager/owner
//      notification, report flag), never completed silently;
//   3. requires the branch to keep working afterwards: the next shift's
//      handover can still be counted (an unfinished count left behind must
//      not block the branch).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login } from "./helpers/http";
import { ensureCustodyForShift } from "@/lib/custody";
import { closeShiftWithSettlement } from "@/lib/cash-close";

let fx: CountCafe;
let other: { id: string; email: string };
let itemCount = 0;
let shiftNo = 0;
/** The operational shift holding the shelf when the first test ends. */
let holderAfterRace: { shiftId: string; user: { id: string; email: string } } | null = null;

before(async () => {
  fx = await countCafe("SHV2C2");
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY", recountRequiredOutsideTolerance: false, varianceBlocksHandover: false } });
  await countItem(fx, "Alpha", { stock: 10, isCritical: true });
  await countItem(fx, "Beta", { stock: 4, isCritical: true });
  itemCount = await db.inventoryItem.count({ where: { branchId: fx.branchId, isActive: true, archivedAt: null } });
  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  other = await db.user.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, email: `${fx.marker.toLowerCase()}-other@example.invalid`, name: `${fx.marker}-other`, role: "CASHIER", passwordHash: hash }, select: { id: true, email: true } });
  await login(other.email, COUNT_PASSWORD);
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [
    () => db.handoverRequiredItem.updateMany({ where: { handover: { cafeId: fx.cafeId } }, data: { satisfiedByLineId: null } }),
    () => db.handoverSession.updateMany({ where: { cafeId: fx.cafeId }, data: { stockCountSessionId: null, acceptedStockCountSessionId: null } }),
    () => db.stockCountSession.updateMany({ where: { cafeId: fx.cafeId }, data: { handoverId: null, lockedByHandoverId: null, accountabilityContext: "NONE" } }),
  ], { disconnect: true });
});

async function openShift(userId: string) {
  const s = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId, shiftNumber: ++shiftNo, openingCashAmount: 100, expectedCashAmount: 100 } });
  await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: s.id, userId, openingCashAmount: 100 }));
  return s;
}
async function closeIntoHandover(shiftId: string, actorId: string) {
  const closed = await closeShiftWithSettlement({ shiftId, actualCash: 100, actorId, closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", grants: { handoverSubmit: true, handoverException: true } });
  assert.ok(closed.handoverId, `no handover (${closed.status})`);
  return closed.handoverId!;
}
const post = <T = Record<string, unknown>>(email: string, path: string, body: unknown) =>
  as<T>(email, path, { method: "POST", body: JSON.stringify(body) });
async function deadlocks() {
  const rows = await db.$queryRaw<{ deadlocks: bigint }[]>`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
  return Number(rows[0].deadlocks);
}

/** Everything an uncounted acceptance must leave behind, checked once per handover. */
async function assertUncountedRecorded(hid: string, incomingShiftId: string) {
  const h = await db.handoverSession.findUniqueOrThrow({ where: { id: hid } });
  assert.equal(h.status, "COMPLETED");
  assert.equal(h.incomingShiftId, incomingShiftId);
  assert.equal(h.acceptedStockCountSessionId, null, "no confirmed outgoing count was accepted");
  assert.ok(await db.stockCountSession.count({ where: { handoverId: hid } }) <= 1, "at most one outgoing count");
  const boundary = await db.handoverStockBoundary.findMany({ where: { handoverId: hid } });
  assert.equal(boundary.length, itemCount, "a stock snapshot row per item, written once");
  assert.ok(boundary.every((b) => b.verified === false), "carried at the book figure, never claimed as counted");
  const audits = await db.auditLog.findMany({ where: { entity: "HandoverSession", entityId: hid, action: "STOCK_HANDOVER_ACCEPTED_UNCOUNTED" } });
  assert.equal(audits.length, 1, "recorded explicitly as an uncounted handover, once");
  const told = await db.notification.findMany({ where: { handoverId: hid, kind: "STOCK_HANDOVER_MISSING_COUNT" } });
  const ids = told.map((n) => n.recipientId);
  assert.ok(ids.includes(fx.owner.id) && ids.includes(fx.manager.id), "the owner and the manager are told");
  assert.equal(new Set(ids).size, ids.length, "once per recipient");
  const holders = await db.custodyPeriod.findMany({ where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" } });
  assert.equal(holders.length, 1, "one stock custody holder");
  assert.equal(holders[0].responsibleShiftId, incomingShiftId);
}

test("start count and accept at the same moment, 32 times: no deadlock, no 500, no double write, never silent", async () => {
  const users = [{ id: fx.cashier.id, email: fx.cashier.email }, other];
  let holder = await openShift(users[0].id);
  let holderUser = users[0];
  const tally = { acceptWon: 0, countWon: 0, both: 0 };
  const handovers: string[] = [];
  const before = await deadlocks();
  for (let i = 0; i < 32; i++) {
    const hid = await closeIntoHandover(holder.id, holderUser.id);
    handovers.push(hid);
    const nextUser = users[(i + 1) % 2];
    const next = await openShift(nextUser.id);
    // Staggered by 0-525 ms, alternating which request leaves first, so the
    // rows are taken in every order: count first, acceptance first, interleaved.
    const offset = (i % 8) * 75;
    const later = <T>(ms: number, run: () => Promise<T>) => new Promise<T>((resolve, reject) => setTimeout(() => run().then(resolve, reject), ms));
    const t0 = Date.now();
    const [count, accept] = await Promise.all([
      later(i % 2 === 0 ? offset : 0, () => post<{ countSession?: { id: string } }>(holderUser.email, "/api/handovers", { action: "start_count", handoverId: hid })),
      later(i % 2 === 1 ? offset : 0, () => post<{ status?: string }>(nextUser.email, `/api/handovers/${hid}/accept`, { idempotencyKey: crypto.randomUUID(), countedOpeningCash: 100 })),
    ]);
    const took = Date.now() - t0;
    for (const [name, r] of [["start_count", count], ["accept", accept]] as const) {
      assert.ok(r.status === 200 || r.status === 409, `round ${i} ${name}: ${r.status} ${r.text}`);
    }
    assert.ok(took < 30_000, `round ${i}: the pair took ${took} ms (a lock wait, not a refusal)`);
    if (accept.status === 200) {
      assert.equal(accept.body.status, "COMPLETED");
      if (count.status === 200) tally.both += 1; else tally.acceptWon += 1;
      if (count.status === 409) assert.match(count.text, /التسليم مش في حالة تسمح ببدء الجرد|مشغول/, `round ${i}: a count start after the handover was received is refused plainly`);
    } else {
      assert.equal(count.status, 200, `round ${i}: both refused`);
      tally.countWon += 1;
      // The count won the race; the receiver simply tries again and is never blocked by it.
      const retry = await post<{ status: string }>(nextUser.email, `/api/handovers/${hid}/accept`, { idempotencyKey: crypto.randomUUID(), countedOpeningCash: 100 });
      assert.equal(retry.status, 200, `round ${i} retry: ${retry.text}`);
      assert.equal(retry.body.status, "COMPLETED");
    }
    await assertUncountedRecorded(hid, next.id);
    holder = next;
    holderUser = nextUser;
  }
  await new Promise((r) => setTimeout(r, 2000)); // cumulative stats flush at most once a second
  assert.equal(await deadlocks(), before, "PostgreSQL detected no deadlock");
  console.log(`C2 race tally ${JSON.stringify(tally)}`);

  // The branch keeps working: the last holder's handover can still be counted and finished.
  const last = await closeIntoHandover(holder.id, holderUser.id);
  const started = await post<{ countSession: { id: string } }>(holderUser.email, "/api/handovers", { action: "start_count", handoverId: last });
  assert.equal(started.status, 200, `an unfinished count left behind must not block the next count: ${started.text}`);
  const finished = await post<{ status: string }>(holderUser.email, "/api/handovers", { action: "finish_outgoing", handoverId: last });
  assert.equal(finished.status, 200, finished.text);
  const lastUser = users.find((u) => u.id !== holderUser.id)!;
  const lastShift = await openShift(lastUser.id);
  const lastAccepted = await post<{ status: string }>(lastUser.email, `/api/handovers/${last}/accept`, { idempotencyKey: crypto.randomUUID(), countedOpeningCash: 100 });
  assert.equal(lastAccepted.status, 200, lastAccepted.text);
  holderAfterRace = { shiftId: lastShift.id, user: lastUser };

  // The report shows every one of them as received without a confirmed count.
  const list = await as<{ rows: { handoverId: string; uncountedAcceptance: boolean; result: string }[] }>(fx.owner.email, `/api/stock-handover-reports?branchId=${fx.branchId}`);
  assert.equal(list.status, 200, list.text);
  for (const hid of handovers) {
    const row = list.body.rows.find((r) => r.handoverId === hid);
    assert.ok(row, `handover ${hid} is in the report`);
    assert.equal(row.uncountedAcceptance, true);
    assert.equal(row.result, "MISSING");
  }
});

test("an outgoing count left unfinished is recorded as such when the handover is received", async () => {
  assert.ok(holderAfterRace, "runs after the race test, on the shift holding the shelf");
  const cashier = holderAfterRace.user;
  const receiver = cashier.id === fx.cashier.id ? other : { id: fx.cashier.id, email: fx.cashier.email };
  const hid = await closeIntoHandover(holderAfterRace.shiftId, cashier.id);
  const started = await post<{ countSession: { id: string } }>(cashier.email, "/api/handovers", { action: "start_count", handoverId: hid });
  assert.equal(started.status, 200, started.text);
  const sid = started.body.countSession.id;
  const line = await db.stockCountLine.findFirstOrThrow({ where: { sessionId: sid }, orderBy: { id: "asc" } });
  const counted = await as(cashier.email, `/api/stock-counts/${sid}/lines/${line.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: 3, expectedCountedAt: null }) });
  assert.equal(counted.status, 200, counted.text);
  // The outgoing employee walks out without finishing.
  const next = await openShift(receiver.id);
  const accepted = await post<{ status: string }>(receiver.email, `/api/handovers/${hid}/accept`, { idempotencyKey: crypto.randomUUID(), countedOpeningCash: 100 });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.status, "COMPLETED");
  await assertUncountedRecorded(hid, next.id);
  const audit = await db.auditLog.findFirstOrThrow({ where: { entity: "HandoverSession", entityId: hid, action: "STOCK_HANDOVER_ACCEPTED_UNCOUNTED" } });
  const details = audit.details as { outgoingCountSessionId: string; outgoingCountStatus: string; outgoingLinesObserved: number; outgoingLines: number };
  assert.equal(details.outgoingCountSessionId, sid);
  assert.equal(details.outgoingCountStatus, "IN_PROGRESS", "what the outgoing count was at acceptance is on the record");
  assert.equal(details.outgoingLinesObserved, 1);
  assert.equal(details.outgoingLines, itemCount);
  // Closed as history (as the owner-approved cancel closes one), so the branch can count again.
  assert.equal((details as { lockedUnfinishedCountSessionId?: string }).lockedUnfinishedCountSessionId, sid);
  const closedCount = await db.stockCountSession.findUniqueOrThrow({ where: { id: sid } });
  assert.equal(closedCount.status, "LOCKED");
  assert.equal(closedCount.lockedByHandoverId, hid);
  assert.equal(closedCount.confirmedAt, null, "closed, never presented as confirmed");
  // The partial count stays readable as evidence; nothing was rebased from it.
  assert.equal(Number((await db.stockCountLine.findUniqueOrThrow({ where: { id: line.id } })).countedQuantity), 3);
  const book = Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: line.inventoryItemId } })).currentStock);
  assert.ok(book === 10 || book === 4, `a count is not a posting (book ${book})`);
});
