import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const data = {
  financials: { netSales: 1000, collections: 730 },
  todayOrders: 12,
  averageOrderValue: 110.75,
  uncollectedTotal: 0,
  pendingCount: 0,
  partialCount: 0,
  inventory: { lowStockCount: 0, outOfStockCount: 0 },
  purchases: { unpaidCount: 0 },
  latestClosedShift: { cashDifference: 0, branch: "التجمع" },
  branches: [{ id: "one", name: "التجمع" }],
  branchPerformance: [{ name: "التجمع", value: 1500 }],
  topProducts: [{ name: "قهوة عربية", quantity: 6, revenue: 180 }],
};

async function render(overrides: Partial<typeof data> = {}, isOwner = true) {
  const { OwnerDashboard } = await import("@/components/dashboard/owner-dashboard");
  return renderToStaticMarkup(createElement(OwnerDashboard, {
    isOwner,
    data: { ...data, ...overrides },
    formatMoney: (value: number) => value.toFixed(2) + " EGP",
  }, createElement("div", null, "تفاصيل الشيفتات والضرائب")));
}

test("owner headline distinguishes net sales and actual collections instead of treating collections as sales", async () => {
  const html = await render();
  assert.match(html, /صافي المبيعات/);
  assert.match(html, /1000\.00 EGP/);
  assert.match(html, /المبالغ المحصّلة/);
  assert.match(html, /730\.00 EGP/);
  assert.match(html, /الطلبات المكتملة/);
  assert.match(html, /متوسط قيمة الطلب/);
  assert.match(html, /110\.75 EGP/);
  assert.doesNotMatch(html, /صافي الربح/);
});

test("owner starts with detailed operating panels closed while retaining access to their content", async () => {
  const html = await render();
  const details = /<details\b([^>]*)>/.exec(html);
  assert.ok(details, "owner can expand the existing detailed dashboard");
  assert.doesNotMatch(details[1], /(?:^|\s)open(?:\s|=|$)/, "full details must not overwhelm the initial view");
  assert.match(html, /عرض التفاصيل/);
  assert.match(html, /تفاصيل الشيفتات والضرائب/);
});

test("the existing staff dashboard is rendered directly without owner-only metrics or a details gate", async () => {
  const html = await render({}, false);
  assert.match(html, /تفاصيل الشيفتات والضرائب/);
  assert.doesNotMatch(html, /<details\b/);
  assert.doesNotMatch(html, /صافي المبيعات/);
});

test("only real exceptions produce owner action links, and a cash shortage is identified as a shortage", async () => {
  const quiet = await render();
  for (const href of ["/inventory", "/orders", "/shifts", "/purchases"]) {
    assert.ok(!quiet.includes('href="' + href + '"'), "zero values must not manufacture an exception for " + href);
  }
  const html = await render({
    uncollectedTotal: 250,
    pendingCount: 2,
    inventory: { lowStockCount: 3, outOfStockCount: 2 },
    purchases: { unpaidCount: 1 },
    latestClosedShift: { cashDifference: -45, branch: "التجمع" },
  });
  for (const href of ["/inventory", "/orders", "/shifts", "/purchases"]) {
    assert.ok(html.includes('href="' + href + '"'), "an exception must lead to its working screen: " + href);
  }
  assert.match(html, /250\.00 EGP/);
  assert.match(html, /عجز/);
  assert.match(html, /45\.00 EGP/);
  assert.doesNotMatch(html, /-45\.00 EGP/);
});

test("a single-branch owner sees a short top-product list without a redundant branch comparison", async () => {
  const html = await render({ topProducts: Array.from({ length: 8 }, (_, index) => ({
    name: "صنف-" + (index + 1), quantity: 20 - index, revenue: 100 - index,
  })) });
  assert.match(html, /صنف-1/);
  assert.match(html, /صنف-5/);
  assert.doesNotMatch(html, /صنف-6/);
  assert.doesNotMatch(html, /أداء الفروع/);
});
