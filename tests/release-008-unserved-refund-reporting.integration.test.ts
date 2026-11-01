// Owner policy: money refunded before service never reverses a recognized
// sale. Primary proof moves real fixture money through collection and the
// owner-request/decision/execute services; no settlement rows are fabricated.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { collectOrderPayment } from "../src/lib/payments";
import { requestOwnerAction, decideOwnerAction } from "../src/lib/owner-action-approvals";
import { executeApprovedAction } from "../src/lib/approved-order-actions";
import { ensureCustodyForShift } from "../src/lib/custody";
import { periodFinancials, salesByStaff, refundsByActor, type FinancialScope } from "../src/lib/reporting";
import { assertIntegrationDatabase } from "./helpers/integration-guard";
import type { SessionUser } from "../src/lib/auth";

test.before(async () => { await assertIntegrationDatabase(db); });
test.after(() => db.$disconnect());

async function fixture() {
  const marker = "REL008-" + randomUUID();
  const cafe = await db.cafe.create({ data: { name: marker, slug: marker.toLowerCase() } });
  const branch = await db.branch.create({ data: { cafeId: cafe.id, name: marker + " main" } });
  const annex = await db.branch.create({ data: { cafeId: cafe.id, name: marker + " annex" } });
  const owner = await db.user.create({ data: { cafeId: cafe.id, name: marker + " owner", email: marker.toLowerCase() + "-owner@example.invalid", role: "CAFE_OWNER", passwordHash: "NO_LOGIN" } });
  const manager = await db.user.create({ data: { cafeId: cafe.id, branchId: branch.id, name: marker + " manager", email: marker.toLowerCase() + "-manager@example.invalid", role: "BRANCH_MANAGER", passwordHash: "NO_LOGIN" } });
  const actor = { id: manager.id, cafeId: cafe.id, branchId: branch.id, role: manager.role, email: manager.email, name: manager.name } as SessionUser;
  const ownerActor = { id: owner.id, cafeId: cafe.id, branchId: null, role: owner.role, email: owner.email, name: owner.name } as SessionUser;
  await db.cafeSettings.create({ data: { cafeId: cafe.id, finishedGoodsSalesEnabled: false } });
  await db.ownerActionSettings.create({ data: { cafeId: cafe.id, ownerId: owner.id } });
  const shift = await db.shift.create({ data: { cafeId: cafe.id, branchId: branch.id, cashierId: manager.id, shiftNumber: 1, openingCashAmount: 100 } });
  await db.$transaction(tx => ensureCustodyForShift(tx, { cafeId: cafe.id, branchId: branch.id, shiftId: shift.id, userId: manager.id, openingCashAmount: 100 }));
  let orderNumber = 1;
  async function order(amount: number, status: "READY" | "SERVED", createdAt = new Date()) {
    return db.order.create({ data: { cafeId: cafe.id, branchId: branch.id, orderNumber: orderNumber++, source: "CASHIER_POS", type: "TAKEAWAY", status, createdAt,
      createdById: manager.id, saleShiftId: shift.id, subtotal: amount, total: amount, paidAmount: 0, remainingAmount: amount, paymentStatus: "UNPAID",
      items: { create: { productName: marker + " recipe sale", quantity: 1, unitPrice: amount, lineTotal: amount, kitchenStatus: status } },
    } });
  }
  async function collect(orderId: string, amount: number) {
    return collectOrderPayment({ session: actor, orderId, branchId: branch.id, splits: [{ method: "CASH", amount }] });
  }
  async function approved(action: "REFUND_ORDER" | "CANCEL_ORDER", orderId: string) {
    const requested = await requestOwnerAction({ actor, action, orderId, reason: marker + " actual approved recovery", idempotencyKey: randomUUID() });
    const decision = await decideOwnerAction({ actor: ownerActor, requestId: requested.requestId, decision: "ACCEPT" });
    assert.equal(decision.status, "APPROVED");
    const result = await executeApprovedAction({ actor, requestId: requested.requestId, idempotencyKey: randomUUID() });
    assert.equal(result.status, "EXECUTED");
  }
  const scope: FinancialScope = { cafeId: cafe.id, branchId: branch.id, period: { gte: new Date(0) } };
  return { marker, cafe, branch, annex, actor, order, collect, approved, scope };
}

