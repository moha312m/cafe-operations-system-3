import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { withIdempotency, requestFingerprint, publicQrRequestScope } from "@/lib/idempotency";
import { ApiError } from "@/lib/api";
import { db, assertTestDatabase, teardownTaggedCafe } from "./helpers/db";
import { db as productionDb } from "@/lib/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { protectedTransaction, protectedContext, queueRefusalAudit } from "@/lib/protected-transaction";
import { lockOrders, lockShifts, lockOrderPayments } from "@/lib/transaction-locks";
import { collectOrderPayment } from "@/lib/payments";
import type { SessionUser } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import { as } from "./helpers/http";

test("SQLSTATE contention mapping handles nested installed Prisma errors safely", async () => {
  const { handleApiError } = await import("@/lib/api");
  for (const code of ["55P03", "57014", "40P01", "40001"]) {
    const response = handleApiError({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: code } } } });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.match(payload.error, /[\u0600-\u06ff]/);
    assert.doesNotMatch(payload.error, /SELECT|SQL|P2010|40P01/);
  }
});

const prefix = `phase2-corrective:${randomUUID()}`;
let fx: CountCafe, foreign: CountCafe;
let actor: SessionUser, shiftId: string, orderId: string, foreignOrderId: string, foreignShiftId: string;
before(async () => {
  fx = await countCafe("P2-CORRECT"); foreign = await countCafe("P2-FOREIGN");
  actor = { ...fx.cashier, cafeId: fx.cafeId, branchId: fx.branchId, role: "CASHIER" };
  const makeOrder = (f: CountCafe) => db.order.create({ data: { cafeId: f.cafeId, branchId: f.branchId, orderNumber: 900, subtotal: 100, total: 100, remainingAmount: 100 } });
  orderId = (await makeOrder(fx)).id; foreignOrderId = (await makeOrder(foreign)).id;
  shiftId = (await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, shiftNumber: 1, cashierId: actor.id } })).id;
  foreignShiftId = (await db.shift.create({ data: { cafeId: foreign.cafeId, branchId: foreign.branchId, shiftNumber: 1, cashierId: foreign.cashier.id } })).id;
  await db.payment.create({ data: { cafeId: foreign.cafeId, branchId: foreign.branchId, orderId: foreignOrderId, shiftId: foreignShiftId, cashierId: foreign.cashier.id, receivedById: foreign.cashier.id, amount: 1, method: "CASH" } });
});
function request(key: string) { return new Request("http://localhost/phase2", { headers: { "Idempotency-Key": key } }); }
after(async () => { await db.idempotencyKey.deleteMany({ where: { OR: [{ scope: { startsWith: prefix } }, { scope: "public:" + fx?.branchId + ":POST /api/qr/orders" }] } }); if (fx) await teardownTaggedCafe(fx.cafeId); if (foreign) await teardownTaggedCafe(foreign.cafeId); await db.$disconnect(); await productionDb.$disconnect(); });

test("same-cafe foreign branch rows cannot be locked by pinned staff", async () => {
  const branch = await db.branch.create({ data: { cafeId: fx.cafeId, name: "Other branch", menuSlug: randomUUID() } });
  const order = await db.order.create({ data: { cafeId: fx.cafeId, branchId: branch.id, orderNumber: 1, subtotal: 1, total: 1 } });
  const shift = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: branch.id, shiftNumber: 1, cashierId: actor.id } });
  await db.payment.create({ data: { cafeId: fx.cafeId, branchId: branch.id, orderId: order.id, shiftId: shift.id, cashierId: actor.id, receivedById: actor.id, amount: 1, method: "CASH" } });
  let ready!: () => void, release!: () => void;
  const locked = new Promise<void>(r => ready = r), gate = new Promise<void>(r => release = r);
  const blocker = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Shift" WHERE "id"=${shift.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${order.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "orderId"=${order.id} FOR UPDATE`;
    ready(); await gate;
  }, { timeout: 15_000 });
  await locked;
  try {
    for (const acquire of [() => protectedTransaction(tx => lockShifts(tx, [shift.id]), { cafeId: fx.cafeId, branchId: fx.branchId }),
      () => protectedTransaction(tx => lockOrders(tx, [order.id]), { cafeId: fx.cafeId, branchId: fx.branchId }),
      () => protectedTransaction(tx => lockOrderPayments(tx, [order.id]), { cafeId: fx.cafeId, branchId: fx.branchId })]) {
      await assert.rejects(acquire(), (error: unknown) => error instanceof ApiError && error.status === 404);
    }
  } finally { release(); await blocker; }
});

