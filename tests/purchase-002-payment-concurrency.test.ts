import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

after(async () => { await db.$disconnect(); });

// Supplier payments move cash out of the business, so they get the same
// guarantees as POS collections: decisions are made on the locked invoice
// row, a retried request records one payment, and the audit row commits or
// rolls back with the payment it describes.

async function invoice(fx: CountCafe, total: number, confirm = true) {
  const item = await countItem(fx, "beans-" + randomUUID().slice(0, 8), { stock: 10 });
  const draft = await as<{ id: string }>(fx.owner.email, "/api/purchases", {
    method: "POST", body: JSON.stringify({ branchId: fx.branchId, items: [{ inventoryItemId: item.id, quantity: 1, unitCost: total }] }),
  });
  assert.equal(draft.status, 201, draft.text);
  if (confirm) {
    const confirmed = await as(fx.owner.email, `/api/purchases/${draft.body.id}/confirm`, { method: "POST", body: "{}" });
    assert.equal(confirmed.status, 200, confirmed.text);
  }
  return draft.body.id;
}

function pay(email: string, id: string, amount: number, key: string = randomUUID()) {
  return as<{ paidAmount: number; remainingAmount: number; paymentStatus: string }>(email, `/api/purchases/${id}/payments`, {
    method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ amount, method: "CASH" }),
  });
}

async function ledgerOf(id: string) {
  const inv = await db.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: { payments: true } });
  const paid = inv.payments.reduce((sum, p) => sum + Number(p.amount), 0);
  return { inv, paid: Math.round(paid * 100) / 100, count: inv.payments.length };
}

// Holds the invoice row so every request reaches its write boundary before
// any of them may proceed — the window a plain read-then-write cannot close.
async function holdInvoice(id: string) {
  let locked!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { locked = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocker = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PurchaseInvoice" WHERE id = ${id} FOR UPDATE`;
    locked(); await gate;
  }, { timeout: 15000 });
  await entered;
  return { release, blocker };
}

// Compiles the routes under `next dev` with a request every version rejects
// at validation, so compilation time cannot eat into the lock timeout.
async function warm(email: string, id: string) {
  const invalid = JSON.stringify({ amount: 0, method: "CASH" });
  assert.equal((await as(email, `/api/purchases/${id}/payments`, { method: "POST", body: invalid })).status, 400);
  assert.equal((await as(email, `/api/purchases/${id}`, { method: "PATCH", body: JSON.stringify({ discountAmount: -1 }) })).status, 400);
}

async function waitForLockWaiters(count: number) {
  for (let n = 0; n < 150; n++) {
    const [state] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%PurchaseInvoice%' OR query LIKE '%PurchasePayment%')`;
    if (state.count >= count) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test("two concurrent full payments record one payment and never overpay", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE002RACE");
  let held: Awaited<ReturnType<typeof holdInvoice>> | undefined;
  let requests: Promise<unknown> | undefined;
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const id = await invoice(fx, 100);
    await warm(fx.owner.email, id);
    held = await holdInvoice(id);
    const results = Promise.all([1, 2].map(() => pay(fx.owner.email, id, 100)));
    requests = results;
    const waiting = await waitForLockWaiters(2);
    held.release(); await held.blocker;
    const responses = await results;
    assert.ok(waiting, "both requests reached the invoice before either committed");
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 400], responses.map(r => r.text).join(" | "));
    const { inv, paid, count } = await ledgerOf(id);
    assert.equal(count, 1, "exactly one supplier payment");
    assert.equal(paid, 100);
    assert.equal(Number(inv.paidAmount), 100);
    assert.equal(Number(inv.remainingAmount), 0);
    assert.equal(inv.paymentStatus, "PAID");
  } finally {
    held?.release(); await held?.blocker; await requests;
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("ten parallel partial payments stop exactly at the invoice total", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE002BURST");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const id = await invoice(fx, 100);
    await warm(fx.owner.email, id);
    const responses = await Promise.all(Array.from({ length: 10 }, () => pay(fx.owner.email, id, 30)));
    const ok = responses.filter(r => r.status === 200).length;
    assert.equal(ok, 3, responses.map(r => `${r.status}:${r.text}`).join(" | "));
    assert.ok(responses.every(r => r.status === 200 || r.status === 400 || r.status === 409), "refusals are explicit, never a server error");
    const { inv, paid, count } = await ledgerOf(id);
    assert.equal(count, 3);
    assert.equal(paid, 90);
    assert.equal(Number(inv.paidAmount), 90, "stored paid amount matches recorded payments");
    assert.equal(Number(inv.remainingAmount), 10);
    assert.equal(inv.paymentStatus, "PARTIAL");
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a retried payment request is recorded once and a reused key cannot change the amount", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE002RETRY");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const id = await invoice(fx, 100);
    const key = randomUUID();
    const first = await pay(fx.owner.email, id, 40, key);
    assert.equal(first.status, 200, first.text);
    const replay = await pay(fx.owner.email, id, 40, key);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(replay.body, first.body);
    const changed = await pay(fx.owner.email, id, 50, key);
    assert.equal(changed.status, 409, changed.text);
    const missing = await as(fx.owner.email, `/api/purchases/${id}/payments`, { method: "POST", body: JSON.stringify({ amount: 10, method: "CASH" }) });
    assert.equal(missing.status, 400, "a payment without an operation key is refused");
    const { inv, paid, count } = await ledgerOf(id);
    assert.equal(count, 1);
    assert.equal(paid, 40);
    assert.equal(Number(inv.paidAmount), 40);
    assert.equal(await db.auditLog.count({ where: { entityId: id, action: "PURCHASE_PAYMENT_RECORDED" } }), 1);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("payments stay inside the actor's café and branch", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE002SCOPE");
  const other = await countCafe("PURCHASE002SCOPEOTHER");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    await login(other.owner.email, COUNT_PASSWORD);
    const id = await invoice(fx, 100);
    const foreignCafe = await pay(other.owner.email, id, 10);
    assert.ok(foreignCafe.status === 403 || foreignCafe.status === 404, foreignCafe.text);
    // The manager belongs to the main branch; move the invoice to the annex.
    await db.purchaseInvoice.update({ where: { id }, data: { branchId: fx.otherBranchId } });
    const foreignBranch = await pay(fx.manager.email, id, 10);
    assert.ok(foreignBranch.status === 403 || foreignBranch.status === 404, foreignBranch.text);
    const { count } = await ledgerOf(id);
    assert.equal(count, 0);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
    await teardownTaggedCafe(other.cafeId);
  }
});

