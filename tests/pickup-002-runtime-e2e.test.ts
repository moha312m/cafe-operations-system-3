import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { expectStatus, openRegister, registerApi, registerDb, registerFixture, registerPage } from "./helpers/register-runtime";

after(() => registerDb.$disconnect());
type OrderResult = { order: { id: string; orderNumber: number; paymentStatus: string } };

test("pickup numbers are branch-scoped, waiter tickets are unpaid only and the display sends no customer details", {
  timeout: 120_000,
  skip: process.env.RUN_REGISTER_PICKUP_E2E !== "1" && "requires the dedicated register test instance",
}, async () => {
  const fx = await registerFixture("pickup");
  const product = await fx.makeProduct();
  await openRegister(fx.cashier, fx.branch.id);
  expectStatus(await registerApi(fx.owner, `/api/branches/${fx.branch.id}`, "PATCH", { pickupAtCashier: true, posDefaultOrderType: "TAKEAWAY" }), 200);
  const preferences = expectStatus(await registerApi<{ branches: { id: string; posDefaultOrderType: string; pickupAtCashier: boolean }[] }>(fx.owner, "/api/branches"), 200);
  assert.deepEqual(preferences.branches.map((branch) => [branch.id, branch.posDefaultOrderType, branch.pickupAtCashier]).sort(),
    [[fx.branch.id, "TAKEAWAY", true], [fx.annex.id, "DINE_IN", false]].sort());
  const create = (branchId: string) => registerApi<OrderResult>(fx.owner, "/api/orders", "POST", {
    branchId, type: "TAKEAWAY", collectionMode: "PENDING", customerName: "عميل تجريبي",
    items: [{ productId: product.id, quantity: 1 }],
  }, randomUUID());
  const first = expectStatus(await create(fx.branch.id), 201).order;
  const second = expectStatus(await create(fx.annex.id), 201).order;
  assert.equal(first.orderNumber, 1);
  assert.equal(second.orderNumber, 1);
  assert.notEqual(second.id, first.id);
  for (const order of [first, second]) {
    for (const status of ["PREPARING", "READY"]) {
      expectStatus(await registerApi(fx.owner, `/api/orders/${order.id}/status`, "PATCH", { status }), 200);
    }
  }
  const search = new URLSearchParams({ workspace: "pickup", branchId: fx.branch.id, q: "١" });
  const pickup = expectStatus(await registerApi<{ orders: { id: string }[] }>(fx.cashier, `/api/orders?${search}`), 200);
  assert.deepEqual(pickup.orders.map((row) => row.id), [first.id]);
  const receipt = `/receipts/pickup/${first.id}`;
  const ticket = await registerPage(receipt, fx.waiter);
  assert.equal(ticket.status, 200);
  const reprint = await registerPage(receipt + "?reprint=1", fx.waiter);
  assert.match(await reprint.text(), /ليس لديك صلاحية لطباعة تذكرة الاستلام/);
  assert.match(await ticket.text(), /تذكرة استلام الطلب/);
  assert.match(await (await registerPage(receipt, fx.waiter)).text(), /ليس لديك صلاحية لطباعة تذكرة الاستلام/);
  assert.match(await (await registerPage(receipt + "?reprint=1", fx.cashier)).text(), /تذكرة استلام الطلب/);
  const ticketAudits = await registerDb.auditLog.findMany({
    where: { entity: "Order", entityId: first.id, action: { startsWith: "PICKUP_TICKET_" } },
    orderBy: { createdAt: "asc" },
    select: { action: true },
  });
  assert.deepEqual(ticketAudits.map(({ action }) => action), ["PICKUP_TICKET_PRINTED", "PICKUP_TICKET_REPRINTED"]);

  const displayPath = `/api/display/orders?branchId=${fx.branch.id}`;
  const display = expectStatus(await registerApi<{ ready: { orderNumber: number; pickupAtCashier: boolean }[] }>(fx.cashier, displayPath), 200);
  assert.equal(display.ready.length, 1);
  assert.equal(display.ready[0].orderNumber, 1);
  assert.equal(display.ready[0].pickupAtCashier, true);
  assert.doesNotMatch(JSON.stringify(display), /عميل تجريبي|قهوة اختبار|remainingAmount|customerName/);
  const legacy = expectStatus(await create(fx.branch.id), 201).order;
  await registerDb.order.update({ where: { id: legacy.id }, data: { status: "READY", tableNumber: "5" } });
  const withLegacy = expectStatus(await registerApi<{ ready: { orderNumber: number; pickupAtCashier?: boolean }[] }>(fx.cashier, displayPath), 200);
  const legacyDisplay = withLegacy.ready.find(row => row.orderNumber === legacy.orderNumber);
  assert.ok(legacyDisplay);
  assert.equal(legacyDisplay.pickupAtCashier, undefined);
  assert.equal((await registerPage(displayPath)).status, 401);
  const forbiddenBranch = await registerApi(fx.cashier, `/api/display/orders?branchId=${fx.annex.id}`);
  assert.ok(forbiddenBranch.status === 403 || forbiddenBranch.status === 404);
  await registerDb.cafeSettings.update({ where: { cafeId: fx.cafe.id }, data: { kitchenScreenEnabled: false } });
  assert.equal((await registerApi(fx.cashier, displayPath)).status, 403);

  const pay = { orderId: first.id, method: "CASH", amount: 50, pickup: "COLLECT", pickupExpectedRemaining: "50.00" };
  const payKey = randomUUID();
  assert.equal((await registerApi(fx.waiter, "/api/payments", "POST", pay, randomUUID())).status, 403);
  const collected = expectStatus(await registerApi<{ payments: { id: string }[] }>(fx.cashier, "/api/payments", "POST", pay, payKey), 201);
  assert.equal(expectStatus(await registerApi<{ payments: { id: string }[] }>(fx.cashier, "/api/payments", "POST", pay, payKey), 201).payments[0].id, collected.payments[0].id);
  assert.match(await (await registerPage(receipt, fx.waiter)).text(), /للطلبات غير المدفوعة فقط/);
  const paidReceipt = `/receipts/payment/${collected.payments[0].id}`;
  assert.match(await (await registerPage(paidReceipt, fx.waiter)).text(), /ليس لديك صلاحية لطباعة الريسيت/);
  expectStatus(await registerApi(fx.cashier, `/api/orders/${first.id}/status`, "PATCH", { status: "SERVED" }), 200);
  assert.equal(await registerDb.payment.count({ where: { orderId: first.id } }), 1);
  assert.equal((await registerDb.order.findUniqueOrThrow({ where: { id: first.id } })).status, "SERVED");
  assert.equal((await registerDb.order.findUniqueOrThrow({ where: { id: second.id } })).status, "READY");
});
