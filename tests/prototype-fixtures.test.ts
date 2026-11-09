import { test } from "node:test";
import assert from "node:assert/strict";
import {
  POS_CATEGORIES,
  POS_PRODUCTS,
  INITIAL_MOCK_CART,
  calculateCartTotals,
  MOCK_EXPENSES,
  MOCK_DASHBOARD_PERIODS,
  MOCK_TASKS,
} from "../src/app/prototypes/_data/mock-data";

test("POS Categories and Products integrity", () => {
  assert.equal(POS_CATEGORIES.length, 4, "Should have 4 categories");
  assert.equal(POS_PRODUCTS.length, 16, "Should have 16 products");

  // Every product has a valid category
  const categoryIds = new Set(POS_CATEGORIES.map((c) => c.id));
  for (const product of POS_PRODUCTS) {
    assert.ok(categoryIds.has(product.categoryId), `Product ${product.id} has invalid category`);
    assert.ok(product.basePrice > 0, `Product ${product.id} must have positive price`);
    assert.ok(product.nameAr.length > 0, `Product ${product.id} must have Arabic name`);
  }
});

test("POS cart calculations with Egyptian 14% VAT", () => {
  const totals = calculateCartTotals(INITIAL_MOCK_CART, 0, 0.14);
  assert.equal(totals.itemCount, 4, "Initial cart has 4 items total");
  assert.equal(totals.subtotal, 375, "Subtotal is 170 + 130 + 75 = 375");
  assert.equal(totals.discount, 0);
  assert.equal(totals.taxableAmount, 375);
  // 375 * 0.14 = 52.5
  assert.equal(totals.taxAmount, 52.5);
  // 375 + 52.5 = 427.5
  assert.equal(totals.total, 427.5);
});

test("POS cart calculations with discount", () => {
  const totals = calculateCartTotals(INITIAL_MOCK_CART, 75, 0.14);
  assert.equal(totals.subtotal, 375);
  assert.equal(totals.discount, 75);
  assert.equal(totals.taxableAmount, 300);
  // 300 * 0.14 = 42
  assert.equal(totals.taxAmount, 42);
  // 300 + 42 = 342
  assert.equal(totals.total, 342);
});

test("MOCK_EXPENSES integrity", () => {
  assert.equal(MOCK_EXPENSES.length, 10, "Should have 10 mock expenses");
  for (const exp of MOCK_EXPENSES) {
    assert.ok(exp.amount > 0, `Expense ${exp.code} must have positive amount`);
    assert.ok(["APPROVED", "PAID", "PENDING"].includes(exp.status));
    assert.ok(exp.vendorName.length > 0);
    assert.ok(exp.branchName.length > 0);
  }

  const pending = MOCK_EXPENSES.filter((e) => e.status === "PENDING");
  assert.equal(pending.length, 2, "Should have 2 pending expenses in initial mock");
});

test("MOCK_DASHBOARD_PERIODS integrity", () => {
  const periods = ["today", "week", "month"] as const;
  for (const p of periods) {
    const data = MOCK_DASHBOARD_PERIODS[p];
    assert.ok(data, `Data for period ${p} must exist`);
    assert.ok(data.kpis.netSales > 0);
    assert.ok(data.kpis.collections > 0);
    assert.ok(data.kpis.expenses > 0);
    assert.equal(data.channelBreakdown.length, 3);
    assert.equal(data.topProducts.length, 5);
    assert.equal(data.branchPerformance.length, 3);
    assert.ok(data.actionInbox.length > 0);
  }
});

test("MOCK_TASKS integrity", () => {
  assert.equal(MOCK_TASKS.length, 7, "Should have 7 operational tasks");
  for (const task of MOCK_TASKS) {
    assert.ok(task.checklist.length > 0, `Task ${task.code} must have checklist items`);
    assert.ok(["PENDING", "IN_PROGRESS", "COMPLETED", "OVERDUE"].includes(task.status));
    assert.ok(["URGENT", "HIGH", "MEDIUM", "ROUTINE"].includes(task.priority));
    assert.ok(task.assigneeName.length > 0);
    assert.ok(task.branchName.length > 0);
  }
});
