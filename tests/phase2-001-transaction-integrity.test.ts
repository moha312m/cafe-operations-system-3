import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer, BASE } from "./helpers/http";
import { collectOrderPayment } from "@/lib/payments";
import { refundOrder, refundPayment } from "@/lib/refunds";
import type { SessionUser } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { requestScope, requestFingerprint } from "@/lib/idempotency";
import { getLoyaltySettings } from "@/lib/loyalty";

let fx: CountCafe;
let productId: string;
let shiftId: string;
let seq = 200;
let actor: SessionUser;
before(async () => {
  await requireServer();
  fx = await countCafe("PHASE2");
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Phase 2" } });
  productId = (await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "Transaction item", basePrice: 100 } })).id;
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { inventoryEnforcementMode: "OVERRIDE_ALL", stockCountPolicy: "NO_SHIFT_COUNT" } });
  shiftId = (await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: 1 } })).id;
  actor = { ...fx.cashier, cafeId: fx.cafeId, branchId: fx.branchId, role: "CASHIER" };
  // Compile/authenticate each HTTP path before a barrier bounded below 2s.
  for (const action of ["approve", "reject"] as const) await as(fx.manager.email, `/api/orders/phase2-warmup/${action}`, { method: "POST", body: JSON.stringify(action === "reject" ? { reason: "Warm route" } : {}) });
  await as(fx.manager.email, "/api/orders/phase2-warmup", { method: "PATCH", body: JSON.stringify({ notes: "Warm route" }) });
  await as(fx.manager.email, "/api/orders/phase2-warmup/status", { method: "PATCH", body: JSON.stringify({ status: "READY" }) });
  await as(fx.manager.email, "/api/tables/phase2-warmup/transfer", { method: "POST", body: JSON.stringify({ tableNumber: "warm" }) });
  await fetch(`${BASE}/api/qr/phase2-warmup/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tableNumber: "warm", items: [{ productId, quantity: 1 }] }) });
});
after(async () => {
  // Keys deliberately have no FK to audit-history entities.
  await db.$executeRaw`DELETE FROM "IdempotencyKey" WHERE "scope" LIKE ${`%${fx?.cafeId}%`}`.catch(() => undefined);
  if (fx) await teardownTaggedCafe(fx.cafeId);
  await db.$disconnect();
});
async function order(status: "CONFIRMED" | "PREPARING" = "CONFIRMED", paid = 0) {
  const latest = await db.order.aggregate({ where: { branchId: fx.branchId }, _max: { orderNumber: true } });
  seq = Math.max(seq, latest._max.orderNumber ?? 0);
  return db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: ++seq, status,
    subtotal: 100, total: 100, paidAmount: paid, remainingAmount: 100 - paid, paymentStatus: paid ? "PAID" : "PENDING_COLLECTION",
    items: { create: { productId, productName: "Transaction item", quantity: 1, unitPrice: 100, lineTotal: 100 } },
  } });
}
const keyed = (key: string, body: unknown) => ({ method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) });

test("completed order retries replay the same order and payload", async () => {
  const key = randomUUID();
  const payload = { branchId: fx.branchId, cafeId: fx.cafeId, type: "TAKEAWAY", collectionMode: "PENDING", items: [{ productId, quantity: 1 }] };
  const first = await as(fx.cashier.email, "/api/orders", keyed(key, payload));
  const again = await as(fx.cashier.email, "/api/orders", keyed(key, payload));
  assert.equal(first.status, 201, first.text);
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.body, first.body);
});
test("partial payment retries do not create a second collection", async () => {
  const row = await order();
  const key = randomUUID();
  const body = { orderId: row.id, amount: 10, method: "CASH" };
  const first = await as(fx.cashier.email, "/api/payments", keyed(key, body));
  const again = await as(fx.cashier.email, "/api/payments", keyed(key, body));
  assert.equal(first.status, 201, first.text);
  assert.equal(again.status, 201, again.text);
  assert.deepEqual(again.body, first.body);
  assert.equal(await db.payment.count({ where: { orderId: row.id } }), 1);
});
test("reusing a payment key for a changed amount returns 409", async () => {
  const row = await order();
  const key = randomUUID();
  assert.equal((await as(fx.cashier.email, "/api/payments", keyed(key, { orderId: row.id, amount: 10, method: "CASH" }))).status, 201);
  const response = await as(fx.cashier.email, "/api/payments", keyed(key, { orderId: row.id, amount: 20, method: "CASH" }));
  assert.equal(response.status, 409, response.text);
});

// The blocker commits a changed state while the request is queued on its row.
// Removing the lock/re-read permits the stale mutation to commit.
async function raceLockedRow(table: "Shift" | "Order" | "TableSession", id: string, action: () => Promise<unknown>, change: (tx: Prisma.TransactionClient) => Promise<unknown>, duringWait?: (blockerPid: number, barrierDeadline: number) => Promise<void>) {
  let ready!: () => void;
  let release!: () => void;
  let blockerPid = 0;
  const locked = new Promise<void>((resolve) => { ready = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id"=$1 FOR UPDATE`, id);
    blockerPid = (await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
    ready();
    await gate;
    await change(tx);
  }, { timeout: 15000 });
  await locked;
  const barrierDeadline = Date.now() + 1750;
  const pending = action().then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
  let barrierError: unknown;
  try {
    const deadline = Date.now() + 1400;
    let waiting = false;
    while (Date.now() < deadline) {
      const rows = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database() AND ${blockerPid} = ANY(pg_blocking_pids(a.pid))) AS waiting`;
      if (rows[0].waiting) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, "request must reach the held row lock");
    await duringWait?.(blockerPid, barrierDeadline);
  } catch (error) { barrierError = error; }
  finally { release(); }
  await blocker;
  if (barrierError) { await pending; throw barrierError; }
  return pending;
}
test("collection revalidates the shift after a concurrent close", async () => {
  const row = await order();
  const outcome = await raceLockedRow("Shift", shiftId,
    () => collectOrderPayment({ session: actor, orderId: row.id, branchId: fx.branchId, splits: [{ method: "CASH", amount: 10 }] }),
    (tx) => tx.shift.update({ where: { id: shiftId }, data: { status: "CLOSED" } }));
  try {
    assert.ok(outcome.error, "collection must refuse the now-closed shift");
    assert.equal(await db.payment.count({ where: { orderId: row.id } }), 0);
  } finally { await db.shift.update({ where: { id: shiftId }, data: { status: "OPEN" } }); }
});
test("full refund derives amounts after locking the order", async () => {
  const row = await order("CONFIRMED", 100);
  const payment = await db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId: row.id, shiftId, cashierId: actor.id, receivedById: actor.id, amount: 100, method: "CASH", status: "PAID" } });
  const outcome = await raceLockedRow("Order", row.id, () => refundOrder(row.id, actor, "Adjusted collection"), async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { amount: 40 } });
    return tx.order.update({ where: { id: row.id }, data: { paidAmount: 40, remainingAmount: 60, paymentStatus: "PARTIAL" } });
  });
  assert.equal(outcome.error, null);
  const refund = await db.payment.findFirstOrThrow({ where: { reversalOfPaymentId: payment.id } });
  assert.equal(Number(refund.amount), 40);
});
test("READY cannot overwrite an order served while the request waits", async () => {
  const row = await order("PREPARING");
  const outcome = await raceLockedRow("Order", row.id,
    () => as(fx.manager.email, `/api/orders/${row.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "READY" }) }),
    (tx) => tx.order.update({ where: { id: row.id }, data: { status: "SERVED" } }));
  assert.equal(outcome.error, null);
  assert.equal((outcome.value as { status: number }).status, 400);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: row.id } })).status, "SERVED");
});
test("a refund never posts into an awaiting-handover shift", async () => {
  const row = await order("CONFIRMED", 100);
  const closed = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.manager.id, shiftNumber: 2, status: "AWAITING_HANDOVER" } });
  const payment = await db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId: row.id, shiftId: closed.id, cashierId: fx.manager.id, receivedById: fx.manager.id, amount: 100, method: "CASH", status: "PAID" } });
  await refundPayment(payment.id, actor, "Historical refund");
  const refund = await db.payment.findFirstOrThrow({ where: { reversalOfPaymentId: payment.id } });
  assert.equal(refund.shiftId, shiftId);
});