test("authorized legacy NULL-branch Payment is actually locked through its Order", async () => {
  const row = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 911, subtotal: 1, total: 1 } });
  const payment = await db.payment.create({ data: { cafeId: fx.cafeId, branchId: null, orderId: row.id, cashierId: actor.id, receivedById: actor.id, amount: 1, method: "CARD" } });
  let ready!: () => void, release!: () => void, blockerPid = 0, settled = false;
  const locked = new Promise<void>(r => ready = r), gate = new Promise<void>(r => release = r);
  const blocker = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id"=${payment.id} FOR UPDATE`;
    blockerPid = (await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
    ready(); await gate;
  }, { timeout: 10_000 });
  await locked;
  const pending = protectedTransaction(async tx => {
    await lockOrders(tx, [row.id]); await lockOrderPayments(tx, [row.id]);
    assert.ok(protectedContext(tx).trace.find(lock => lock.entity === "Payment")?.ids.includes(payment.id));
  }, { cafeId: fx.cafeId, branchId: fx.branchId });
  pending.then(() => settled = true, () => settled = true);
  try {
    const end = Date.now() + 1600; let waiting = false;
    while (Date.now() < end && !settled) {
      const [probe] = await db.$queryRaw<{waiting:boolean}[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE ${blockerPid}=ANY(pg_blocking_pids(a.pid))) AS waiting`;
      if (probe.waiting) { waiting = true; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(waiting, true, "the service must wait on this authorized legacy Payment backend");
  } finally { release(); await blocker; await pending; }
});

test("concurrent FAILED retries allow one worker and preserve request identity", async () => {
  const scope = prefix + ":failed-race", key = randomUUID(), body = { amount: 1 };
  await db.idempotencyKey.create({ data: { id: randomUUID(), scope, key, requestHash: requestFingerprint(body), ownerToken: randomUUID(), lockedUntil: new Date(0), status: "FAILED" } });
  let entered!: () => void, release!: () => void, executions = 0;
  const ready = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  const first = withIdempotency(request(key), scope, body, async tx => {
    executions++; entered(); await gate;
    await tx.order.update({ where: { id: orderId }, data: { notes: "one retry" } });
    return NextResponse.json({ attempt: executions });
  });
  await ready;
  try {
    await assert.rejects(withIdempotency(request(key), scope, body, async () => { executions++; return NextResponse.json({}); }), (error: unknown) => error instanceof ApiError && error.status === 409);
    await assert.rejects(withIdempotency(request(key), scope, { amount: 2 }, async () => NextResponse.json({})), (error: unknown) => error instanceof ApiError && error.status === 409);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal(executions, 1);
  const row = await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope, key } } });
  assert.equal(row.status, "COMPLETED"); assert.equal(row.requestHash, requestFingerprint(body));
  await db.order.update({ where: { id: orderId }, data: { notes: null } });
});

test("expired reservation held by a live backend cannot be reclaimed", async () => {
  const scope = prefix + ":expired-locked", key = randomUUID(), body = {};
  const row = await db.idempotencyKey.create({ data: { id: randomUUID(), scope, key, requestHash: requestFingerprint(body), ownerToken: randomUUID(), lockedUntil: new Date(0) } });
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(r => ready = r), gate = new Promise<void>(r => release = r);
  const worker = db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "IdempotencyKey" WHERE "id"=${row.id} FOR UPDATE`; ready(); await gate; });
  await entered;
  try { await assert.rejects(withIdempotency(request(key), scope, body, async () => { assert.fail("live lease owner was bypassed"); }), (e: unknown) => e instanceof ApiError && e.status === 409); }
  finally { release(); await worker; }
  assert.equal((await db.idempotencyKey.findUniqueOrThrow({ where: { id: row.id } })).ownerToken, row.ownerToken);
});

test("lost commit acknowledgment reconciles COMPLETED without repeating business", async () => {
  const scope = prefix + ":ambiguous", key = randomUUID();
  const original = productionDb.$transaction; let calls = 0, executions = 0;
  // Fault only the client acknowledgment AFTER PostgreSQL really committed.
  productionDb.$transaction = new Proxy(original, { async apply(target, thisArg, args) {
    const number = ++calls, result = await Reflect.apply(target, thisArg, args);
    if (number === 2) throw new Error("simulated lost commit acknowledgment");
    return result;
  } });
  try {
    const result = await withIdempotency(request(key), scope, {}, async tx => {
      executions++; await tx.order.update({ where: { id: orderId }, data: { notes: "committed once" } });
      return NextResponse.json({ committed: true }, { status: 201 });
    });
    assert.equal(result.status, 201); assert.equal(result.headers.get("Idempotency-Replayed"), "true"); assert.equal(executions, 1);
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).notes, "committed once");
    assert.equal(calls, 3);
  } finally { productionDb.$transaction = original; await db.order.update({ where: { id: orderId }, data: { notes: null } }); }
});

