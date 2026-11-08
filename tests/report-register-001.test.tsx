import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RegisterDetailsContent } from "../src/components/reports/register-details";
import { SalesReportRows } from "../src/components/reports/sales-report-rows";
import { drawerExpected } from "../src/lib/expense-rules";
import { decimal, money, sumMoney } from "../src/lib/money";
import { normalizePaymentEvidence, productRows, type SaleEvent } from "../src/lib/sales-report-math";
import type { ShiftReport } from "../src/lib/shift-report";

const sampleReport: ShiftReport = {
  shiftId: "shift_test_1",
  shiftNumber: 42,
  status: "CLOSED",
  cafe: { name: "نكست كب", currency: "EGP" },
  branch: { id: "branch_1", name: "الفرع الرئيسي" },
  cashierName: "يوسف خالد",
  closedByName: "يوسف خالد",
  openedAt: "2026-11-03T07:00:00.000Z",
  closedAt: "2026-11-03T15:00:00.000Z",
  cash: {
    opening: 500,
    expected: 655,
    actual: 650,
    difference: -5,
    withinTolerance: false,
    tolerance: 0,
    reasonNote: "عجز فكة",
    supplierPayouts: 0,
    expensePayouts: 15,
    expenseReturns: 0,
  },
  sales: {
    total: 325,
    cash: 170,
    card: 155,
    wallet: 0,
    refunds: 20,
    discounts: 0,
    orderCount: 4,
  },
  paymentBreakdown: [
    { method: "CASH", sell: 190, sellCount: 2, refund: 20, expense: 15 },
    { method: "CARD", sell: 155, sellCount: 3, refund: 0, expense: 0 },
    { method: "WALLET", sell: 0, sellCount: 0, refund: 0, expense: 0 },
  ],
  totals: {
    totalSales: 345,
    totalRefund: 20,
    totalPayment: 325,
    creditSales: 0,
    totalExpense: 15,
    equation: {
      opening: 500,
      sale: 190,
      refund: 20,
      expense: 15,
      total: 655,
    },
  },
  productsSold: [
    { sku: "2467", productName: "كابتشينو", variantName: "كبير", categoryName: "مشروبات ساخنة", quantity: 2, total: 150 },
    { sku: "2480", productName: "قهوة تركي", variantName: "صغير", categoryName: "مشروبات ساخنة", quantity: 3, total: 175 },
    { sku: "2580", productName: "مياه صغيرة", variantName: null, categoryName: "مياه", quantity: 2, total: 20 },
  ],
  productsByCategory: [
    { categoryName: "مشروبات ساخنة", quantity: 5, total: 325 },
    { categoryName: "مياه", quantity: 2, total: 20 },
  ],
  tenders: [],
  carried: { count: 0, unpaidTotal: 0, orders: [] },
  cashDisposition: null,
  handover: null,
};

test("RegisterDetailsContent renders payment breakdown, closing equation, SKU table, category table, and thermal print link", () => {
  const html = renderToStaticMarkup(<RegisterDetailsContent report={sampleReport} canClose={true} />);
  assert.equal(sampleReport.totals.equation.total, sampleReport.cash.expected);
  for (const expectedText of [
    "تفاصيل سجل الوردية #42",
    "الفرع الرئيسي",
    "يوسف خالد",
    "500.00",
    "190.00",
    "155.00",
    "(3 حركة)",
    "655.00",
    "650.00",
    "-5.00",
    "2467",
    "كابتشينو (كبير)",
    "2480",
    "قهوة تركي (صغير)",
    "2580",
    "مياه صغيرة",
    "مشروبات ساخنة",
    "345.00",
    "?format=thermal",
  ]) {
    assert.ok(html.includes(expectedText), `Expected RegisterDetailsContent to include: ${expectedText}`);
  }
});

