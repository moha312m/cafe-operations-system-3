// REPORT-001: calendar-day reports must use Cairo, independent of server TZ.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { NextRequest, type NextResponse } from "next/server";
import ts from "typescript";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

let fx: CountCafe;
let productId: string;
let sequence = 0;
const require = createRequire(import.meta.url);
// Cookie auth needs Next's HTTP request context. Supply an already-authenticated
// fixture session only for in-process timezone checks; HTTP checks keep real auth.
const routeModule = { exports: {} as { GET: (request: NextRequest) => Promise<NextResponse> } };
const routeCode = ts.transpileModule(readFileSync(new URL("../src/app/api/reports/daily/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const load = (name: string) => require(name.startsWith("@/")
  ? fileURLToPath(new URL(`../src/${name.slice(2)}`, import.meta.url)) : name);
new Function("require", "module", "exports", routeCode)((name: string) => {
  if (name === "@/lib/api") return { ...load(name), requirePermission: async () => ({
    ...fx.owner, role: "CAFE_OWNER", cafeId: fx.cafeId, branchId: null,
  }) };
  return load(name);
}, routeModule, routeModule.exports);
before(async () => {
  await requireServer();
  fx = await countCafe("REPORT001");
  const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: fx.marker } });
  const product = await db.product.create({ data: {
    cafeId: fx.cafeId, categoryId: category.id, name: fx.marker, basePrice: 20,
  } });
  productId = product.id;
});
after(async () => {
  await load("@/lib/db").db.$disconnect();
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

type Report = {
  date: string;
  totals: { orders: number; revenue: number };
  financials: { grossSales: number; collections: number; refunds: number; netSales: number };
  collection: { paidTotal: number };
  shifts: { closed: number; cashDifferenceTotal: number };
  byPaymentMethod: { method: string; amount: number; count: number }[];
  byCashier: { cashierId: string; amount: number; count: number }[];
  byBranch: { branchId: string; revenue: number; orders: number }[];
  salesByStaff: { userId: string; grossSales: number; refunds: number; netSales: number }[];
  items: { product: string; quantity: number; revenue: number }[];
};

async function sale(when: Date, amount: number) {
  sequence += 1;
  const order = await db.order.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: sequence,
    type: "TAKEAWAY", status: "SERVED", source: "CASHIER_POS",
    createdById: fx.cashier.id, createdAt: when,
    subtotal: amount, total: amount, paidAmount: amount, remainingAmount: 0, paymentStatus: "PAID",
    items: { create: [{ productId, productName: fx.marker, quantity: 1, unitPrice: amount, lineTotal: amount }] },
  } });
  await db.payment.createMany({ data: [
    { cafeId: fx.cafeId, branchId: fx.branchId, orderId: order.id, cashierId: fx.cashier.id,
      receivedById: fx.cashier.id, amount, method: "CASH", type: "COLLECTION", status: "PAID", createdAt: when, paidAt: when },
    { cafeId: fx.cafeId, branchId: fx.branchId, orderId: order.id, cashierId: fx.manager.id,
      receivedById: fx.manager.id, amount: 3, method: "CASH", type: "REFUND", status: "PAID", createdAt: when, paidAt: when },
  ] });
  await db.shift.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: sequence,
    status: "CLOSED", openedAt: when, closedAt: when, openingCashAmount: 0,
    expectedCashAmount: 0, cashDifference: amount,
  } });
}

describe("REPORT-001 Cairo daily report boundaries", () => {
  // Hand-checked UTC instants: +02 winter, +03 summer, 23/25-hour DST days.
  for (const scenario of [
    { date: "2026-01-15", start: "2026-01-14T22:00:00Z", end: "2026-01-15T22:00:00Z" },
    { date: "2026-08-05", start: "2026-08-04T21:00:00Z", end: "2026-08-05T21:00:00Z" },
    { date: "2026-04-24", start: "2026-04-23T22:00:00Z", end: "2026-04-24T21:00:00Z" },
    { date: "2026-10-29", start: "2026-10-28T21:00:00Z", end: "2026-10-29T22:00:00Z" },
  ]) {
    test(`${scenario.date}: includes Cairo start, excludes next day, and keeps every breakdown consistent`, async () => {
      const start = Date.parse(scenario.start);
      const end = Date.parse(scenario.end);
      for (const [at, amount] of [
        [start - 1, 11], [start, 20], [start + 30 * 60_000, 30],
        [end - 1, 40], [end, 50], [end + 60 * 60_000, 60],
      ]) await sale(new Date(at), amount);
      const originalTz = process.env.TZ;
      try {
        for (const tz of ["UTC", "America/New_York", "Africa/Cairo"]) {
          process.env.TZ = tz;
          const result = await routeModule.exports.GET(new NextRequest(`http://localhost/api/reports/daily?date=${scenario.date}`));
          assert.equal(result.status, 200);
          const body = await result.json() as Report;
          assert.equal(body.totals.revenue, 90, `Cairo sales are independent of server TZ=${tz}`);
          assert.equal(body.financials.refunds, 9, `refunds follow the same Cairo day with TZ=${tz}`);
          assert.equal(body.date, scenario.date, `local date label with TZ=${tz}`);
        }
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }
      const response = await as<Report>(fx.owner.email, `/api/reports/daily?date=${scenario.date}`);
      assert.equal(response.status, 200, response.text);
      const report = response.body;
      assert.equal(report.date, scenario.date, "date label remains the requested local date");
      assert.equal(report.totals.revenue, 90, "only the three sales inside the Cairo day belong here");
      assert.equal(report.totals.orders, 3);
      assert.equal(report.financials.grossSales, 90);
      assert.equal(report.financials.collections, 90);
      assert.equal(report.financials.refunds, 9);
      assert.equal(report.financials.netSales, 81);
      assert.equal(report.collection.paidTotal, 90);
      assert.deepEqual(report.byPaymentMethod, [{ method: "CASH", amount: 90, count: 3 }]);
      assert.deepEqual(report.byCashier, [{ cashierId: fx.cashier.id, cashierName: fx.cashier.name, amount: 90, count: 3 }]);
      assert.equal(report.byBranch[0].revenue, 90);
      assert.equal(report.byBranch[0].orders, 3);
      assert.equal(report.salesByStaff[0].userId, fx.cashier.id);
      assert.equal(report.salesByStaff[0].grossSales, 90);
      assert.equal(report.salesByStaff[0].refunds, 9);
      assert.equal(report.items[0].quantity, 3);
      assert.equal(report.items[0].revenue, 90);
      assert.equal(report.shifts.closed, 3);
      assert.equal(report.shifts.cashDifferenceTotal, 90);
    });
  }

  test("omitting date selects today's Cairo calendar date", async () => {
    const cairoDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
    const beforeDate = cairoDate();
    const response = await as<Report>(fx.owner.email, "/api/reports/daily");
    assert.equal(response.status, 200, response.text);
    assert.ok([beforeDate, cairoDate()].includes(response.body.date), "default date is Cairo today even when UTC is yesterday");
  });

  test("invalid and impossible calendar dates return 400", async () => {
    for (const date of ["not-a-date", "2026-02-30", "2026-13-01", "2026-1-05", ""]) {
      const response = await as(fx.owner.email, `/api/reports/daily?date=${encodeURIComponent(date)}`);
      assert.equal(response.status, 400, `${date}: ${response.text}`);
    }
  });
});