test("cleanup interruption retains STARTED fencing and the original rollback error", async () => {
  const scope = prefix + ":cleanup-failure", key = randomUUID(), body = {};
  const original = productionDb.$transaction, businessError = new ApiError(400, "confirmed rollback"); let calls = 0;
  productionDb.$transaction = new Proxy(original, { apply(target, thisArg, args) {
    if (++calls === 3) return Promise.reject(new Error("simulated failure before FAILED finalization"));
    return Reflect.apply(target, thisArg, args);
  } });
  try { await assert.rejects(withIdempotency(request(key), scope, body, async tx => {
    await tx.order.update({ where: { id: orderId }, data: { notes: "must roll back" } }); throw businessError;
  }), error => error === businessError); }
  finally { productionDb.$transaction = original; }
  assert.equal(calls, 3);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).notes, null);
  assert.equal((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope, key } } })).status, "STARTED");
  await assert.rejects(withIdempotency(request(key), scope, body, async () => NextResponse.json({})), (e: unknown) => e instanceof ApiError && e.status === 409);
});

test("failure finalization cannot overwrite a replacement owner", async () => {
  const scope = prefix + ":replacement", key = randomUUID(), token = randomUUID();
  const original = productionDb.$transaction; let calls = 0;
  productionDb.$transaction = new Proxy(original, { async apply(target, thisArg, args) {
    if (++calls === 3) await db.idempotencyKey.update({ where: { scope_key: { scope, key } }, data: { ownerToken: token, lockedUntil: new Date(Date.now() + 120_000) } });
    return Reflect.apply(target, thisArg, args);
  } });
  try { await assert.rejects(withIdempotency(request(key), scope, {}, async () => { throw new ApiError(400, "rollback"); })); }
  finally { productionDb.$transaction = original; }
  assert.equal(calls, 3);
  const row = await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope, key } } });
  assert.equal(row.ownerToken, token); assert.equal(row.status, "STARTED");
});

test("completed public QR replay still requires current public access policy", async () => {
  const key = randomUUID(), body = {}, scope = (tx: Prisma.TransactionClient) => publicQrRequestScope(tx, fx.branchId);
  let executions = 0;
  await withIdempotency(request(key), scope, body, async () => { executions++; return NextResponse.json({}); });
  await db.branch.update({ where: { id: fx.branchId }, data: { publicMenuEnabled: false } });
  try { await assert.rejects(withIdempotency(request(key), scope, body, async () => { executions++; return NextResponse.json({}); }), (e: unknown) => e instanceof ApiError && e.status === 403); }
  finally { await db.branch.update({ where: { id: fx.branchId }, data: { publicMenuEnabled: true } }); }
  assert.equal(executions, 1);
});

test("protected business transaction initializes real PostgreSQL local timeouts", async () => {
  await assertTestDatabase();
  const response = await withIdempotency(request(randomUUID()), prefix + ":timeouts", {}, async (tx) => {
    const [settings] = await tx.$queryRaw<{ lock: string; statement: string }[]>`SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`;
    assert.deepEqual(settings, { lock: "2s", statement: "5s" });
    return NextResponse.json({ ok: true });
  });
  assert.equal(response.status, 200);
});

for (const entity of ["Shift", "Order", "Payment"] as const) {
  test(`scoped ${entity} lock never waits on a forbidden tenant row`, async () => {
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(r => release = r), locked = new Promise<void>(r => ready = r);
    const blocker = db.$transaction(async (tx) => {
      if (entity === "Shift") await tx.$queryRaw`SELECT "id" FROM "Shift" WHERE "id"=${foreignShiftId} FOR UPDATE`;
      else if (entity === "Order") await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${foreignOrderId} FOR UPDATE`;
      else await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "orderId"=${foreignOrderId} FOR UPDATE`;
      ready(); await gate;
    }, { timeout: 15_000 });
    await locked;
    try {
      await assert.rejects(protectedTransaction(async (tx) => {
        if (entity === "Shift") await lockShifts(tx, [foreignShiftId]);
        else if (entity === "Order") await lockOrders(tx, [foreignOrderId]);
        else await lockOrderPayments(tx, [foreignOrderId]);
      }, { cafeId: fx.cafeId, branchId: fx.branchId }), (e: unknown) => e instanceof ApiError && [403,404].includes(e.status));
    } finally { release(); await blocker; }
  });
}

