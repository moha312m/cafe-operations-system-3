// Stock handover v2 — the whole journey over HTTP (owner decision 2026-11-12).
//
//   * closing a shift with a handover takes NO freeze; stock keeps moving;
//   * the outgoing employee may finish with no count at all (reported, not refused);
//   * the incoming employee counts blind, records revisions, submits;
//   * the comparison adds the recorded movement between the two cursors;
//   * any nonzero raw/adjusted difference notifies each branch manager and owner
//     exactly once per comparison version, in the submitting transaction;
//   * a correction after submission needs a reason, is a new revision, and
//     produces a new comparison version (the old one stays);
//   * review notes are append-only; status/classification move only with a note;
//   * nothing here posts stock: the item balance is untouched by every count.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import bcrypt from "bcryptjs";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

const MARKER = tag("SHV2002");
let fx: CountCafe;
const items: { id: string; name: string }[] = [];
let incoming: { id: string; email: string };
let seq = 0;
const key = (label: string) => `${MARKER}-${label}-${++seq}-${Date.now()}`;

type CashCloseLib = typeof import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
type LedgerLib = typeof import("@/lib/ledger");

async function openOperationalShift(userId: string, openingCash = 100) {
  const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
  const shift = await db.shift.create({
    data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId, shiftNumber: (last._max.shiftNumber ?? 0) + 1, openingCashAmount: openingCash, expectedCashAmount: openingCash },
  });
  const { ensureCustodyForShift } = (await import("@/lib/custody")) as CustodyLib;
  await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: shift.id, userId, openingCashAmount: openingCash }));
  return shift;
}

const incomingPost = (email: string, handoverId: string, body: unknown, idem = key("in")) =>
  as<Record<string, unknown> & { error?: string }>(email, `/api/handovers/${handoverId}/incoming-count`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": idem } });
const reviewPost = (email: string, handoverId: string, body: unknown, idem = key("rv")) =>
  as<Record<string, unknown> & { error?: string }>(email, `/api/stock-handover-reports/${handoverId}`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": idem } });

async function sell(itemId: string, quantity: number) {
  const { applyStockMutation } = (await import("@/lib/ledger")) as LedgerLib;
  await db.$transaction((tx) => applyStockMutation(tx, {
    inventoryItemId: itemId, type: "ADJUSTMENT", quantity: -quantity, cafeId: fx.cafeId, branchId: fx.branchId,
    createdById: fx.manager.id, note: `${MARKER} recorded movement between the counts`,
  }));
}

before(async () => {
  await requireServer();
  fx = await countCafe("SHV2002");
  for (const k of ["milk", "beans"]) {
    const created = await countItem(fx, k, { stock: 10, isCritical: true });
    items.push({ id: created.id, name: created.name });
  }
  // The arriving employee: a plain cashier (managers may see both counts by design).
  const hash = await bcrypt.hash(COUNT_PASSWORD, 10);
  incoming = await db.user.create({ data: { email: `${fx.marker.toLowerCase()}-incoming@example.invalid`, name: `${fx.marker}-incoming`, passwordHash: hash, role: "CASHIER", cafeId: fx.cafeId, branchId: fx.branchId }, select: { id: true, email: true } });
  await login(incoming.email, COUNT_PASSWORD);
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY", periodicFullCountWeekday: null, varianceBlocksHandover: false, varianceHardBlockAmount: null },
  });
});

after(async () => {
  await teardownTaggedCafe([fx?.cafeId].filter((id): id is string => Boolean(id)), [], { disconnect: true });
});

