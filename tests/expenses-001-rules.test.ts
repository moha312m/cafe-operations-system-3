import { test } from "node:test";
import assert from "node:assert/strict";
import { expenseAmount, drawerExpected, assertExpenseReturn, expenseInput, returnInput, categoryInput, mayExecuteExpense, expenseSourceKey, expenseBranchWhere, expenseAggregate } from "../src/lib/expense-rules";

test("expense money rejects invalid precision, type and storage overflow before rounding", () => {
  assert.equal(expenseAmount(120.01).toFixed(2), "120.01");
  for (const value of [0, -1, NaN, Infinity, 1.001, 10000000000, "12", null, undefined]) assert.throws(() => expenseAmount(value));
  assert.equal(expenseAmount(9999999999.99).toFixed(2), "9999999999.99");
});
test("recomputation keeps payouts separate from sales and counts each source once", () => {
  const source = { opening: "1000", netCollections: "450", supplierPayouts: "0", expensePayouts: "120", expenseReturns: "0" };
  assert.equal(drawerExpected(source).toFixed(2), "1330.00");
  assert.equal(drawerExpected(source).toFixed(2), "1330.00");
  assert.equal(drawerExpected({ ...source, expenseReturns: "20" }).toFixed(2), "1350.00");
  assert.equal(drawerExpected({ ...source, supplierPayouts: "30" }).toFixed(2), "1300.00");
  assert.throws(() => drawerExpected({ ...source, opening: "99999999.99" }));
});
test("actual linked returns cannot exceed the unrecovered amount or use a settled/different drawer", () => {
  const source = { amount: "120", returned: "20", shiftId: "a", currentShiftId: "a", status: "OPEN", custodyValid: true };
  assert.doesNotThrow(() => assertExpenseReturn(source, expenseAmount(100)));
  assert.throws(() => assertExpenseReturn(source, expenseAmount(100.01)));
  for (const status of ["CLOSED", "AWAITING_HANDOVER"]) assert.throws(() => assertExpenseReturn({ ...source, status }, expenseAmount(1)));
  assert.throws(() => assertExpenseReturn({ ...source, currentShiftId: "b" }, expenseAmount(1)));
  assert.throws(() => assertExpenseReturn({ ...source, custodyValid: false }, expenseAmount(1)));
});
test("strict paid-operating-expense contracts refuse alternate flows and client authority", () => {
  const valid = { branchId: "b", categoryId: "c", amount: 120, description: "تنظيف المكان" };
  assert.equal(expenseInput.parse(valid).description, "تنظيف المكان");
  for (const extra of [{ shiftId: "s" }, { actorId: "x" }, { fundingSource: "BANK" }, { purchaseInvoiceId: "p" }, { classification: "ADVANCE" }]) assert.equal(expenseInput.safeParse({ ...valid, ...extra }).success, false);
  assert.equal(returnInput.safeParse({ amount: 20, reason: "" }).success, false);
  assert.equal(categoryInput.safeParse({ nameAr: "بند", code: "CLEAN", classification: "INVENTORY" }).success, false);
  assert.equal(categoryInput.safeParse({ nameAr: "بند", code: "CLEAN", classification: "OPERATING_EXPENSE" }).success, true);
});
test("only the owner and authorized manager execute cash operations", () => {
  assert.equal(mayExecuteExpense("CAFE_OWNER", new Set(["expenses.manage"])), true);
  assert.equal(mayExecuteExpense("BRANCH_MANAGER", new Set(["expenses.manage"])), true);
  for (const role of ["CASHIER", "ACCOUNTANT", "SUPER_ADMIN"]) assert.equal(mayExecuteExpense(role, new Set(["expenses.manage"])), false);
  assert.equal(mayExecuteExpense("BRANCH_MANAGER", new Set()), false);
});
test("immutable source identities distinguish a payout from every linked return", () => {
  assert.equal(expenseSourceKey("expense", "a"), "operating-expense:a:paid:v1");
  assert.equal(expenseSourceKey("return", "b"), "operating-expense-return:b:received:v1");
});

test("branch metadata uses the branch primary key while preserving tenant scope", () => {
  assert.deepEqual(expenseBranchWhere({ cafeId: "c", branchId: "a" }), { cafeId: "c", id: "a" });
  assert.deepEqual(expenseBranchWhere({ cafeId: "c" }), { cafeId: "c" });
  assert.throws(() => expenseBranchWhere({ branchId: "a" }));
});

test("expense source aggregates cannot overflow their snapshot columns", () => {
  assert.equal(expenseAggregate("9999999999.99").toFixed(2), "9999999999.99");
  assert.equal(expenseAggregate("0").toFixed(2), "0.00");
  for (const value of ["10000000000", "NaN", "-1", "1.001"]) assert.throws(() => expenseAggregate(value));
});