test("SalesReportRows formats shift-sales payment counts, signed over/short, and gates Close button to owner/manager on OPEN shifts", () => {
  const columns = [
    { key: "name", label: "الاسم / الرقم" },
    { key: "status", label: "الحالة" },
    { key: "card", label: "تحصيل بطاقة" },
    { key: "counted", label: "النقد المعدود" },
    { key: "variance", label: "الفرق النهائي" },
  ];
  const rows = [
    {
      id: "shift_open",
      cells: { name: "43", status: "OPEN", card: "155.00", cardCount: "3", counted: null, variance: null },
      details: { branchId: "branch_1" },
    },
    {
      id: "shift_closed",
      cells: { name: "42", status: "CLOSED", card: "50.00", cardCount: "1", counted: "650.00", variance: "-5.00" },
      details: { branchId: "branch_1" },
    },
  ];

  const managerHtml = renderToStaticMarkup(
    <SalesReportRows
      kind="shift-sales"
      canCloseShift={true}
      columns={columns}
      rows={rows}
      onDetail={() => {}}
      onRegisterDetails={() => {}}
    />,
  );
  assert.ok(managerHtml.includes("155.00 (3)"), "card amount shows slip count");
  assert.ok(managerHtml.includes("-5.00"), "variance shows negative shortage");
  assert.ok(managerHtml.includes("عرض السجل"), "shows View Register button");
  assert.ok(managerHtml.includes("/close-shift?branchId=branch_1"), "manager sees Close link on open shift");

  const staffHtml = renderToStaticMarkup(
    <SalesReportRows
      kind="shift-sales"
      canCloseShift={false}
      columns={columns}
      rows={rows}
      onDetail={() => {}}
      onRegisterDetails={() => {}}
    />,
  );
  assert.ok(!staffHtml.includes("/close-shift?branchId=branch_1"), "non-manager does not see Close link");
});

test("Register equation and product/category breakdown reconcile with drawerExpected and productRows", () => {
  const opening = 500;
  const rawLegs = [
    { status: "PAID", id: "p1", orderId: "o1", at: "2026-11-03T08:00:00Z", branchId: "b1", actorId: "u1", actor: "يوسف", shiftId: "s1", method: "CASH", type: "COLLECTION" as const, amount: "190.00", sessionId: null },
    { status: "PAID", id: "r1", orderId: "o1", at: "2026-11-03T08:30:00Z", branchId: "b1", actorId: "u1", actor: "يوسف", shiftId: "s1", method: "CASH", type: "REFUND" as const, amount: "20.00", sessionId: null },
    { status: "PAID", id: "p2", orderId: "o2", at: "2026-11-03T09:00:00Z", branchId: "b1", actorId: "u1", actor: "يوسف", shiftId: "s1", method: "CARD", type: "COLLECTION" as const, amount: "50.00", sessionId: null },
    { status: "PAID", id: "p3", orderId: "o2", at: "2026-11-03T09:05:00Z", branchId: "b1", actorId: "u1", actor: "يوسف", shiftId: "s1", method: "CARD", type: "COLLECTION" as const, amount: "50.00", sessionId: null },
    { status: "PAID", id: "p4", orderId: "o2", at: "2026-11-03T09:10:00Z", branchId: "b1", actorId: "u1", actor: "يوسف", shiftId: "s1", method: "CARD", type: "COLLECTION" as const, amount: "55.00", sessionId: null },
  ];
  const legs = rawLegs.flatMap(normalizePaymentEvidence);
  const cashSell = Number(money(sumMoney(legs.filter((l) => l.method === "CASH" && l.type === "COLLECTION").map((l) => l.amount))).toFixed(2));
  const cashRefund = Number(money(sumMoney(legs.filter((l) => l.method === "CASH" && l.type === "REFUND").map((l) => l.amount))).toFixed(2));
  const cardLegs = legs.filter((l) => l.method === "CARD" && l.type === "COLLECTION");
  const cardSell = Number(money(sumMoney(cardLegs.map((l) => l.amount))).toFixed(2));
  const expense = 15;

  const expected = Number(
    drawerExpected({
      opening,
      netCollections: decimal(cashSell).minus(cashRefund),
      supplierPayouts: 0,
      expensePayouts: expense,
      expenseReturns: 0,
    }).toFixed(2),
  );
  const equationTotal = Number(money(decimal(opening).plus(cashSell).minus(cashRefund).minus(expense)).toFixed(2));
  assert.equal(equationTotal, expected, "equation.total === expectedCashAmount");
  assert.equal(equationTotal, 655);
  assert.equal(cardSell, 155);
  assert.equal(cardLegs.length, 3);

  const shiftEvents: SaleEvent[] = [
    {
      id: "sale:o1",
      orderId: "o1",
      at: "2026-11-03T08:00:00Z",
      branchId: "b1",
      creatorId: "u1",
      serverId: "u1",
      saleShiftId: "s1",
      servedShiftId: "s1",
      postingShiftId: null,
      sessionId: null,
      revenue: "190.00",
      tax: "0.00",
      service: "0.00",
      lines: [
        { id: "l1", productId: "prod_coffee", variantId: null, name: "قهوة تركي", variant: "صغير", sku: "2480", skuSource: "current", categoryId: "cat_hot", category: "مشروبات ساخنة", quantity: 2, gross: "120.00", discount: "0.00", net: "120.00" },
        { id: "l2", productId: "prod_water", variantId: null, name: "مياه صغيرة", variant: null, sku: "2580", skuSource: "current", categoryId: "cat_water", category: "مياه", quantity: 2, gross: "20.00", discount: "0.00", net: "20.00" },
        { id: "l3", productId: "prod_cap", variantId: null, name: "كابتشينو", variant: "كبير", sku: "2467", skuSource: "current", categoryId: "cat_hot", category: "مشروبات ساخنة", quantity: 1, gross: "50.00", discount: "0.00", net: "50.00" },
      ],
    },
    {
      id: "sale:o2",
      orderId: "o2",
      at: "2026-11-03T09:00:00Z",
      branchId: "b1",
      creatorId: "u1",
      serverId: "u1",
      saleShiftId: "s1",
      servedShiftId: "s1",
      postingShiftId: null,
      sessionId: null,
      revenue: "155.00",
      tax: "0.00",
      service: "0.00",
      lines: [
        { id: "l4", productId: "prod_cap", variantId: null, name: "كابتشينو", variant: "كبير", sku: "2467", skuSource: "current", categoryId: "cat_hot", category: "مشروبات ساخنة", quantity: 2, gross: "155.00", discount: "0.00", net: "155.00" },
      ],
    },
  ];

  const prodRows = productRows(shiftEvents, "product");
  const catRows = productRows(shiftEvents, "category");
  const prodTotal = prodRows.reduce((s, r) => s + Number(r.cells.net ?? 0), 0);
  const catTotal = catRows.reduce((s, r) => s + Number(r.cells.net ?? 0), 0);
  assert.equal(prodTotal, 345);
  assert.equal(catTotal, 345, "category totals match product-sales totals");
});

function canConnectPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const fail = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", fail);
    socket.once("timeout", fail);
  });
}

test(
  "buildShiftReport on disposable DB 5434 computes per-method counts, closing equation, SKU rows and category rows matching product-sales",
  { timeout: 60000 },
  async (t) => {
    if (!process.env.DATABASE_URL?.includes("5434") || !(await canConnectPort(5434))) {
      t.skip("Disposable test DB on port 5434 is not currently running");
      return;
    }
    const { db, teardownTaggedCafe } = await import("./helpers/db");
    const { countCafe } = await import("./helpers/count");
    const { recomputeShiftTotals } = await import("../src/lib/shifts");
    const { buildShiftReport } = await import("../src/lib/shift-report");

    const fx = await countCafe("REGREP001");
    try {
      const [catHot, catWater] = await Promise.all([
        db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "مشروبات ساخنة" } }),
        db.menuCategory.create({ data: { cafeId: fx.cafeId, name: "مياه" } }),
      ]);
      const [prodCoffee, prodCap, prodWater] = await Promise.all([
        db.product.create({
          data: { cafeId: fx.cafeId, categoryId: catHot.id, name: "قهوة تركي", sku: "2480", basePrice: 60 },
        }),
        db.product.create({
          data: { cafeId: fx.cafeId, categoryId: catHot.id, name: "كابتشينو", sku: "2467", basePrice: 75 },
        }),
        db.product.create({
          data: { cafeId: fx.cafeId, categoryId: catWater.id, name: "مياه صغيرة", sku: "2580", basePrice: 10 },
        }),
      ]);

      const shift = await db.shift.create({
        data: {
          cafeId: fx.cafeId,
          branchId: fx.branchId,
          cashierId: fx.cashier.id,
          shiftNumber: 901,
          status: "OPEN",
          openingCashAmount: 500,
          expectedCashAmount: 500,
        },
      });

      const order1 = await db.order.create({
        data: {
          cafeId: fx.cafeId,
          branchId: fx.branchId,
          orderNumber: 9001,
          type: "TAKEAWAY",
          status: "SERVED",
          source: "CASHIER_POS",
          createdById: fx.cashier.id,
          servedById: fx.cashier.id,
          saleShiftId: shift.id,
          servedShiftId: shift.id,
          subtotal: 190,
          total: 190,
          paidAmount: 190,
          remainingAmount: 0,
          paymentStatus: "PAID",
          items: {
            create: [
              { productId: prodCoffee.id, productName: "قهوة تركي", quantity: 2, unitPrice: 60, lineTotal: 120 },
              { productId: prodWater.id, productName: "مياه صغيرة", quantity: 2, unitPrice: 10, lineTotal: 20 },
              { productId: prodCap.id, productName: "كابتشينو", quantity: 1, unitPrice: 50, lineTotal: 50 },
            ],
          },
        },
      });

      const order2 = await db.order.create({
        data: {
          cafeId: fx.cafeId,
          branchId: fx.branchId,
          orderNumber: 9002,
          type: "TAKEAWAY",
          status: "SERVED",
          source: "CASHIER_POS",
          createdById: fx.cashier.id,
          servedById: fx.cashier.id,
          saleShiftId: shift.id,
          servedShiftId: shift.id,
          subtotal: 155,
          total: 155,
          paidAmount: 155,
          remainingAmount: 0,
          paymentStatus: "PAID",
          items: {
            create: [
              { productId: prodCap.id, productName: "كابتشينو", quantity: 2, unitPrice: 77.5, lineTotal: 155 },
            ],
          },
        },
      });

      await db.payment.createMany({
        data: [
          {
            cafeId: fx.cafeId,
            orderId: order1.id,
            shiftId: shift.id,
            receivedById: fx.cashier.id,
            method: "CASH",
            type: "COLLECTION",
            status: "PAID",
            amount: 190,
          },
          {
            cafeId: fx.cafeId,
            orderId: order1.id,
            shiftId: shift.id,
            receivedById: fx.cashier.id,
            method: "CASH",
            type: "REFUND",
            status: "PAID",
            amount: 20,
          },
          {
            cafeId: fx.cafeId,
            orderId: order2.id,
            shiftId: shift.id,
            receivedById: fx.cashier.id,
            method: "CARD",
            type: "COLLECTION",
            status: "PAID",
            amount: 50,
          },
          {
            cafeId: fx.cafeId,
            orderId: order2.id,
            shiftId: shift.id,
            receivedById: fx.cashier.id,
            method: "CARD",
            type: "COLLECTION",
            status: "PAID",
            amount: 50,
          },
          {
            cafeId: fx.cafeId,
            orderId: order2.id,
            shiftId: shift.id,
            receivedById: fx.cashier.id,
            method: "CARD",
            type: "COLLECTION",
            status: "PAID",
            amount: 55,
          },
        ],
      });

      const expCat = await db.operatingExpenseCategory.create({
        data: { cafeId: fx.cafeId, code: "ICE_TEST", nameAr: "ثلج", classification: "OPERATING_EXPENSE" },
      });
      await db.operatingExpense.create({
        data: {
          cafeId: fx.cafeId,
          branchId: fx.branchId,
          shiftId: shift.id,
          categoryId: expCat.id,
          amount: 15,
          description: "شراء ثلج",
          executedByUserId: fx.owner.id,
          sourceKey: `operating-expense:${shift.id}:paid:v1`,
        },
      });

      await recomputeShiftTotals(shift.id);
      await db.shift.update({
        where: { id: shift.id },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          financiallyClosedAt: new Date(),
          actualCashAmount: 650,
          cashDifference: -5,
          cashWithinTolerance: false,
        },
      });

      const report = await buildShiftReport(shift.id, fx.cafeId);
      assert.ok(report, "report built for settled shift");
      assert.equal(report.cash.opening, 500);
      assert.equal(report.cash.expected, 655);
      assert.equal(report.totals.equation.total, report.cash.expected, "equation.total === expectedCashAmount");

      const cashRow = report.paymentBreakdown.find((p) => p.method === "CASH")!;
      const cardRow = report.paymentBreakdown.find((p) => p.method === "CARD")!;
      assert.deepEqual(cashRow, { method: "CASH", sell: 190, sellCount: 1, refund: 20, expense: 15 });
      assert.deepEqual(cardRow, { method: "CARD", sell: 155, sellCount: 3, refund: 0, expense: 0 });

      const prodTotal = report.productsSold.reduce((s, r) => s + r.total, 0);
      const catTotal = report.productsByCategory.reduce((s, r) => s + r.total, 0);
      assert.equal(prodTotal, 345);
      assert.equal(catTotal, 345, "category totals match product totals");
      assert.equal(report.productsSold.find((p) => p.sku === "2480")?.quantity, 2);
      assert.equal(report.productsSold.find((p) => p.sku === "2467")?.quantity, 3);
      assert.equal(report.productsSold.find((p) => p.sku === "2580")?.quantity, 2);

      const otherCafeReport = await buildShiftReport(shift.id, "non_existent_cafe_id");
      assert.equal(otherCafeReport, null, "another cafe cannot read this shift report");
    } finally {
      await teardownTaggedCafe(fx.cafeId, [], { disconnect: true });
    }
  },
);
