import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "@/lib/money";
import { weightedAverageCost, paymentStatusFor } from "@/lib/purchases";
import * as arithmetic from "@/lib/purchase-arithmetic";

test("purchase line rounds the exact half-cent, after normalizing quantity", () => {
  assert.deepEqual(arithmetic.purchaseLine(0.5, 2.01), { quantity: 0.5, unitCost: 2.01, totalCost: 1.01 });
  assert.deepEqual(arithmetic.purchaseLine(1.2345, 10), { quantity: 1.235, unitCost: 10, totalCost: 12.35 });
  assert.deepEqual(arithmetic.purchaseLine(0.0005, 5), { quantity: 0.001, unitCost: 5, totalCost: 0.01 });
  assert.equal(arithmetic.purchaseLine(0.001, 2.01).totalCost, 0);
});

test("cost input keeps numeric JSON, explicit zero, scale and column limits", () => {
  for (const value of [0.004, 2.001, -1, NaN, Infinity, -Infinity, 10000000000, 9999999999.999, "2.01", "", null, undefined]) {
    assert.throws(() => arithmetic.purchaseLine(1, value), arithmetic.PurchaseArithmeticError, String(value));
  }
  assert.deepEqual(arithmetic.purchaseLine(2, 0), { quantity: 2, unitCost: 0, totalCost: 0 });
  assert.equal(arithmetic.purchaseLine(1, 9999999999.99).totalCost, 9999999999.99);
});

test("quantity zero-normalization and input/line/subtotal overflow are refused", () => {
  for (const value of [0, -1, 0.0004, Number.MIN_VALUE, NaN, Infinity, 1000000000, 999999999.9995, "1", null]) {
    assert.throws(() => arithmetic.purchaseLine(value, 1), arithmetic.PurchaseArithmeticError, String(value));
  }
  assert.equal(arithmetic.purchaseLine(999999999.999, 0).quantity, 999999999.999);
  assert.throws(() => arithmetic.purchaseLine(2, 9999999999.99), arithmetic.PurchaseArithmeticError);
  assert.throws(() => arithmetic.purchaseSubtotal([{ totalCost: 9999999999.99 }, { totalCost: 0.01 }]), arithmetic.PurchaseArithmeticError);
});

test("line sums and normalized charges/payment precede dependent totals", () => {
  const subtotal = arithmetic.purchaseSubtotal([arithmetic.purchaseLine(0.5, 2.01), arithmetic.purchaseLine(0.5, 2.01)]);
  assert.equal(subtotal, 2.02); // invoice-level rounding of raw products would be 2.01
  assert.deepEqual(arithmetic.purchaseTotals(subtotal, 0.005, 0.004, 0.005, true), {
    subtotal: 2.02, discount: 0.01, tax: 0, total: 2.01, paid: 0.01, remaining: 2,
  });
  assert.equal(arithmetic.purchaseTotals(1.01, 0, 0, 100, true).paid, 1.01);
  assert.equal(arithmetic.purchaseTotals(1.01, 0, 0, 100).paid, 100);
  assert.equal(arithmetic.purchaseTotals(1.01, 0, 0, 100).remaining, 0);
  assert.throws(() => arithmetic.purchaseTotals(1, 2, 0), arithmetic.PurchaseArithmeticError);
  assert.throws(() => arithmetic.purchaseTotals(9999999999.99, 0, 0.01), arithmetic.PurchaseArithmeticError);
  for (const value of [NaN, Infinity, -1, 10000000000]) {
    assert.throws(() => arithmetic.purchaseTotals(1, value, 0), arithmetic.PurchaseArithmeticError);
    assert.throws(() => arithmetic.purchaseTotals(1, 0, value), arithmetic.PurchaseArithmeticError);
    assert.throws(() => arithmetic.purchaseTotals(1, 0, 0, value), arithmetic.PurchaseArithmeticError);
  }
  assert.equal(paymentStatusFor(2.01, 0.01), "PARTIAL");
  assert.equal(paymentStatusFor(1.01, 1.01), "PAID");
});

test("blank form costs are refused while explicit zero remains a free line", () => {
  for (const text of ["", "  ", "Infinity", "no", "0.004"]) {
    assert.throws(() => arithmetic.purchaseLineFromForm("1", text), arithmetic.PurchaseArithmeticError);
  }
  assert.deepEqual(arithmetic.purchaseLineFromForm("1", "0"), { quantity: 1, unitCost: 0, totalCost: 0 });
  assert.deepEqual(arithmetic.purchaseLineFromForm("1.2345", "10"), { quantity: 1.235, unitCost: 10, totalCost: 12.35 });
});

test("weighted averages round each receipt to two decimals with ties toward positive infinity", () => {
  assert.equal(weightedAverageCost(1, 1, 1, 1.01), 1.01); // 2.01 / 2 = 1.005
  assert.equal(weightedAverageCost(-1, 2.01, 3, 0), -1); // -2.01 / 2 = -1.005
  assert.equal(weightedAverageCost(-1, 0.01, 3, 0), 0); // -0.005 -> 0.00
  assert.equal(weightedAverageCost(10, 450, 2, 460), 451.67);
  assert.equal(weightedAverageCost(12, 451.67, 3, 470), 455.34);
  assert.equal(weightedAverageCost(10, 450, 5, 466), 455.33);
  assert.equal(weightedAverageCost(-3, 10, 5, 12), 15);
  assert.equal(weightedAverageCost(-9, 100, 10, 50), -400);
  assert.equal(weightedAverageCost(-5, 100, 5, 12), 12);
  assert.equal(weightedAverageCost(-6, 100, 5, 12), 12);
  assert.throws(() => weightedAverageCost(-1, 9999999999.99, 1.001, 0), arithmetic.PurchaseArithmeticError);
});

test("stock overflow is refused before the guarded writer", () => {
  assert.equal(arithmetic.purchaseStockAfter(-2, 1), -1);
  assert.equal(arithmetic.purchaseStockAfter(1.234, 0.001), 1.235);
  assert.throws(() => arithmetic.purchaseStockAfter(999999999.999, 0.001), arithmetic.PurchaseArithmeticError);
});

test("purchase clone leaves Decimal global settings unchanged", () => {
  const config = { precision: Decimal.precision, rounding: Decimal.rounding };
  arithmetic.purchaseLine(0.5, 2.01);
  weightedAverageCost(-1, 2.01, 3, 0);
  assert.deepEqual({ precision: Decimal.precision, rounding: Decimal.rounding }, config);
});

// ACC-01B integration: the stored quantity is rounded before the line total.
test("stored quantity, not the typed one, prices the line; a third cost decimal is refused", () => {
  assert.deepEqual(arithmetic.purchaseLine(1.2344, 2.5), { quantity: 1.234, unitCost: 2.5, totalCost: 3.09 });
  assert.throws(() => arithmetic.purchaseUnitCost(1.001), arithmetic.PurchaseArithmeticError);
  assert.throws(() => arithmetic.purchaseQuantity(0.0004), arithmetic.PurchaseArithmeticError);
});
