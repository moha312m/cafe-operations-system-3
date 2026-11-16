import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expenseInput } from "../src/lib/expense-rules";
import { isOperatingExpenseAccount } from "../src/lib/accounting/chart-view";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("expenseInput accepts either categoryId or accountId and rejects when both are missing", () => {
  assert.equal(
    expenseInput.safeParse({ branchId: "b1", categoryId: "c1", amount: 50, description: "نظافة" }).success,
    true,
  );
  assert.equal(
    expenseInput.safeParse({ branchId: "b1", accountId: "a1", amount: 50, description: "نظافة" }).success,
    true,
  );
  assert.equal(
    expenseInput.safeParse({ branchId: "b1", amount: 50, description: "نظافة" }).success,
    false,
  );
});

test("operating expense account filter includes postable active expense accounts and excludes COGS/losses/cash-over-short", () => {
  assert.equal(
    isOperatingExpenseAccount({ type: "EXPENSE", isPostable: true, isActive: true, systemKey: "OTHER_OPERATING_EXPENSE" }),
    true,
  );
  assert.equal(
    isOperatingExpenseAccount({ type: "EXPENSE", isPostable: true, isActive: true, systemKey: null }),
    true,
  );
  for (const systemKey of ["COST_OF_SALES", "PURCHASE_DISCOUNTS", "INVENTORY_LOSS", "CASH_OVER_SHORT"]) {
    assert.equal(
      isOperatingExpenseAccount({ type: "EXPENSE", isPostable: true, isActive: true, systemKey }),
      false,
    );
  }
  assert.equal(
    isOperatingExpenseAccount({ type: "EXPENSE", isPostable: false, isActive: true, systemKey: "HEADER_EXPENSES" }),
    false,
  );
  assert.equal(
    isOperatingExpenseAccount({ type: "ASSET", isPostable: true, isActive: true, systemKey: null }),
    false,
  );
});

test("expenses workspace merges chartAccounts into category choices and shows an inline empty state", () => {
  const src = readFileSync(path.join(root, "src/components/expenses/expense-workspace.tsx"), "utf8");
  assert.match(src, /chartAccounts/);
  assert.match(src, /account:\$\{a\.id\}/);
  assert.match(src, /دليل الحسابات/);
  assert.match(src, /لا توجد تصنيفات مصروفات أو حسابات مصروفات تشغيلية في دليل الحسابات بعد/);
});