test("an active STARTED reservation returns 409 without posting money", async () => {
  const row = await order();
  const key = randomUUID();
  const body = { orderId: row.id, amount: 10, method: "CASH" };
  await db.idempotencyKey.create({ data: { id: randomUUID(), scope: requestScope(actor, "POST /api/payments"), key,
    requestHash: requestFingerprint(body), ownerToken: randomUUID(), lockedUntil: new Date(Date.now() + 120000) } });
  const response = await as(fx.cashier.email, "/api/payments", keyed(key, body));
  assert.equal(response.status, 409, response.text);
  assert.equal(await db.payment.count({ where: { orderId: row.id } }), 0);
});
test("an abandoned expired reservation can be reclaimed and completed", async () => {
  const row = await order();
  const key = randomUUID();
  const body = { orderId: row.id, amount: 10, method: "CASH" };
  await db.idempotencyKey.create({ data: { id: randomUUID(), scope: requestScope(actor, "POST /api/payments"), key,
    requestHash: requestFingerprint(body), ownerToken: randomUUID(), lockedUntil: new Date(0) } });
  const response = await as(fx.cashier.email, "/api/payments", keyed(key, body));
  assert.equal(response.status, 201, response.text);
  const state = await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: requestScope(actor, "POST /api/payments"), key } } });
  assert.equal(state.status, "COMPLETED");
});
test("a live duplicate returns 409 while the original waits for its shift", async () => {
  const row = await order();
  const key = randomUUID();
  const body = { orderId: row.id, amount: 10, method: "CASH" };
  const outcome = await raceLockedRow("Shift", shiftId,
    () => as(fx.cashier.email, "/api/payments", keyed(key, body)),
    (tx) => tx.shift.findUnique({ where: { id: shiftId } }), async () => {
      const response = await as(fx.cashier.email, "/api/payments", keyed(key, body));
      assert.equal(response.status, 409, response.text);
      assert.equal(await db.payment.count({ where: { orderId: row.id } }), 0);
    });
  assert.equal(outcome.error, null);
  assert.equal((outcome.value as { status: number }).status, 201);
  assert.equal(await db.payment.count({ where: { orderId: row.id } }), 1);
});
test("failed collection rolls back its key so an unchanged retry can succeed", async () => {
  const row = await order();
  const key = randomUUID();
  const body = { orderId: row.id, amount: 110, method: "CASH" };
  assert.equal((await as(fx.cashier.email, "/api/payments", keyed(key, body))).status, 400);
  assert.equal(await db.payment.count({ where: { orderId: row.id } }), 0);
  await db.order.update({ where: { id: row.id }, data: { total: 110, subtotal: 110, remainingAmount: 110 } });
  const retried = await as(fx.cashier.email, "/api/payments", keyed(key, body));
  assert.equal(retried.status, 201, retried.text);
});
test("completed payment replay succeeds even after the shift closes", async () => {
  const row = await order();
  const key = randomUUID();
  const body = { orderId: row.id, amount: 10, method: "CASH" };
  const first = await as(fx.cashier.email, "/api/payments", keyed(key, body));
  await db.shift.update({ where: { id: shiftId }, data: { status: "CLOSED" } });
  try {
    const response = await as(fx.cashier.email, "/api/payments", keyed(key, body));
    assert.equal(response.status, 201, response.text);
    assert.deepEqual(response.body, first.body);
    assert.equal(response.headers.get("Idempotency-Replayed"), "true");
  } finally { await db.shift.update({ where: { id: shiftId }, data: { status: "OPEN" } }); }
});

