import { test } from "node:test";
import assert from "node:assert/strict";
import { isFinancialLiabilityTable } from "./helpers/financial-liability-tables";

test("payroll, salary and wage surfaces are forbidden", () => {
  for (const name of ["Payroll", "PayrollAdjustment", "SalaryDeduction", "salary_adjustments", "WageAdjustment", "wages", "CompensationLedger"]) {
    assert.equal(isFinancialLiabilityTable(name), true, name);
  }
});

test("debt and liability remain forbidden regardless of inventory words", () => {
  for (const name of ["EmployeeDebt", "employee_debts", "StaffLiability", "staff_liabilities", "Liability", "StockEmployeeDebt", "OrderEmployeeLiability", "InventoryPayrollDeduction"]) {
    assert.equal(isFinancialLiabilityTable(name), true, name);
  }
});

test("employee and financial deductions and penalties are forbidden", () => {
  for (const name of ["EmployeeDeduction", "EmployeeDeductions", "staff_deduction", "staff_deductions", "WorkerPenalty", "personnel_penalties", "HRDeduction", "UserDeduction", "FinancialDeduction", "MoneyDeductions", "PayDeduction", "employee-deductions", "employeeDeduction", "HRDeductions"]) {
    assert.equal(isFinancialLiabilityTable(name), true, name);
  }
});

test("inventory consumption and investigation records are not employee obligations", () => {
  for (const name of ["Stock", "DeferredStockDeduction", "StockDeduction", "StockDeductions", "stock_deductions", "RecipeDeduction", "OrderDeduction", "StockDeductionAudit", "deferred_stock_deductions", "order-deductions", "InventoryTransaction", "VarianceCase", "StockVarianceSpan", "CustodyPeriod", "User", "EmployeeProfile"]) {
    assert.equal(isFinancialLiabilityTable(name), false, name);
  }
});

test("mixed schema discovery retains financial obligations alongside stock tables", () => {
  const names = ["DeferredStockDeduction", "EmployeeDebt", "VarianceCase", "staff_deductions", "StockDeduction", "PayrollAdjustment"];
  assert.deepEqual(names.filter(isFinancialLiabilityTable), ["EmployeeDebt", "staff_deductions", "PayrollAdjustment"]);
});