test("an editable draft keeps remaining = total − paid when an edit races a payment", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE002EDIT");
  let held: Awaited<ReturnType<typeof holdInvoice>> | undefined;
  let requests: Promise<unknown> | undefined;
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    // Paying against a draft is an existing, visible workflow; it stays allowed.
    const id = await invoice(fx, 100, false);
    await warm(fx.owner.email, id);
    held = await holdInvoice(id);
    const results = Promise.all([
      pay(fx.owner.email, id, 40),
      as(fx.owner.email, `/api/purchases/${id}`, { method: "PATCH", body: JSON.stringify({ discountAmount: 20 }) }),
    ]);
    requests = results;
    const waiting = await waitForLockWaiters(2);
    held.release(); await held.blocker;
    const [payment, edit] = await results;
    assert.ok(waiting, "the edit and the payment both reached the invoice");
    assert.equal(payment.status, 200, payment.text);
    assert.equal(edit.status, 200, edit.text);
    const { inv, paid } = await ledgerOf(id);
    assert.equal(Number(inv.totalAmount), 80);
    assert.equal(paid, 40);
    assert.equal(Number(inv.paidAmount), 40);
    assert.equal(Number(inv.remainingAmount), 40, "remaining reflects both the edit and the payment");
    assert.equal(inv.paymentStatus, "PARTIAL");
  } finally {
    held?.release(); await held?.blocker; await requests;
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a failed audit write rolls the supplier payment back", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE002AUDIT");
  const fn = "ph1_purchase002_audit_" + randomUUID().replaceAll("-", ""), trigger = fn + "_trg";
  let createdFunction = false, createdTrigger = false;
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const id = await invoice(fx, 100);
    await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger AS $f$ BEGIN IF NEW."entityId" = '${id}' AND NEW."action" = 'PURCHASE_PAYMENT_RECORDED' THEN RAISE EXCEPTION 'owned audit failure'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`);
    createdFunction = true;
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    createdTrigger = true;
    const failed = await pay(fx.owner.email, id, 40);
    assert.ok(failed.status >= 400, failed.text);
    const before = await ledgerOf(id);
    assert.equal(before.count, 0, "no payment without its audit row");
    assert.equal(Number(before.inv.paidAmount), 0);
    await db.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "AuditLog"`);
    createdTrigger = false;
    const retry = await pay(fx.owner.email, id, 40);
    assert.equal(retry.status, 200, retry.text);
    const afterRetry = await ledgerOf(id);
    assert.equal(afterRetry.count, 1);
    assert.equal(Number(afterRetry.inv.paidAmount), 40);
  } finally {
    if (createdTrigger) await db.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "AuditLog"`);
    if (createdFunction) await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    await teardownTaggedCafe(fx.cafeId);
  }
});
