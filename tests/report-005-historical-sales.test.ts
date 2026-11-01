import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

let fx: CountCafe;
before(async () => {
  await requireServer();
  fx = await countCafe("HISTORICALSALES");
  const base = {
    cafeId: fx.cafeId, sourceHash: "test-source", sku: "2580", productName: "Small Water",
    invoiceNo: "16117", saleLocalDate: "01-01-2026 10:40 AM", saleDate: "2026-01-01", saleMonth: "2026-01",
    quantity: 1, quantityUnit: "Pc(s)", unitPrice: 100, discount: 0, tax: 0, priceIncTax: 100,
    total: 100, paymentMethod: "Cash",
  };
  await db.historicalSaleLine.createMany({ data: [
    { ...base, sourceRow: 2 },
    { ...base, sourceRow: 3, invoiceNo: "16118", saleLocalDate: "01-02-2026 10:40 AM",
      saleDate: "2026-02-01", saleMonth: "2026-02", total: 50, unitPrice: 50, priceIncTax: 50, paymentMethod: "Card" },
  ] });
});
after(async () => { await teardownTaggedCafe(fx.cafeId, [], { disconnect: true }); });

test("owner sees source lines by month without turning them into POS orders", async () => {
  const r = await as<{ totals: { lines: number; revenue: number }; monthly: Array<{ month: string; revenue: number }> }>(fx.owner.email, "/api/reports/historical-sales?year=2026");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.totals, { lines: 2, revenue: 150, discount: 0,
    firstDate: "2026-01-01", lastDate: "2026-02-01" });
  assert.deepEqual(r.body.monthly.map(row => [row.month, row.revenue]), [["2026-01", 100], ["2026-02", 50]]);
  assert.equal(await db.order.count({ where: { cafeId: fx.cafeId } }), 0);
  const empty = await as<{ totals: { lines: number } }>(fx.owner.email, "/api/reports/historical-sales?year=2025");
  assert.equal(empty.body.totals.lines, 0);
});

test("branch manager cannot read cafe-wide imported revenue", async () => {
  const r = await as(fx.manager.email, "/api/reports/historical-sales?year=2026");
  assert.equal(r.status, 403, r.text);
  const lines = await as(fx.manager.email, "/api/reports/historical-sales/lines?year=2026");
  assert.equal(lines.status, 403, lines.text);
});

test("owner can inspect original sale lines by month and invoice", async () => {
  const r = await as<{ total: number; rows: Array<{ invoiceNo: string; sku: string; total: number }> }>(fx.owner.email, "/api/reports/historical-sales/lines?year=2026&month=2026-02&q=16118");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.total, 1);
  assert.deepEqual(r.body.rows.map(row => [row.invoiceNo, row.sku, row.total]), [["16118", "2580", 50]]);
  const invalid = await as(fx.owner.email, "/api/reports/historical-sales/lines?year=2026&month=2025-02");
  assert.equal(invalid.status, 400, invalid.text);
});

test("owner cafe scope ignores a foreign cafeId instead of leaking another tenant", async () => {
  const r = await as<{ totals: { revenue: number } }>(fx.owner.email, `/api/reports/historical-sales?year=2026&cafeId=${fx.otherBranchId}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.totals.revenue, 150);
});
