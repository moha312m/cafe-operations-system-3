import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

let fx: CountCafe;
let foreign: CountCafe;
let customerId: string;
let productId: string;
let ownOrderId: string;
let otherOrderId: string;
let foreignOrderId: string;
let ownTableId: string;
let otherTableId: string;
let ownShiftId: string;
let otherShiftId: string;
let platform: { id: string; email: string };

async function order(cafe: CountCafe, branchId: string, number: number, tableSessionId?: string) {
  return db.order.create({ data: {
    cafeId: cafe.cafeId, branchId, orderNumber: number, subtotal: 10, total: 10,
    remainingAmount: 10, customerId: cafe === fx ? customerId : undefined,
    tableSessionId, customerName: "Read scope customer",
    items: { create: { productId: cafe === fx ? productId : undefined, productName: "Scoped item", unitPrice: 10, quantity: 1, lineTotal: 10 } },
  } });
}

before(async () => {
  await requireServer();
  fx = await countCafe("SEC006");
  foreign = await countCafe("SEC006FOREIGN");
  platform = await db.user.create({ data: {
    email: `${fx.marker.toLowerCase()}-platform@example.invalid`, name: "Read scope platform", role: "SUPER_ADMIN",
    passwordHash: (await db.user.findUniqueOrThrow({ where: { id: fx.owner.id } })).passwordHash,
  }, select: { id: true, email: true } });
  await login(platform.email, COUNT_PASSWORD);
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "Read scope category" } });
  productId = (await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: "Scoped item", basePrice: 10 } })).id;
  const customer = await db.customer.create({ data: {
    cafeId: fx.cafeId, phone: "01012345678", normalizedPhone: "01012345678", name: "Shared customer",
  } });
  customerId = customer.id;
  const ownTable = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, tableNumber: "1" } });
  const otherTable = await db.tableSession.create({ data: { cafeId: fx.cafeId, branchId: fx.otherBranchId, tableNumber: "2" } });
  ownTableId = ownTable.id;
  otherTableId = otherTable.id;
  ownOrderId = (await order(fx, fx.branchId, 1, ownTableId)).id;
  otherOrderId = (await order(fx, fx.otherBranchId, 2, otherTableId)).id;
  foreignOrderId = (await order(foreign, foreign.branchId, 1)).id;
  for (const orderId of [ownOrderId, otherOrderId]) {
    await db.loyaltyTransaction.create({ data: { cafeId: fx.cafeId, customerId, orderId, type: "EARN", points: 1 } });
  }
  const ownShift = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: 1, status: "CLOSED" } });
  const otherShift = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.otherBranchId, cashierId: fx.owner.id, shiftNumber: 1, status: "CLOSED" } });
  ownShiftId = ownShift.id;
  otherShiftId = otherShift.id;
});

after(async () => {
  if (platform) {
    await db.auditLog.deleteMany({ where: { userId: platform.id } });
    await db.user.delete({ where: { id: platform.id } });
  }
  if (foreign) await teardownTaggedCafe(foreign.cafeId);
  if (fx) await teardownTaggedCafe(fx.cafeId);
  await db.$disconnect();
});

// Removing the scope predicate exposes a known foreign identifier.
test("order detail hides other branches and tenants while allowing the current branch", async () => {
  const own = await as<{ order: { id: string } }>(fx.manager.email, `/api/orders/${ownOrderId}`);
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.order.id, ownOrderId);
  for (const id of [otherOrderId, foreignOrderId, "missing-order"]) {
    const response = await as(fx.manager.email, `/api/orders/${id}`);
    assert.equal(response.status, 404, response.text);
    assert.equal("order" in response.body, false);
  }
});

test("table, collection, and shift detail cannot disclose another branch", async () => {
  for (const path of [
    `/api/tables/${otherTableId}`,
    `/api/payments/collect-info?orderId=${otherOrderId}`,
    `/api/payments/collect-info?tableSessionId=${otherTableId}`,
    `/api/shifts/${otherShiftId}`,
    `/api/shifts/${otherShiftId}/report`,
  ]) {
    const response = await as(fx.manager.email, path);
    assert.equal(response.status, 404, `${path}: ${response.text}`);
  }
  for (const path of [`/api/tables/${ownTableId}`, `/api/shifts/${ownShiftId}`]) {
    const response = await as(fx.manager.email, path);
    assert.equal(response.status, 200, `${path}: ${response.text}`);
  }
});

test("customer history returns only the employee's branch orders and loyalty evidence", async () => {
  const history = await as<{ orders: { id: string }[]; transactions: { orderNumber: number }[] }>(fx.manager.email, `/api/customers/${customerId}`);
  assert.equal(history.status, 200, history.text);
  assert.deepEqual(history.body.orders.map(o => o.id), [ownOrderId]);
  assert.deepEqual(history.body.transactions.map(t => t.orderNumber), [1]);
});