test("nested collection acquires each protected row level once", async () => {
  await protectedTransaction(async (tx) => {
    await collectOrderPayment({ session: actor, orderId, branchId: fx.branchId, splits: [{ method: "CASH", amount: 1 }], client: tx });
    const trace = protectedContext(tx).trace;
    assert.deepEqual(trace.filter(t => ["Shift", "Order", "Payment"].includes(t.entity)).map(t => t.entity), ["Shift", "Order", "Payment"]);
    assert.equal(trace[0].ids[0], shiftId);
    console.log("PHASE2_LOCK_TRACE " + JSON.stringify({ operation: "single-collection", trace }));
  }, { cafeId: fx.cafeId, branchId: fx.branchId });
});

test("actual lock timeout rolls back business evidence after two seconds", async () => {
  let ready!: () => void, release!: () => void;
  const locked = new Promise<void>(r => ready = r), gate = new Promise<void>(r => release = r);
  const blocker = db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id"=${orderId} FOR UPDATE`; ready(); await gate; }, { timeout: 10_000 });
  await locked; const started = Date.now(), action = "P2_LOCK_TIMEOUT_TEST";
  try {
    const { sqlState } = await import("@/lib/database-errors");
    await assert.rejects(protectedTransaction(async tx => {
      await tx.auditLog.create({ data: { cafeId: fx.cafeId, action, entity: "Order", entityId: orderId } });
      await lockOrders(tx, [orderId]);
    }, { cafeId: fx.cafeId, branchId: fx.branchId }), (error: unknown) => sqlState(error) === "55P03");
    assert.ok(Date.now() - started >= 1800 && Date.now() - started < 4000);
    assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action } }), 0);
  } finally { release(); await blocker; }
});

test("stale reservation owner cannot resume business or finalize the replacement", async () => {
  const scope = prefix + ":stale-resume", key = randomUUID(), replacement = randomUUID();
  const original = productionDb.$transaction; let calls = 0, executions = 0;
  productionDb.$transaction = new Proxy(original, { async apply(target, thisArg, args) {
    if (++calls === 2) await db.idempotencyKey.update({ where: { scope_key: { scope, key } }, data: { ownerToken: replacement, lockedUntil: new Date(Date.now() + 120_000) } });
    return Reflect.apply(target, thisArg, args);
  } });
  try { await assert.rejects(withIdempotency(request(key), scope, {}, async () => { executions++; return NextResponse.json({}); }), (e: unknown) => e instanceof ApiError && e.status === 409); }
  finally { productionDb.$transaction = original; }
  assert.equal(executions, 0); assert.equal(calls, 3);
  const row = await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope, key } } });
  assert.equal(row.ownerToken, replacement); assert.equal(row.status, "STARTED");
});

test("independent payment keys cannot jointly overcollect the live balance", async () => {
  const row = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 908, subtotal: 0.29, total: 0.29, remainingAmount: 0.29 } });
  const results = await Promise.all([1,2].map(() => as(actor.email, "/api/payments", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ orderId: row.id, amount: 0.2, method: "CASH" }) })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(results.filter(r => r.status === 400).length, 1);
  assert.equal((await db.payment.aggregate({ where: { orderId: row.id }, _sum: { amount: true } }))._sum.amount?.toString(), "0.2");
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: row.id } })).remainingAmount.toString(), "0.09");
});

test("full-order and single-payment refunds cannot reverse a collection twice", async () => {
  const { refundOrder, refundPayment } = await import("@/lib/refunds");
  const row = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 909, subtotal: 0.29, total: 0.29, paidAmount: 0.29, remainingAmount: 0, paymentStatus: "PAID" } });
  const collection = await db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderId: row.id, shiftId, cashierId: actor.id, receivedById: actor.id, amount: 0.29, method: "CASH" } });
  const outcomes = await Promise.allSettled([refundOrder(row.id, actor, "Concurrent refund"), refundPayment(collection.id, actor, "Concurrent refund")]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(await db.payment.count({ where: { reversalOfPaymentId: collection.id } }), 1);
  assert.equal((await db.payment.aggregate({ where: { orderId: row.id, type: "REFUND" }, _sum: { amount: true } }))._sum.amount?.toString(), "0.29");
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: row.id } })).paidAmount.toString(), "0");
});