describe("stock handover v2 journey", () => {
  let handoverId = "";
  let outgoingShiftId = "";

  test("closing with a handover takes no freeze, and stock keeps moving", async () => {
    const shift = await openOperationalShift(fx.cashier.id);
    outgoingShiftId = shift.id;
    const { closeShiftWithSettlement } = (await import("@/lib/cash-close")) as CashCloseLib;
    const closed = await closeShiftWithSettlement({
      shiftId: shift.id, actualCash: 100, actorId: fx.cashier.id, closedByManager: false,
      handoverTarget: "SHIFT_TO_SHIFT", grants: { handoverSubmit: true, handoverException: true },
    });
    assert.ok(closed.handoverId, `no handover (${closed.status})`);
    assert.equal(closed.freezeId, null);
    handoverId = closed.handoverId!;
    assert.equal(await db.inventoryFreeze.count({ where: { branchId: fx.branchId, releasedAt: null } }), 0);
    await sell(items[0].id, 1); // refused under the old freeze; recorded now
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: items[0].id } })).currentStock), 9);
  });

  test("the outgoing employee counts one item and finishes; nothing is refused or posted", async () => {
    const started = await as<{ countSession: { id: string } }>(fx.cashier.email, "/api/handovers", { method: "POST", body: JSON.stringify({ action: "start_count", handoverId }) });
    assert.equal(started.status, 200, started.text);
    const sessionId = started.body.countSession.id;
    const milkLine = await db.stockCountLine.findFirstOrThrow({ where: { sessionId, inventoryItemId: items[0].id } });
    const r = await as(fx.cashier.email, `/api/stock-counts/${sessionId}/lines/${milkLine.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: 9 }) });
    assert.ok(r.status < 300, r.text);
    // beans deliberately NOT counted by the outgoing employee
    const fin = await as<{ status: string; notCounted?: string[] }>(fx.cashier.email, "/api/handovers", { method: "POST", body: JSON.stringify({ action: "finish_outgoing", handoverId }) });
    assert.equal(fin.status, 200, fin.text);
    assert.equal(fin.body.status, "OUTGOING_SUBMITTED");
    assert.deepEqual(fin.body.notCounted, [items[1].name]);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: items[0].id } })).currentStock), 9, "a count is not a posting");
  });

  test("a sale between the counts; the incoming count is blind until submitted", async () => {
    await sell(items[0].id, 2); // milk 9 → 7, recorded
    const s = await incomingPost(incoming.email, handoverId, { action: "start" });
    assert.equal(s.status, 201, s.text);
    const view = await as<{ comparison: unknown; items: { id: string }[] }>(incoming.email, `/api/handovers/${handoverId}/incoming-count`);
    assert.equal(view.status, 200, view.text);
    assert.equal(view.body.comparison, null, "no outgoing figure reaches the incoming counter before submitting");
    assert.ok(!JSON.stringify(view.body).includes('"9.000"'), "the outgoing quantity is not in the response");
  });

  test("lines are revisions with cursors; a retry with the same key writes nothing twice", async () => {
    const idem = key("milk1");
    const a = await incomingPost(incoming.email, handoverId, { action: "line", inventoryItemId: items[0].id, quantity: "6.5" }, idem);
    assert.equal(a.status, 201, a.text);
    const again = await incomingPost(incoming.email, handoverId, { action: "line", inventoryItemId: items[0].id, quantity: "6.5" }, idem);
    assert.equal(again.headers.get("Idempotency-Replayed"), "true", again.text);
    assert.equal(again.body.lineId, a.body.lineId);
    const fix = await incomingPost(incoming.email, handoverId, { action: "line", inventoryItemId: items[0].id, quantity: "7" });
    assert.equal(fix.status, 201, fix.text);
    assert.equal(fix.body.revision, 2);
    const b = await incomingPost(incoming.email, handoverId, { action: "line", inventoryItemId: items[1].id, quantity: "10" });
    assert.equal(b.status, 201, b.text);
    const rows = await db.stockHandoverIncomingLine.findMany({ where: { count: { handoverId } }, orderBy: [{ inventoryItemId: "asc" }, { revision: "asc" }] });
    assert.equal(rows.length, 3);
    assert.equal(rows.find((r) => r.revision === 2)?.reason, "PRE_SUBMIT_EDIT");
    await assert.rejects(db.stockHandoverIncomingLine.update({ where: { id: rows[0].id }, data: { quantity: 1 } }), "lines are append-only in the database");
  });

  test("submitting compares with the movement window and notifies once per recipient", async () => {
    const sub = await incomingPost(incoming.email, handoverId, { action: "submit" });
    assert.equal(sub.status, 200, sub.text);
    const c = sub.body.comparison as { lines: { inventoryItemId: string; raw: string | null; netMovement: string | null; adjusted: string | null; label: string; reliability: string }[]; rawDifferenceCount: number; adjustedDifferenceCount: number };
    const milk = c.lines.find((l) => l.inventoryItemId === items[0].id)!;
    assert.equal(milk.raw, "-2.000");
    assert.equal(milk.netMovement, "-2.000");
    assert.equal(milk.adjusted, "0.000");
    assert.equal(milk.label, "EXPLAINED_BY_MOVEMENTS");
    assert.equal(milk.reliability, "CONFIRMED");
    const beans = c.lines.find((l) => l.inventoryItemId === items[1].id)!;
    assert.equal(beans.label, "UNAVAILABLE", "the outgoing never counted beans; never treated as zero");
    assert.equal(beans.raw, null);

    const recipients = [fx.manager.id, fx.owner.id].sort();
    const notes = await db.notification.findMany({ where: { handoverId, kind: "STOCK_HANDOVER_DISCREPANCY" } });
    assert.deepEqual(notes.map((n) => n.recipientId).sort(), recipients);
    assert.ok(!notes.some((n) => n.recipientId === fx.cashier.id || n.recipientId === incoming.id), "the counted employees are not the recipients");

    const replay = await incomingPost(incoming.email, handoverId, { action: "submit" });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.alreadySubmitted, true, "a second submit (new key) is answered from what exists");
    assert.equal(await db.notification.count({ where: { handoverId, kind: "STOCK_HANDOVER_DISCREPANCY" } }), 2, "deduplicated per comparison and recipient");
    assert.equal(await db.stockHandoverComparison.count({ where: { handoverId } }), 1);
  });

  test("a correction after submission needs a reason and makes a new comparison version", async () => {
    const refused = await incomingPost(incoming.email, handoverId, { action: "line", inventoryItemId: items[0].id, quantity: "6" });
    assert.equal(refused.status, 400, refused.text);
    const ok = await incomingPost(incoming.email, handoverId, { action: "line", inventoryItemId: items[0].id, quantity: "6", reason: "عدّيت كرتونة مرتين" });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(await db.stockHandoverComparison.count({ where: { handoverId } }), 2, "the earlier version stays on record");
    const latest = await db.stockHandoverComparison.findFirstOrThrow({ where: { handoverId }, orderBy: { computedAt: "desc" } });
    assert.equal(latest.adjustedDifferenceCount, 1);
    assert.equal(await db.notification.count({ where: { handoverId, kind: "STOCK_HANDOVER_DISCREPANCY" } }), 4, "one more per recipient for the new version");
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: items[0].id } })).currentStock), 7, "still no stock posting");
  });

  test("the review is append-only and kept by managers and owners", async () => {
    const denied = await reviewPost(fx.cashier.email, handoverId, { text: "مش من حقي" });
    assert.equal(denied.status, 403, denied.text);
    const empty = await reviewPost(fx.manager.email, handoverId, { text: "  ", status: "IN_REVIEW" });
    assert.equal(empty.status, 400, empty.text);
    const first = await reviewPost(fx.manager.email, handoverId, { text: "بدأت أراجع اللبن", status: "IN_REVIEW", classification: "COUNT_ERROR" });
    assert.equal(first.status, 201, first.text);
    const done = await reviewPost(fx.owner.email, handoverId, { text: "اتأكدت — غلط عدّ، اتعملت تسوية من شاشة المخزون", status: "RESOLVED" });
    assert.equal(done.status, 201, done.text);
    const review = await db.stockHandoverReview.findUniqueOrThrow({ where: { handoverId }, include: { notes: { orderBy: { createdAt: "asc" } } } });
    assert.equal(review.status, "RESOLVED");
    assert.equal(review.classification, "COUNT_ERROR");
    assert.equal(review.notes.length, 2);
    assert.equal(review.notes[0].statusFrom, "OPEN");
    assert.equal(review.notes[1].statusTo, "RESOLVED");
    await assert.rejects(db.stockHandoverReviewNote.update({ where: { id: review.notes[0].id }, data: { text: "x" } }), "notes are append-only");

    const detail = await as<{ comparison: { lines: unknown[] }; history: unknown[]; review: { notes: unknown[] } }>(fx.manager.email, `/api/stock-handover-reports/${handoverId}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.history.length, 2);
    assert.equal(detail.body.review.notes.length, 2);
  });

  test("the report lists, filters and exports", async () => {
    const list = await as<{ rows: { handoverId: string; result: string; reviewStatus: string }[] }>(fx.owner.email, "/api/stock-handover-reports?result=UNEXPLAINED");
    assert.equal(list.status, 200, list.text);
    assert.ok(list.body.rows.some((r) => r.handoverId === handoverId && r.reviewStatus === "RESOLVED"));
    const none = await as<{ rows: { handoverId: string }[] }>(fx.owner.email, "/api/stock-handover-reports?result=NONE");
    assert.ok(!none.body.rows.some((r) => r.handoverId === handoverId));
    const xlsx = await as(fx.owner.email, "/api/stock-handover-reports?format=xlsx");
    assert.equal(xlsx.status, 200, xlsx.text.slice(0, 200));
    assert.match(xlsx.headers.get("content-type") ?? "", /spreadsheetml/);
    assert.ok(xlsx.text.startsWith("PK"), "a real xlsx (zip) file");
    const cashierList = await as(fx.cashier.email, "/api/stock-handover-reports");
    assert.equal(cashierList.status, 403);
  });

  test("a reviewed shortage can be adjusted once at a fresh physical count with explicit cost evidence", async () => {
    const itemId = items[0].id;
    const reportPath = `/api/stock-handover-reports/${handoverId}`;
    const movementPath = `/api/inventory/${itemId}/movement`;
    const opening = await db.inventoryTransaction.count({ where: { inventoryItemId: itemId } });
    const classification = await reviewPost(fx.manager.email, handoverId, { text: "تم التحقق من عجز اللبن", status: "REVIEWED", classification: "LOSS_UNEXPLAINED" });
    assert.equal(classification.status, 201, classification.text);

    const detail = await as<{ adjustmentOptions: Record<string, { token: string; bookQuantity: number }> }>(fx.manager.email, reportPath);
    assert.equal(detail.status, 200, detail.text);
    const option = detail.body.adjustmentOptions?.[itemId];
    assert.ok(option, "the review exposes an adjustment for the independently counted shortage");
    assert.equal(option.bookQuantity, 7);

    const body = { type: "ADJUSTMENT", quantity: -1, unitCost: 12.34, note: "تم التحقق من التكلفة من فاتورة المورد", handoverAdjustment: { handoverId, token: option.token, physicalQuantity: 6 } };
    const request = (email: string, data = body, idem = key("adjust")) => as<{ adjustment?: { transactionId: string } }>(email, movementPath, {
      method: "POST", body: JSON.stringify(data), headers: { "Idempotency-Key": idem },
    });
    assert.equal((await request(fx.cashier.email)).status, 403);
    assert.equal((await request(fx.manager.email, { ...body, quantity: -2 })).status, 409);
    assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: itemId } }), opening);

    await sell(itemId, 1);
    assert.equal((await request(fx.manager.email)).status, 409, "a movement invalidates the observed book balance");
    const refreshed = await as<typeof detail.body>(fx.manager.email, reportPath);
    const refreshedOption = refreshed.body.adjustmentOptions[itemId];
    assert.equal(refreshedOption.bookQuantity, 6);
    const approved = { ...body, handoverAdjustment: { handoverId, token: refreshedOption.token, physicalQuantity: 5 } };
    // Missing cost evidence or reason is refused before anything is written.
    assert.equal((await request(fx.manager.email, { ...approved, unitCost: undefined as unknown as number })).status, 400);
    assert.equal((await request(fx.manager.email, { ...approved, unitCost: 0 })).status, 400);
    assert.equal((await request(fx.manager.email, { ...approved, note: "  " })).status, 400);
    assert.equal((await request(fx.manager.email, { ...approved, type: "WASTE", quantity: 1 })).status, 400);
    // Two devices submit the same approval at once with different keys: one movement.
    const idemA = key("approve-shortage-a"), idemB = key("approve-shortage-b");
    const raced = await Promise.all([request(fx.manager.email, approved, idemA), request(fx.manager.email, approved, idemB)]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409], raced.map((r) => r.text).join(" | "));
    const winner = raced.find((r) => r.status === 200)!;
    const idem = winner === raced[0] ? idemA : idemB;
    const transactionId = winner.body.adjustment?.transactionId;
    assert.ok(transactionId);
    const replayed = await request(fx.manager.email, approved, idem);
    assert.equal(replayed.headers.get("Idempotency-Replayed"), "true");
    assert.equal(replayed.body.adjustment?.transactionId, transactionId);
    assert.equal((await request(fx.manager.email, approved)).status, 409);

    const movement = await db.inventoryTransaction.findUniqueOrThrow({ where: { id: transactionId } });
    assert.equal(movement.type, "ADJUSTMENT");
    assert.equal(movement.quantity.toFixed(3), "-1.000");
    assert.equal(movement.totalCost?.toFixed(2), "12.34");
    assert.equal(movement.createdById, fx.manager.id);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).currentStock), 5);
    assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: itemId } }), opening + 2);
    const audit = await db.auditLog.findMany({ where: { action: "STOCK_HANDOVER_ADJUSTMENT", entityId: handoverId } });
    assert.equal(audit.length, 1, "exactly one link row");
    assert.equal((audit[0].details as { transactionId: string }).transactionId, transactionId);
    // The original count evidence is untouched by the adjustment.
    assert.equal(await db.stockHandoverIncomingLine.count({ where: { count: { handoverId } } }), 4);
    const linked = await as<{ adjustments: { transactionId: string }[]; adjustmentOptions: Record<string, unknown> }>(fx.manager.email, reportPath);
    assert.deepEqual(linked.body.adjustments.map((row) => row.transactionId), [transactionId]);
    assert.equal(linked.body.adjustmentOptions[itemId], undefined);
    // The owner reads the same evidence and link.
    const ownerView = await as<{ adjustments: { transactionId: string }[]; comparison: { lines: unknown[] } }>(fx.owner.email, reportPath);
    assert.equal(ownerView.status, 200, ownerView.text);
    assert.deepEqual(ownerView.body.adjustments.map((row) => row.transactionId), [transactionId]);
  });

  test("the incoming shift was never held back by the stock handover", async () => {
    const accepted = await db.handoverSession.findUniqueOrThrow({ where: { id: handoverId }, select: { status: true } });
    assert.notEqual(accepted.status, "COMPLETED", "this journey never accepted; counting did not need it");
    const next = await openOperationalShift(incoming.id);
    const s = await db.shift.findUniqueOrThrow({ where: { id: next.id } });
    assert.notEqual(s.custodyGateReason, "AWAITING_OPENING_VERIFICATION");
    void outgoingShiftId;
  });

  test("a receiving shift that closes without its own count is reported once (incoming side)", async () => {
    const { reportIncomingCountsMissingForShift } = await import("@/lib/stock-handover-v2");
    const receiver = await db.shift.findFirstOrThrow({ where: { branchId: fx.branchId, cashierId: incoming.id, status: "OPEN" } });
    // A second, completed-looking handover received by that shift with no incoming count.
    const other = await db.handoverSession.findFirstOrThrow({ where: { id: handoverId } });
    const twin = await db.handoverSession.create({
      data: { cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: other.outgoingShiftId, outgoingUserId: other.outgoingUserId, target: "SHIFT_TO_SHIFT", status: "COMPLETED", incomingShiftId: receiver.id, incomingUserId: incoming.id },
    });
    const first = await db.$transaction((tx) => reportIncomingCountsMissingForShift(tx, receiver.id));
    const again = await db.$transaction((tx) => reportIncomingCountsMissingForShift(tx, receiver.id));
    assert.equal(first, 2, "manager and owner");
    assert.equal(again, 0, "deduplicated");
    const rows = await db.notification.findMany({ where: { handoverId: twin.id, kind: "STOCK_HANDOVER_MISSING_COUNT" } });
    assert.deepEqual(rows.map((r) => r.recipientId).sort(), [fx.manager.id, fx.owner.id].sort());
    assert.ok(rows.every((r) => (r.payload as { side?: string }).side === "INCOMING"));
    await db.notification.deleteMany({ where: { handoverId: twin.id } });
    await db.handoverSession.delete({ where: { id: twin.id } });
  });
});