test("repeat-order lookup returns the latest order in the employee's branch", async () => {
  const last = await as<{ order: { orderNumber: number } | null }>(fx.cashier.email, "/api/customers/last-order?phone=01012345678");
  assert.equal(last.status, 200, last.text);
  assert.equal(last.body.order?.orderNumber, 1);
});

test("unassigned staff fail closed even when they supply a branch", async () => {
  await db.user.update({ where: { id: fx.manager.id }, data: { branchId: null } });
  try {
    for (const path of [
      `/api/orders/${ownOrderId}`, `/api/tables/${ownTableId}`, `/api/shifts/${ownShiftId}`,
      `/api/payments/collect-info?orderId=${ownOrderId}`, `/api/customers/${customerId}`,
      "/api/customers/last-order?phone=01012345678",
      `/api/orders?branchId=${fx.branchId}`, `/api/tables?branchId=${fx.branchId}`,
      `/api/tables/session?branchId=${fx.branchId}&tableNumber=1`,
      `/api/tables/selector?branchId=${fx.branchId}`,
      "/api/qr-orders/pending",
    ]) {
      const response = await as(fx.manager.email, path);
      assert.equal(response.status, 403, `${path}: ${response.text}`);
    }
  } finally {
    await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.branchId } });
  }
});

test("unassigned owners retain café access and cannot read another tenant", async () => {
  for (const id of [ownOrderId, otherOrderId]) {
    const response = await as(fx.owner.email, `/api/orders/${id}`);
    assert.equal(response.status, 200, response.text);
  }
  const response = await as(fx.owner.email, `/api/orders/${foreignOrderId}`);
  assert.equal(response.status, 404, response.text);
});

test("an existing login follows a changed branch assignment", async () => {
  await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.otherBranchId } });
  try {
    const previous = await as(fx.manager.email, `/api/orders/${ownOrderId}`);
    assert.equal(previous.status, 404, previous.text);
    const current = await as<{ order: { id: string } }>(fx.manager.email, `/api/orders/${otherOrderId}`);
    assert.equal(current.status, 200, current.text);
    assert.equal(current.body.order.id, otherOrderId);
  } finally {
    await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.branchId } });
  }
});

test("a pinned owner is restricted to the assigned branch", async () => {
  await db.user.update({ where: { id: fx.owner.id }, data: { branchId: fx.branchId } });
  try {
    assert.equal((await as(fx.owner.email, `/api/orders/${ownOrderId}`)).status, 200);
    const response = await as(fx.owner.email, `/api/orders/${otherOrderId}`);
    assert.equal(response.status, 404, response.text);
  } finally {
    await db.user.update({ where: { id: fx.owner.id }, data: { branchId: null } });
  }
});

test("temporary assignment scopes order reads to the effective branch", async () => {
  await db.user.update({ where: { id: fx.manager.id }, data: {
    temporaryBranchId: fx.otherBranchId, temporaryBranchUntil: new Date(Date.now() + 3_600_000), temporaryBranchStartedAt: new Date(),
  } });
  try {
    const previous = await as(fx.manager.email, `/api/orders/${ownOrderId}`);
    assert.equal(previous.status, 404, previous.text);
    const current = await as(fx.manager.email, `/api/orders/${otherOrderId}`);
    assert.equal(current.status, 200, current.text);
  } finally {
    await db.user.update({ where: { id: fx.manager.id }, data: {
      temporaryBranchId: null, temporaryBranchUntil: null, temporaryBranchStartedAt: null, temporaryBranchCancelledAt: null,
    } });
  }
});

test("platform administrators retain cross-tenant order detail access", async () => {
  for (const id of [ownOrderId, otherOrderId, foreignOrderId]) {
    const response = await as<{ order: { id: string } }>(platform.email, `/api/orders/${id}`);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.order.id, id);
  }
});

for (const endpoint of ["orders/open-summary", "handovers/carried-orders", "dashboard", "reports/daily", "reports/employee-actions"]) {
  test(`unassigned staff cannot read ${endpoint} with a supplied branch`, async () => {
    await db.user.update({ where: { id: fx.manager.id }, data: { branchId: null } });
    try {
      const response = await as(fx.manager.email, `/api/${endpoint}?branchId=${fx.otherBranchId}&from=2026-10-05&to=2026-10-05`);
      assert.equal(response.status, 403, response.text);
    } finally {
      await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.branchId } });
    }
  });
}

test("platform administrator can read customer history across branches", async () => {
  const response = await as<{ orders: { id: string }[] }>(platform.email, `/api/customers/${customerId}`);
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.orders.map(o => o.id).sort(), [ownOrderId, otherOrderId].sort());
});

test("unassigned staff cannot read employee action history without a branch selector", async () => {
  await db.user.update({ where: { id: fx.manager.id }, data: { branchId: null } });
  try {
    const response = await as(fx.manager.email, "/api/reports/employee-actions?from=2026-10-05&to=2026-10-05");
    assert.equal(response.status, 403, response.text);
  } finally {
    await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.branchId } });
  }
});