test("loyalty refusal persists after rolling back the attempted sale", async () => {
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { inventoryEnforcementMode: "OVERRIDE_ALL" } });
  await db.loyaltySettings.upsert({ where: { cafeId: fx.cafeId }, create: { cafeId: fx.cafeId, enabled: true, minPointsToRedeem: 1 }, update: { enabled: true, minPointsToRedeem: 1 } });
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Refused loyalty" } });
  const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "Loyalty sale", basePrice: 10 } });
  const response = await as(actor.email, "/api/orders", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, type: "TAKEAWAY", collectionMode: "NOW", method: "CASH", customerPhone: "01012345678", loyaltyPointsToRedeem: 1, items: [{ productId: product.id, quantity: 1 }] }) });
  assert.equal(response.status, 400, response.text);
  assert.equal(await db.order.count({ where: { items: { some: { productId: product.id } } } }), 0);
  assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "LOYALTY_REDEMPTION_BLOCKED" } }), 1);
});

test("SERVED stock failure rolls back lifecycle and retains its audit", async () => {
  const { ensureCustodyForShift } = await import("@/lib/custody");
  await db.$transaction(tx => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId, userId: actor.id, openingCashAmount: 0 }));
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Serving refusal" } });
  const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "Unavailable ingredient", basePrice: 0 } });
  const item = await db.inventoryItem.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name: randomUUID(), unit: "KG", currentStock: 0 } });
  await db.recipe.create({ data: { cafeId: fx.cafeId, productId: product.id, items: { create: { inventoryItemId: item.id, unit: "KG", quantity: 1 } } } });
  const row = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 910, status: "READY", subtotal: 0, total: 0, inventoryEnforcementMode: "STRICT", items: { create: { productId: product.id, productName: product.name, quantity: 1, unitPrice: 0, lineTotal: 0 } } } });
  const response = await as(fx.manager.email, `/api/orders/${row.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "SERVED" }) });
  assert.equal(response.status, 400, response.text);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: row.id } })).status, "READY");
  assert.equal(await db.inventoryTransaction.count({ where: { orderId: row.id } }), 0);
  assert.equal(await db.auditLog.count({ where: { entityId: row.id, action: "STOCK_DEDUCTION_FAILED" } }), 1);
});

test("audit persistence failure retains the original error and rolled-back business", async () => {
  const original = productionDb.$transaction, refusal = new ApiError(400, "original refusal"); let calls = 0;
  productionDb.$transaction = new Proxy(original, { apply(target, thisArg, args) {
    if (++calls === 2) return Promise.reject(new Error("simulated unavailable audit connection"));
    return Reflect.apply(target, thisArg, args);
  } });
  try { await assert.rejects(protectedTransaction(async tx => {
    await tx.order.update({ where: { id: orderId }, data: { notes: "audit failure must not commit this" } });
    queueRefusalAudit(tx, { cafeId: fx.cafeId, action: "P2_AUDIT_FAILURE_TEST", entity: "Order", entityId: orderId }); throw refusal;
  }), error => error === refusal); }
  finally { productionDb.$transaction = original; }
  assert.equal(calls, 2); assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).notes, null);
});

test("inventory lock timeout retains SQLSTATE instead of being swallowed as a missing item", async () => {
  const { deductStockForOrder } = await import("@/lib/stock-deduction");
  const { sqlState } = await import("@/lib/database-errors");
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Lock timeout" } });
  const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "Blocked ingredient", basePrice: 1 } });
  const item = await db.inventoryItem.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name: randomUUID(), unit: "KG", currentStock: 10, costPerUnit: 1 } });
  await db.recipe.create({ data: { cafeId: fx.cafeId, productId: product.id, items: { create: { inventoryItemId: item.id, quantity: 0.1, unit: "KG" } } } });
  const row = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 916, subtotal: 1, total: 1, status: "READY", items: { create: { productId: product.id, productName: product.name, quantity: 1, unitPrice: 1, lineTotal: 1 } } } });
  let ready!: () => void, release!: () => void;
  const locked = new Promise<void>(r => ready = r), gate = new Promise<void>(r => release = r);
  const blocker = db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id"=${item.id} FOR UPDATE`; ready(); await gate; }, { timeout: 10_000 });
  await locked;
  try { await assert.rejects(protectedTransaction(async tx => { await lockOrders(tx, [row.id]); await lockOrderPayments(tx, [row.id]); await deductStockForOrder(tx, row.id, actor.id); await tx.order.update({ where: { id: row.id }, data: { status: "SERVED" } }); }, { cafeId: fx.cafeId, branchId: fx.branchId }), error => sqlState(error) === "55P03"); }
  finally { release(); await blocker; }
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: row.id } })).status, "READY");
  assert.equal(await db.inventoryTransaction.count({ where: { orderId: row.id } }), 0);
});