test("reading existing loyalty settings never waits on an unrelated writer", async () => {
  const settings = await getLoyaltySettings(fx.cafeId);
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const locked = new Promise<void>((resolve) => { ready = resolve; });
  const blocker = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "LoyaltySettings" WHERE "id"=${settings.id} FOR UPDATE`;
    ready();
    await gate;
  });
  await locked;
  const read = db.$transaction((tx) => getLoyaltySettings(fx.cafeId, tx));
  try {
    const result = await Promise.race([read, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))]);
    assert.ok(result, "a settings read must not acquire a write lock after customer writes");
  } finally { release(); await blocker; await read; }
});

test("table transfer locks orders before session metadata", async () => {
  const row = await order();
  const table = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: randomUUID() } });
  await db.order.update({ where: { id: row.id }, data: { tableSessionId: table.id } });
  const outcome = await raceLockedRow("Order", row.id,
    () => as(fx.manager.email, `/api/tables/${table.id}/transfer`, keyed(randomUUID(), { tableNumber: randomUUID() })),
    (tx) => tx.tableSession.update({ where: { id: table.id }, data: { notes: "Concurrent collection metadata" } }));
  assert.equal(outcome.error, null);
  assert.equal((outcome.value as { status: number }).status, 200);
});

test("QR branch allocation permits payment foreign keys while awaiting table attachment", async () => {
  const row = await order();
  const table = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: randomUUID() } });
  const outcome = await raceLockedRow("TableSession", table.id,
    async () => fetch(`${BASE}/api/qr/${fx.branchId}/orders`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ customerName: "Lock regression guest", tableNumber: table.tableNumber, items: [{ productId, quantity: 1 }] }),
    }),
    (tx) => tx.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId: row.id, shiftId,
      cashierId: actor.id, receivedById: actor.id, amount: 1, method: "CASH", status: "PAID" } }));
  assert.equal(outcome.error, null);
  const response = outcome.value as Response;
  assert.equal(response.status, 201, await response.text());
});

for (const action of ["approve", "reject", "edit"] as const) {
  test(`stale QR ${action} cannot overwrite an order that entered preparation`, async () => {
    const row = await order();
    await db.order.update({ where: { id: row.id }, data: { status: "PENDING_WAITER_APPROVAL", approvalStatus: "PENDING_APPROVAL" } });
    const outcome = await raceLockedRow("Order", row.id,
      () => as(fx.manager.email, `/api/orders/${row.id}${action === "edit" ? "" : "/" + action}`, {
        method: action === "edit" ? "PATCH" : "POST",
        body: JSON.stringify(action === "reject" ? { reason: "Race rejection" } : action === "edit" ? { notes: "Stale editor" } : {}),
      }),
      (tx) => tx.order.update({ where: { id: row.id }, data: { status: "PREPARING", approvalStatus: "APPROVED" } }));
    assert.equal(outcome.error, null);
    assert.equal((outcome.value as { status: number }).status, 400);
    const current = await db.order.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(current.status, "PREPARING");
    assert.notEqual(current.notes, "Stale editor");
  });
}

test("concurrent QR approvals serialize table aggregates before reading totals", async () => {
  const left = await order(), right = await order();
  const table = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: randomUUID() } });
  await db.order.updateMany({ where: { id: { in: [left.id, right.id] } }, data: {
    tableSessionId: table.id, status: "PENDING_WAITER_APPROVAL", approvalStatus: "PENDING_APPROVAL",
  } });
  const outcome = await raceLockedRow("TableSession", table.id,
    () => Promise.all([left, right].map((row) => as(fx.manager.email, `/api/orders/${row.id}/approve`, { method: "POST", body: "{}" }))),
    (tx) => tx.tableSession.findUnique({ where: { id: table.id } }), async (blockerPid, deadline) => {
      let waiters = 0;
      while (Date.now() < deadline) {
        // A second row waiter can queue behind the first waiter (a soft
        // block). Follow the complete chain to this fixture's backend.
        const rows = await db.$queryRaw<{ count: bigint }[]>`WITH RECURSIVE waits AS (
          SELECT a.pid, unnest(pg_blocking_pids(a.pid)) AS blocker FROM pg_stat_activity a WHERE datname=current_database()
        ), blocked AS (
          SELECT pid FROM waits WHERE blocker=${blockerPid}
          UNION SELECT w.pid FROM waits w JOIN blocked b ON w.blocker=b.pid
        ) SELECT count(DISTINCT pid) AS count FROM blocked`;
        waiters = Number(rows[0].count);
        if (waiters >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(waiters >= 2, "both approvers must reach the held table lock");
      console.log("PHASE2_BLOCKING_CHAIN " + JSON.stringify({ operation: "two-QR-approvals", fixtureBackend: blockerPid, connectedWaiters: waiters }));
    });
  assert.equal(outcome.error, null);
  for (const response of outcome.value as { status: number; text: string }[]) assert.equal(response.status, 200, response.text);
  const fresh = await db.tableSession.findUniqueOrThrow({ where: { id: table.id } });
  assert.equal(Number(fresh.totalAmount), 200);
  assert.equal(Number(fresh.remainingAmount), 200);
});

test("creation cannot attach to a session cancelled while it waited", async () => {
  const table = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: randomUUID() } });
  const note = randomUUID();
  const outcome = await raceLockedRow("TableSession", table.id,
    () => fetch(`${BASE}/api/qr/${fx.branchId}/orders`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ customerName: "Session race guest", tableNumber: table.tableNumber, notes: note, items: [{ productId, quantity: 1 }] }),
    }),
    (tx) => tx.tableSession.update({ where: { id: table.id }, data: { status: "CANCELLED" } }));
  assert.equal(outcome.error, null);
  const response = outcome.value as Response;
  assert.equal(response.status, 409, await response.text());
  assert.equal(await db.order.count({ where: { cafeId: fx.cafeId, notes: note } }), 0);
});

for (const status of ["CLOSED", "AWAITING_HANDOVER", "SUSPENDED"] as const) {
  test(`collection cannot post into a ${status} shift`, async () => {
    const row = await order();
    await db.shift.update({ where: { id: shiftId }, data: { status } });
    try {
      const response = await as(fx.cashier.email, "/api/payments", keyed(randomUUID(), { orderId: row.id, amount: 10, method: "CASH" }));
      assert.ok([400, 409].includes(response.status), response.text);
      assert.equal(await db.payment.count({ where: { orderId: row.id } }), 0);
    } finally { await db.shift.update({ where: { id: shiftId }, data: { status: "OPEN" } }); }
  });
}

test("protected collection refuses a missing idempotency header", async () => {
  const row = await order();
  const response = await as(fx.cashier.email, "/api/payments", keyed("", { orderId: row.id, amount: 10, method: "CASH" }));
  assert.equal(response.status, 400, response.text);
  assert.equal(await db.payment.count({ where: { orderId: row.id } }), 0);
});

test("revoked branch assignment blocks table collection and lifecycle mutation", async () => {
  const row = await order();
  const table = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: randomUUID() } });
  await db.order.update({ where: { id: row.id }, data: { tableSessionId: table.id } });
  await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.manager.id, shiftNumber: 3 } });
  await db.user.update({ where: { id: fx.manager.id }, data: { branchId: null } });
  try {
    const collection = await as(fx.manager.email, `/api/tables/${table.id}/pay`, keyed(randomUUID(), { mode: "PARTIAL", amount: 10, method: "CASH" }));
    const transition = await as(fx.manager.email, `/api/orders/${row.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "PREPARING" }) });
    assert.deepEqual([collection.status, transition.status], [403, 403]);
    assert.equal(await db.payment.count({ where: { orderId: row.id } }), 0);
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: row.id } })).status, "CONFIRMED");
  } finally { await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.branchId } }); }
});
