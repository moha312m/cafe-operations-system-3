import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { db, sessionFor, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as } from "./helpers/http";
import { refundOrder, refundPayment } from "@/lib/refunds";
import { dateStrInTz } from "@/lib/date-range";

let fx: CountCafe;
before(async () => { fx = await countCafe("REFUND007"); });
after(async () => { if (fx) await teardownTaggedCafe(fx.cafeId); await db.$disconnect(); });

test("full refund after a payment-leg refund reverses only remaining collections", async () => {
  const shift = await db.shift.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id,
    shiftNumber: 90001, openingCashAmount: 100,
  } });
  const order = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 90001,
    status: "SERVED", subtotal: 120, total: 120, paidAmount: 120,
    remainingAmount: 0, paymentStatus: "PAID", createdById: fx.cashier.id,
  } });
  const originals = [];
  for (const [method, amount] of [["CASH", 60], ["CARD", 40], ["WALLET", 20]] as const) {
    originals.push(await db.payment.create({ data: {
      cafeId: fx.cafeId, branchId: fx.branchId, orderId: order.id,
      shiftId: shift.id, cashierId: fx.cashier.id, receivedById: fx.cashier.id, method, amount,
    } }));
  }
  const actor = await sessionFor(fx.cashier.email);
  const card = originals.find(p => p.method === "CARD")!;
  await refundPayment(card.id, actor, "Returned card payment");
  const preview = await as<{ orders: { id: string; paidAmount: string; payments: { method: string; amount: string }[] }[] }>(
    fx.manager.email, "/api/shifts/" + shift.id,
  );
  assert.equal(preview.status, 200, preview.text);
  const target = preview.body.orders.find(o => o.id === order.id)!;
  assert.equal(Number(target.paidAmount), 80);
  assert.equal(target.payments.reduce((sum, p) => sum + Number(p.amount), 0), 80);
  assert.deepEqual(target.payments.map(p => p.method).sort(), ["CASH", "WALLET"]);
  const result = await refundOrder(order.id, actor, "Return remaining order payments");
  assert.equal(Number(result.totalRefunded), 80);
  const refunds = await db.payment.findMany({ where: { orderId: order.id, type: "REFUND" } });
  assert.equal(refunds.length, 3);
  for (const original of originals) {
    const reversals = refunds.filter(p => p.reversalOfPaymentId === original.id);
    assert.equal(reversals.length, 1);
    assert.equal(Number(reversals[0].amount), Number(original.amount));
  }
  const settled = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(settled.paymentStatus, "REFUNDED");
  assert.equal(Number(settled.paidAmount), 0);
  assert.equal(Number(settled.remainingAmount), 0);
  await assert.rejects(refundOrder(order.id, actor, "Duplicate full refund"));
  assert.equal(await db.payment.count({ where: { orderId: order.id, type: "REFUND" } }), 3);
});

async function branchReport(email: string, branchId?: string) {
  const response = await as<{ financials: { grossSales: number }; byBranch: { branchId: string; revenue: number }[] }>(
    email, `/api/reports/daily?date=${dateStrInTz(new Date())}${branchId ? "&branchId=" + branchId : ""}`,
  );
  assert.equal(response.status, 200, response.text);
  return response.body;
}

test("manager daily breakdown cannot expose other branches through an overridden filter", async () => {
  await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.otherBranchId,
    orderNumber: 90002, status: "SERVED", subtotal: 777, total: 777 } });
  const report = await branchReport(fx.manager.email, fx.otherBranchId);
  assert.equal(report.financials.grossSales, 120);
  assert.deepEqual(report.byBranch.map(b => b.branchId), [fx.branchId]);
  assert.equal(report.byBranch[0].revenue, 120);
});

test("owner selected branch breakdown reconciles with headline and unfiltered owner keeps both branches", async () => {
  const report = await branchReport(fx.owner.email, fx.branchId);
  assert.deepEqual(report.byBranch.map(b => b.branchId), [fx.branchId]);
  assert.equal(report.byBranch.reduce((sum, b) => sum + b.revenue, 0), report.financials.grossSales);
  const all = await branchReport(fx.owner.email);
  assert.equal(all.financials.grossSales, 897);
  assert.equal(all.byBranch.length, 2);
});