test("serving helper acquires distinct inventory rows in ascending order once", async () => {
  const { deductStockForOrder } = await import("@/lib/stock-deduction");
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Lock ordering" } });
  const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "Two ingredients", basePrice: 1 } });
  const items = await Promise.all(["z", "a"].map(part => db.inventoryItem.create({ data: { id: part + randomUUID(), cafeId: fx.cafeId, branchId: fx.branchId, name: part + randomUUID(), unit: "KG", currentStock: 10, costPerUnit: 0.29 } })));
  await db.recipe.create({ data: { cafeId: fx.cafeId, productId: product.id, items: { create: items.map(item => ({ inventoryItemId: item.id, quantity: 0.5, unit: "KG" })) } } });
  const row = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 907, subtotal: 1, total: 1, status: "READY", items: { create: { productId: product.id, productName: product.name, quantity: 1, unitPrice: 1, lineTotal: 1 } } } });
  await protectedTransaction(async tx => {
    await lockOrders(tx, [row.id]); await lockOrderPayments(tx, [row.id]);
    const result = await deductStockForOrder(tx, row.id, actor.id);
    assert.equal(result.deducted.length, 2);
    const trace = protectedContext(tx).trace;
    assert.deepEqual(trace.filter(lock => lock.entity === "InventoryItem").flatMap(lock => lock.ids), items.map(item => item.id).sort());
    console.log("PHASE2_LOCK_TRACE " + JSON.stringify({ operation: "serving-helper", trace }));
  }, { cafeId: fx.cafeId, branchId: fx.branchId });
});

test("shift close locks the combined ingredients of all carried orders ASC", async () => {
  const { ensureCustodyForShift } = await import("@/lib/custody");
  const { closeShiftWithSettlement } = await import("@/lib/cash-close");
  const carry = await countCafe("P2-CARRY-LOCK");
  try {
    await db.cafeSettings.update({ where: { cafeId: carry.cafeId }, data: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY", carryOpenOrdersOnHandover: true } });
    const category = await db.menuCategory.create({ data: { cafeId: carry.cafeId, name: "Carry locks" } });
    const shift = await db.shift.create({ data: { cafeId: carry.cafeId, branchId: carry.branchId, cashierId: carry.cashier.id, shiftNumber: 1 } });
    await db.$transaction(tx => ensureCustodyForShift(tx, { cafeId: carry.cafeId, branchId: carry.branchId, shiftId: shift.id, userId: carry.cashier.id, openingCashAmount: 0 }));
    const itemIds: string[] = [];
    for (const [index, part] of ["z", "a"].entries()) {
      const item = await db.inventoryItem.create({ data: { id: part + randomUUID(), cafeId: carry.cafeId, branchId: carry.branchId, name: randomUUID(), unit: "KG", currentStock: 10, costPerUnit: 1, isCritical: true } });
      itemIds.push(item.id);
      const product = await db.product.create({ data: { cafeId: carry.cafeId, categoryId: category.id, name: part, basePrice: 0 } });
      await db.recipe.create({ data: { cafeId: carry.cafeId, productId: product.id, items: { create: { inventoryItemId: item.id, quantity: 0.1, unit: "KG" } } } });
      await db.order.create({ data: { cafeId: carry.cafeId, branchId: carry.branchId, orderNumber: index + 1, status: "READY", subtotal: 0, total: 0, items: { create: { productId: product.id, productName: part, quantity: 1, unitPrice: 0, lineTotal: 0 } } } });
    }
    const original = productionDb.$transaction;
    let trace: ReturnType<typeof protectedContext>["trace"] = [];
    productionDb.$transaction = new Proxy(original, { apply(target, thisArg, args) {
      const work = args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>;
      args[0] = async (tx: Prisma.TransactionClient) => { const result = await work(tx); trace = [...protectedContext(tx).trace]; return result; };
      return Reflect.apply(target, thisArg, args);
    } });
    try {
      const result = await closeShiftWithSettlement({ shiftId: shift.id, actualCash: 0, actorId: carry.cashier.id, closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", grants: { handoverSubmit: true, handoverException: true } });
      assert.equal(result.status, "AWAITING_HANDOVER");
    } finally { productionDb.$transaction = original; }
    assert.deepEqual(trace.filter(lock => lock.entity === "InventoryItem").flatMap(lock => lock.ids), itemIds.sort());
    assert.equal(await db.inventoryTransaction.count({ where: { cafeId: carry.cafeId, type: "USAGE" } }), 2);
    console.log("PHASE2_LOCK_TRACE " + JSON.stringify({ operation: "multi-order-shift-close", trace }));
  } finally { await teardownTaggedCafe(carry.cafeId); }
});

test("statement timeout cancels and rolls back actual protected business writes", async () => {
  const key = randomUUID(), scope = prefix + ":statement";
  const started = Date.now();
  await assert.rejects(withIdempotency(request(key), scope, {}, async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { notes: "must roll back" } });
    await tx.$queryRaw`SELECT pg_sleep(6)::text`;
    return NextResponse.json({ ok: true });
  }));
  assert.ok(Date.now() - started >= 4500 && Date.now() - started < 8000);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).notes, null);
  assert.equal((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope, key } } })).status, "FAILED");
});

