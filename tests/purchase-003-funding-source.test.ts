// PURCHASE-003: every supplier payment says where the money came from. Cash
// out of a drawer lowers that shift's expected cash, under the shift lock;
// safe and bank payments never touch a drawer.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

after(async () => { await db.$disconnect(); });

async function invoice(fx: CountCafe, total: number) {
  const item = await countItem(fx, "beans-" + randomUUID().slice(0, 8), { stock: 10 });
  const draft = await as<{ id: string }>(fx.owner.email, "/api/purchases", {
    method: "POST", body: JSON.stringify({ branchId: fx.branchId, items: [{ inventoryItemId: item.id, quantity: 1, unitCost: total }] }),
  });
  assert.equal(draft.status, 201, draft.text);
  return draft.body.id;
}

function pay(fx: CountCafe, id: string, body: Record<string, unknown>) {
  return as<{ paidAmount: number }>(fx.owner.email, `/api/purchases/${id}/payments`, {
    method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify(body),
  });
}

// An open drawer held by `cashierId`, with `opening` cash in it.
async function openShift(fx: CountCafe, cashierId: string, opening: number) {
  const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
  return db.shift.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, cashierId, shiftNumber: (last._max.shiftNumber ?? 0) + 1,
    openingCashAmount: opening, expectedCashAmount: opening,
  } });
}

const drawer = (shiftId: string) => db.shift.findUniqueOrThrow({ where: { id: shiftId } });

async function holdShift(id: string, beforeRelease?: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>) {
  let locked!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { locked = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocker = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Shift" WHERE id = ${id} FOR UPDATE`;
    locked(); await gate;
    await beforeRelease?.(tx);
  }, { timeout: 15000 });
  await entered;
  return { release, blocker };
}