test("never-served approved refund and cancellation remain money activity, not negative sales", async t => {
  const f = await fixture();
  const refundedSale = await f.order(20, "SERVED");
  await f.collect(refundedSale.id, 20);
  await f.approved("REFUND_ORDER", refundedSale.id);
  const winner = await f.order(30, "SERVED");
  await f.collect(winner.id, 30);
  const loser = await f.order(30, "READY");
  await f.collect(loser.id, 30);
  await f.approved("REFUND_ORDER", loser.id);
  await f.approved("CANCEL_ORDER", loser.id);
  const addon = await f.order(25, "SERVED");
  await f.collect(addon.id, 25);
  const financials = await periodFinancials(f.scope);
  const staff = await salesByStaff(f.scope);
  const actors = await refundsByActor(f.scope);
  t.diagnostic(JSON.stringify({ cafeId: f.cafe.id, served: [refundedSale.id, winner.id, addon.id], neverServed: loser.id, financials, staff, actors }));
  const cancelled = await db.order.findUniqueOrThrow({ where: { id: loser.id } });
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.servedAt, null);
  assert.equal(cancelled.paymentStatus, "REFUNDED");
  assert.equal(await db.payment.count({ where: { orderId: loser.id, type: "REFUND", reversalOfPaymentId: { not: null } } }), 1);
  assert.equal(financials.grossSales, 75);
  assert.equal(financials.refunds, 50, "all money refunds remain visible");
  assert.equal(financials.collections, 105);
  assert.equal(financials.netMoneyMovement, 55);
  assert.equal(financials.cashRefunds, 50);
  assert.equal(financials.netSales, 55, "only the 20 refund of recognized sales reduces gross 75");
  const classified = financials as typeof financials & { salesRefunds: number; unservedRefunds: number };
  assert.equal(classified.salesRefunds, 20);
  assert.equal(classified.unservedRefunds, 30);
  assert.equal(staff.length, 1);
  assert.equal(staff[0].grossSales, 75);
  assert.equal(staff[0].refunds, 20);
  assert.equal(staff[0].netSales, 55);
  assert.equal(actors.find(row => row.userId === f.actor.id)?.refunds, 50, "processing activity includes both refunds");
});

test("a served sale from an earlier period still posts its actual refund in the current period", async t => {
  const f = await fixture();
  const sale = await f.order(20, "SERVED", new Date("2020-01-10T10:00:00Z"));
  const since = new Date();
  await f.collect(sale.id, 20);
  await f.approved("REFUND_ORDER", sale.id);
  const scope = { ...f.scope, period: { gte: since } };
  const financials = await periodFinancials(scope);
  const staff = await salesByStaff(scope);
  t.diagnostic(JSON.stringify({ cafeId: f.cafe.id, orderId: sale.id, financials, staff }));
  assert.equal(financials.grossSales, 0);
  assert.equal(financials.refunds, 20);
  assert.equal(financials.netSales, -20);
  assert.equal((financials as typeof financials & { salesRefunds: number }).salesRefunds, 20);
  assert.equal(staff[0].grossSales, 0);
  assert.equal(staff[0].refunds, 20);
  assert.equal(staff[0].netSales, -20);
});

test("legacy refunded collections retain branch-window scope and reduce only recognized sales", async t => {
  const f = await fixture();
  const at = new Date("2026-03-10T12:00:00Z");
  // Secondary compatibility proof seeds the historical representation itself;
  // the primary proof above uses only actual collection/refund services.
  for (const [branchId, status, amount, method, number] of [
    [f.branch.id, "SERVED", 12, "CARD", 7001],
    [f.branch.id, "CANCELLED", 7, "CASH", 7002],
    [f.annex.id, "SERVED", 777, "CASH", 7003],
  ] as const) {
    const order = await db.order.create({ data: { cafeId: f.cafe.id, branchId, orderNumber: number, source: "CASHIER_POS", status, createdById: f.actor.id, createdAt: at,
      subtotal: amount, total: amount, paidAmount: 0, remainingAmount: 0, paymentStatus: "REFUNDED" } });
    await db.payment.create({ data: { cafeId: f.cafe.id, orderId: order.id, branchId: null, cashierId: f.actor.id, receivedById: f.actor.id,
      type: "COLLECTION", status: "REFUNDED", method, amount, createdAt: at } });
  }
  const scope: FinancialScope = { ...f.scope, windows: [{ branchId: f.branch.id, from: new Date("2026-03-10T00:00:00Z"), to: new Date("2026-03-11T00:00:00Z") }] };
  const financials = await periodFinancials(scope);
  const staff = await salesByStaff(scope);
  t.diagnostic(JSON.stringify({ cafeId: f.cafe.id, branchId: f.branch.id, financials, staff }));
  assert.equal(financials.grossSales, 12);
  assert.equal(financials.refunds, 19);
  assert.equal(financials.collections, 19);
  assert.equal(financials.netMoneyMovement, 0);
  assert.equal(financials.cashRefunds, 7);
  assert.equal(financials.cardRefunds, 12);
  assert.equal(financials.netSales, 0);
  const classified = financials as typeof financials & { salesRefunds: number; unservedRefunds: number };
  assert.equal(classified.salesRefunds, 12);
  assert.equal(classified.unservedRefunds, 7);
  assert.equal(staff.length, 1);
  assert.equal(staff[0].grossSales, 12);
  assert.equal(staff[0].refunds, 12);
  assert.equal(staff[0].netSales, 0);
});