test("stock refusal leaves no sale but preserves refusal audit evidence", async () => {
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { inventoryEnforcementMode: "STRICT" } });
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Blocked stock" } });
  const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "No recipe", basePrice: 1 } });
  const response = await as(actor.email, "/api/orders", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, cafeId: fx.cafeId, type: "TAKEAWAY", collectionMode: "PENDING", items: [{ productId: product.id, quantity: 1 }] }) });
  assert.equal(response.status, 409, response.text);
  assert.equal(await db.order.count({ where: { items: { some: { productId: product.id } } } }), 0);
  assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "ORDER_BLOCKED_STOCK_UNAVAILABLE" } }), 1);
});

test("duplicate refusal preserves audit after rollback through the collection service", async () => {
  const settled = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 901, subtotal: 1, total: 1, paidAmount: 1, remainingAmount: 0, paymentStatus: "PAID" } });
  await assert.rejects(protectedTransaction(tx => collectOrderPayment({ session: actor, orderId: settled.id, branchId: fx.branchId, splits: [{ method: "CASH", amount: 1 }], client: tx }), { cafeId: fx.cafeId, branchId: fx.branchId }));
  assert.equal(await db.payment.count({ where: { orderId: settled.id } }), 0);
  assert.equal(await db.auditLog.count({ where: { entityId: settled.id, action: "DUPLICATE_PAYMENT_BLOCKED" } }), 1);
});

test("inline mixed collection refuses a one-cent mismatch exactly", async () => {
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { inventoryEnforcementMode: "OVERRIDE_ALL" } });
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Exact split" } });
  const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "Cent price", basePrice: 0.29 } });
  const response = await as(actor.email, "/api/orders", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, cafeId: fx.cafeId, type: "TAKEAWAY", collectionMode: "NOW", method: "MIXED", splits: [{ method: "CASH", amount: 0.28 }], items: [{ productId: product.id, quantity: 1 }] }) });
  assert.equal(response.status, 400, response.text);
  assert.equal(await db.order.count({ where: { items: { some: { productId: product.id } } } }), 0);
});

test("table FIFO skips terminal refunded orders when collecting a newer sale", async () => {
  const table = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: "refund-fifo" } });
  const refunded = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 914, status: "SERVED", subtotal: 1, total: 1, paidAmount: 0, remainingAmount: 0, paymentStatus: "REFUNDED", tableSessionId: table.id, createdAt: new Date(0) } });
  const live = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 915, status: "SERVED", subtotal: 0.29, total: 0.29, remainingAmount: 0.29, tableSessionId: table.id } });
  const response = await as(actor.email, `/api/tables/${table.id}/pay`, { method: "POST", body: JSON.stringify({ mode: "FULL", method: "CASH" }) });
  assert.equal(response.status, 200, response.text);
  assert.equal(await db.payment.count({ where: { orderId: refunded.id } }), 0);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: refunded.id } })).paymentStatus, "REFUNDED");
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: live.id } })).paidAmount.toString(), "0.29");
});

test("item payment allocation conserves the actual capped collection", async () => {
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Allocation" } });
  const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "Discounted item", basePrice: 1 } });
  const table = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: "exact", openedByUserId: actor.id } });
  const row = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 903, subtotal: 1, discountAmount: 0.5, total: 0.5, remainingAmount: 0.5, tableSessionId: table.id, items: { create: { productId: product.id, productName: product.name, quantity: 2, unitPrice: 0.5, lineTotal: 1 } } }, include: { items: true } });
  const response = await as(actor.email, `/api/tables/${table.id}/pay`, { method: "POST", body: JSON.stringify({ mode: "ITEMS", method: "CASH", items: [{ orderItemId: row.items[0].id, quantity: 2 }] }) });
  assert.equal(response.status, 200, response.text);
  const payments = await db.payment.aggregate({ where: { orderId: row.id }, _sum: { amount: true } });
  const items = await db.orderItemPayment.aggregate({ where: { orderId: row.id }, _sum: { amountPaid: true } });
  assert.equal(items._sum.amountPaid?.toString(), payments._sum.amount?.toString());
  assert.equal(items._sum.amountPaid?.toString(), "0.5");
});