async function waitForShiftWaiters(count: number) {
  for (let n = 0; n < 150; n++) {
    const [state] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%"Shift"%'`;
    if (state.count >= count) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

async function warm(fx: CountCafe, id: string) {
  assert.equal((await pay(fx, id, { amount: 0, method: "CASH" })).status, 400);
}

test("a drawer payment lowers expected cash and nothing else", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE003DRAWER");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const shift = await openShift(fx, fx.owner.id, 500);
    const id = await invoice(fx, 200);
    const r = await pay(fx, id, { amount: 120, method: "CASH", fundingSource: "DRAWER" });
    assert.equal(r.status, 200, r.text);
    const s = await drawer(shift.id);
    assert.equal(Number(s.expectedCashAmount), 380);
    assert.equal(Number(s.totalCashPayouts), 120);
    assert.equal(Number(s.totalCashSales), 0, "a payout is not negative sales");
    const [p] = await db.purchasePayment.findMany({ where: { purchaseInvoiceId: id } });
    assert.equal(p.fundingSource, "DRAWER");
    assert.equal(p.shiftId, shift.id);
    const auditRow = await db.auditLog.findFirstOrThrow({ where: { entityId: id, action: "PURCHASE_PAYMENT_RECORDED" } });
    assert.equal((auditRow.details as { fundingSource?: string }).fundingSource, "DRAWER");

    const safe = await pay(fx, id, { amount: 50, method: "CASH", fundingSource: "SAFE" });
    const bank = await pay(fx, id, { amount: 30, method: "BANK_TRANSFER", fundingSource: "BANK" });
    assert.equal(safe.status, 200, safe.text);
    assert.equal(bank.status, 200, bank.text);
    assert.equal(Number((await drawer(shift.id)).expectedCashAmount), 380, "safe and bank money never pass through the drawer");
    const rows = await db.purchasePayment.findMany({ where: { purchaseInvoiceId: id, fundingSource: { in: ["SAFE", "BANK"] } } });
    assert.deepEqual(rows.map(row => row.shiftId), [null, null]);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("impossible or uncovered drawer payments are refused and record nothing", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE003REFUSE");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const id = await invoice(fx, 300);
    assert.equal((await pay(fx, id, { amount: 10, method: "CASH", fundingSource: "DRAWER" })).status, 400, "no open shift, no drawer");
    const shift = await openShift(fx, fx.owner.id, 100);
    assert.equal((await pay(fx, id, { amount: 150, method: "CASH", fundingSource: "DRAWER" })).status, 400, "more than the drawer holds");
    assert.equal((await pay(fx, id, { amount: 10, method: "CARD", fundingSource: "DRAWER" })).status, 400, "a drawer pays cash");
    assert.equal((await pay(fx, id, { amount: 10, method: "CASH", fundingSource: "BANK" })).status, 400, "a bank never pays cash");
    const created = await as(fx.owner.email, "/api/purchases", {
      method: "POST", body: JSON.stringify({ branchId: fx.branchId, items: [{ inventoryItemId: (await countItem(fx, "milk")).id, quantity: 1, unitCost: 10 }], payment: { amount: 10, method: "CASH", fundingSource: "DRAWER" } }),
    });
    assert.equal(created.status, 400, "a drawer payment is never recorded on invoice creation");
    assert.equal(await db.purchasePayment.count({ where: { cafeId: fx.cafeId } }), 0);
    assert.equal(Number((await drawer(shift.id)).expectedCashAmount), 100);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("a close that wins the shift lock refuses the drawer payment waiting on it", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE003CLOSE");
  let held: Awaited<ReturnType<typeof holdShift>> | undefined;
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const shift = await openShift(fx, fx.owner.id, 100);
    const id = await invoice(fx, 100);
    await warm(fx, id);
    held = await holdShift(shift.id, tx => tx.shift.update({ where: { id: shift.id }, data: { status: "CLOSED", closedAt: new Date() } }));
    const request = pay(fx, id, { amount: 40, method: "CASH", fundingSource: "DRAWER" });
    assert.ok(await waitForShiftWaiters(1), "the payment waits on the shift lock");
    held.release(); await held.blocker; held = undefined;
    const r = await request;
    assert.equal(r.status, 409, r.text);
    assert.equal(await db.purchasePayment.count({ where: { purchaseInvoiceId: id } }), 0);
    assert.equal(Number((await db.purchaseInvoice.findUniqueOrThrow({ where: { id } })).paidAmount), 0);
  } finally {
    held?.release(); await held?.blocker.catch(() => undefined);
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("two drawer payments racing for the same cash cannot overdraw it", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE003RACE");
  let held: Awaited<ReturnType<typeof holdShift>> | undefined;
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const shift = await openShift(fx, fx.owner.id, 100);
    const id = await invoice(fx, 200);
    await warm(fx, id);
    held = await holdShift(shift.id);
    const requests = Promise.all([1, 2].map(() => pay(fx, id, { amount: 70, method: "CASH", fundingSource: "DRAWER" })));
    assert.ok(await waitForShiftWaiters(2), "both payments wait on the shift lock");
    held.release(); await held.blocker; held = undefined;
    const statuses = (await requests).map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 400]);
    const s = await drawer(shift.id);
    assert.equal(Number(s.expectedCashAmount), 30);
    assert.equal(Number(s.totalCashPayouts), 70);
  } finally {
    held?.release(); await held?.blocker.catch(() => undefined);
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("the database refuses a funding source that contradicts its shift or method", { timeout: 30000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE003CHECK");
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const shift = await openShift(fx, fx.owner.id, 0);
    const id = await invoice(fx, 100);
    const base = { cafeId: fx.cafeId, branchId: fx.branchId, purchaseInvoiceId: id, amount: 1 };
    for (const [label, data] of [
      ["drawer without a shift", { ...base, method: "CASH", fundingSource: "DRAWER" }],
      ["a shift on a safe payment", { ...base, method: "CASH", fundingSource: "SAFE", shiftId: shift.id }],
      ["a safe paying by card", { ...base, method: "CARD", fundingSource: "SAFE" }],
      ["a bank paying cash", { ...base, method: "CASH", fundingSource: "BANK" }],
    ] as const) {
      await assert.rejects(db.purchasePayment.create({ data }), /PurchasePayment_funding_check|23514|check constraint/i, label);
    }
    await db.purchasePayment.create({ data: { ...base, method: "CASH" } }); // legacy shape stays valid
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
