// REPORT-007: the daily report follows the metric contracts in
// src/lib/metric-definitions.ts, adds figures beside the old ones without
// changing them, and rounds money as Decimal rather than float.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";
import { addDays, dateStrInTz, zonedDayStart } from "@/lib/date-range";
import { DAILY_REPORT_METRICS, METRIC_DEFINITIONS_VERSION } from "@/lib/metric-definitions";

let fx: CountCafe;
let productId: string;
let sequence = 0;

before(async () => {
  await requireServer();
  fx = await countCafe("REPORT007");
  await login(fx.owner.email, COUNT_PASSWORD);
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: fx.marker } });
  productId = (await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: fx.marker, basePrice: 1 } })).id;
});
after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

type Report = {
  meta: { definitionsVersion: number; generatedAt: string };
  totals: { orders: number; gross: number; discounts: number; service: number; tax: number; revenue: number; revenueExTax: number; avgOrderValue: number };
  financials: { grossSales: number; netSales: number };
  purchases: { unpaidAsOf: string };
  byBranch: { revenue: number; revenueExTax: number }[];
};

async function served(date: string, bill: { subtotal: number; discount?: number; service?: number; tax?: number; total: number }) {
  sequence += 1;
  await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: sequence,
    type: "TAKEAWAY", status: "SERVED", source: "CASHIER_POS", createdById: fx.cashier.id,
    createdAt: new Date(zonedDayStart(date).getTime() + 12 * 3600_000),
    subtotal: bill.subtotal, discountAmount: bill.discount ?? 0, serviceChargeAmount: bill.service ?? 0,
    taxAmount: bill.tax ?? 0, total: bill.total, paidAmount: 0, remainingAmount: bill.total, paymentStatus: "PENDING_COLLECTION",
    items: { create: [{ productId, productName: fx.marker, quantity: 1, unitPrice: bill.subtotal, lineTotal: bill.subtotal }] },
  } });
}

const report = async (date: string) => {
  const r = await as<Report>(fx.owner.email, `/api/reports/daily?date=${date}&branchId=${fx.branchId}`);
  assert.equal(r.status, 200, r.text);
  return r.body;
};

test("revenue without tax sits beside the unchanged figures", { timeout: 30000 }, async () => {
  const date = addDays(dateStrInTz(new Date()), -1);
  // 100 - 10 discount = 90; 10% service = 9; 14% tax on 99 = 13.86.
  await served(date, { subtotal: 100, discount: 10, service: 9, tax: 13.86, total: 112.86 });
  const r = await report(date);
  assert.deepEqual(
    { gross: r.totals.gross, discounts: r.totals.discounts, service: r.totals.service, tax: r.totals.tax, revenue: r.totals.revenue },
    { gross: 100, discounts: 10, service: 9, tax: 13.86, revenue: 112.86 },
    "existing totals are unchanged",
  );
  assert.equal(r.financials.grossSales, 112.86, "gross sales keep the tax-inclusive bill");
  assert.equal(r.totals.revenueExTax, 99, "tax removed, service kept");
  assert.equal(r.byBranch[0].revenueExTax, 99);
});

test("average order value rounds half-up exactly", { timeout: 30000 }, async () => {
  // 2.01 / 2 = 1.005: float rounding gave 1.00, the exact value rounds to 1.01.
  const date = addDays(dateStrInTz(new Date()), -2);
  await served(date, { subtotal: 1, total: 1 });
  await served(date, { subtotal: 1.01, total: 1.01 });
  const r = await report(date);
  assert.equal(r.totals.revenue, 2.01);
  assert.equal(r.totals.orders, 2);
  assert.equal(r.totals.avgOrderValue, 1.01);
});

test("the report names its definitions and the instant of its live figures", { timeout: 30000 }, async () => {
  const r = await report(dateStrInTz(new Date()));
  assert.equal(r.meta.definitionsVersion, METRIC_DEFINITIONS_VERSION);
  assert.ok(!Number.isNaN(Date.parse(r.meta.generatedAt)));
  assert.equal(r.purchases.unpaidAsOf, r.meta.generatedAt, "the supplier balance is as of the same instant");
  const live = Object.entries(DAILY_REPORT_METRICS).filter(([, d]) => d.basis === "now").map(([k]) => k).sort();
  assert.deepEqual(live, ["openTables", "supplierUnpaid", "tableUncollected"]);
  for (const d of Object.values(DAILY_REPORT_METRICS)) {
    if (d.basis === "now") assert.match(d.label, /حاليًا/, `${d.label} must say it is a live figure`);
  }
});