test("table close revalidates balances after the specific concurrent writer commits", async () => {
  await as(actor.email, "/api/tables/phase2-warmup/close", { method: "POST" });
  const table = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: "closing", totalAmount: 1, paidAmount: 1, remainingAmount: 0 } });
  const row = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 904, status: "SERVED", subtotal: 1, total: 1, paidAmount: 1, remainingAmount: 0, paymentStatus: "PAID", tableSessionId: table.id } });
  let ready!: () => void, release!: () => void, blockerPid = 0;
  const locked = new Promise<void>(r => ready = r), gate = new Promise<void>(r => release = r);
  // A fixture simulates an already-running writer; it does not certify that
  // all production writers obey the hierarchy.
  const blocker = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "TableSession" WHERE "id"=${table.id} FOR UPDATE`;
    await tx.order.update({ where: { id: row.id }, data: { paidAmount: 0, remainingAmount: 1, paymentStatus: "PENDING_COLLECTION" } });
    blockerPid = (await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
    ready(); await gate;
  }, { timeout: 15_000 });
  await locked;
  const pending = as(actor.email, `/api/tables/${table.id}/close`, { method: "POST" });
  try {
    let waiting = false;
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      const [row] = await db.$queryRaw<{waiting:boolean}[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE ${blockerPid}=ANY(pg_blocking_pids(a.pid))) AS waiting`;
      if (row.waiting) { waiting = true; break; }
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(waiting, true, "request must wait on this fixture backend");
  } finally { release(); await blocker; }
  const response = await pending;
  assert.equal(response.status, 400, response.text);
  assert.equal((await db.tableSession.findUniqueOrThrow({ where: { id: table.id } })).status, "OPEN");
});

test("resuming an existing shift waits on Shift without holding Branch", async () => {
  await as(actor.email, "/api/shifts", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, cafeId: fx.cafeId, resumeOnly: true }) });
  let ready!: () => void, release!: () => void, blockerPid = 0;
  const locked = new Promise<void>(r => ready = r), gate = new Promise<void>(r => release = r);
  const blocker = db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Shift" WHERE "id"=${shiftId} FOR UPDATE`; blockerPid = (await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`)[0].pid; ready(); await gate; }, { timeout: 10_000 });
  await locked;
  const pending = as(actor.email, "/api/shifts", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, cafeId: fx.cafeId, resumeOnly: true }) });
  let barrierError: unknown;
  try {
    let waiting = false; const deadline = Date.now()+1600;
    while(Date.now()<deadline){const [row]=await db.$queryRaw<{waiting:boolean}[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE ${blockerPid}=ANY(pg_blocking_pids(a.pid))) AS waiting`; if(row.waiting){waiting=true;break}await new Promise(r=>setTimeout(r,10))}
    assert.equal(waiting,true,"resume must wait on this Shift backend");
    await db.$transaction(async tx=>{await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id"=${fx.branchId} FOR NO KEY UPDATE NOWAIT`});
  } catch(error){barrierError=error}
  finally{release();await blocker}
  const response=await pending;
  if(barrierError)throw barrierError;
  assert.equal(response.status,200,response.text);
});

test("confirmed rollback persists FAILED and keeps its request fingerprint", async () => {
  await assertTestDatabase();
  const key = randomUUID(), scope = prefix + ":failed";
  await assert.rejects(withIdempotency(request(key), scope, { amount: 1 }, async () => { throw new ApiError(400, "رفض للاختبار"); }), /رفض للاختبار/);
  const row = await db.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
  assert.equal(row?.status, "FAILED");
  await assert.rejects(withIdempotency(request(key), scope, { amount: 2 }, async () => NextResponse.json({ ok: true })), (e: unknown) => e instanceof ApiError && e.status === 409);
  const retry = await withIdempotency(request(key), scope, { amount: 1 }, async () => NextResponse.json({ ok: true }));
  assert.equal(retry.status, 200);
  assert.equal((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope, key } } })).status, "COMPLETED");
});
