import test from "node:test";
import assert from "node:assert/strict";

// Pure unit tests for Executive P&L logic and KPIs
test("Executive P&L KPI formulas and margin calculations", () => {
  const grossSales = 10000;
  const discounts = 500;
  const netRevenue = grossSales - discounts; // 9,500
  assert.equal(netRevenue, 9500);

  const cogs = 3325; // 35% of net revenue
  const cogsPercent = Number(((cogs / netRevenue) * 100).toFixed(1));
  assert.equal(cogsPercent, 35.0);

  const grossProfit = netRevenue - cogs; // 6,175
  assert.equal(grossProfit, 6175);
  const grossMarginPercent = Number(((grossProfit / netRevenue) * 100).toFixed(1));
  assert.equal(grossMarginPercent, 65.0);

  const operatingExpenses = 2850; // 30% of net revenue
  const opExPercent = Number(((operatingExpenses / netRevenue) * 100).toFixed(1));
  assert.equal(opExPercent, 30.0);

  const operatingProfit = grossProfit - operatingExpenses; // 3,325 (35% EBITDA)
  assert.equal(operatingProfit, 3325);
  const operatingMarginPercent = Number(((operatingProfit / netRevenue) * 100).toFixed(1));
  assert.equal(operatingMarginPercent, 35.0);

  const variances = 190; // 2% cash shortage / stock variance
  const netProfit = operatingProfit - variances; // 3,135
  assert.equal(netProfit, 3135);
  const netProfitMarginPercent = Number(((netProfit / netRevenue) * 100).toFixed(1));
  assert.equal(netProfitMarginPercent, 33.0);
});

test("Executive P&L period comparison delta calculations", () => {
  // Current vs Previous Period
  const currentNetRevenue = 12000;
  const prevNetRevenue = 10000;
  const revenueChange = currentNetRevenue - prevNetRevenue;
  const revenueChangePct = Number((((currentNetRevenue - prevNetRevenue) / prevNetRevenue) * 100).toFixed(1));
  assert.equal(revenueChange, 2000);
  assert.equal(revenueChangePct, 20.0);

  // Negative delta (COGS reduction = positive operational efficiency)
  const currentCogs = 3600; // 30%
  const prevCogs = 4000; // 40%
  const cogsChange = currentCogs - prevCogs;
  const cogsChangePct = Number((((currentCogs - prevCogs) / prevCogs) * 100).toFixed(1));
  assert.equal(cogsChange, -400);
  assert.equal(cogsChangePct, -10.0);
});

test("Double-entry Trial Balance accounting equation holds", () => {
  // Assets = Liabilities + Equity + (Revenue - Expenses)
  // Debit = Credit
  const debits = [
    { account: "1110 نقدية الدرج", amount: 1500 },
    { account: "1120 بنك", amount: 4500 },
    { account: "1130 مخزون", amount: 8000 },
    { account: "5100 تكلفة البضاعة المباعة", amount: 3500 },
    { account: "5200 مصروفات تشغيلية", amount: 2000 },
  ];

  const credits = [
    { account: "2110 موردين", amount: 2500 },
    { account: "3100 رأس المال", amount: 7000 },
    { account: "4100 إيرادات المبيعات", amount: 10000 },
  ];

  const totalDebit = debits.reduce((s, d) => s + d.amount, 0);
  const totalCredit = credits.reduce((s, c) => s + c.amount, 0);

  assert.equal(totalDebit, 19500);
  assert.equal(totalCredit, 19500);
  assert.equal(totalDebit - totalCredit, 0);
});
