import { test } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import {
  validateConfirmationPhrase,
  parseDateFilter,
  aggregateRestoredInventory,
  buildOrderScopeWhere,
  previewSalesReset,
  executeSalesReset,
  executeSalesResetInTransaction,
} from "../src/lib/sales-reset";
import {
  overrideCodeFrom,
  overrideCodeMatches,
  OWNER_OVERRIDE_HEADER,
  OWNER_OVERRIDE_REFUSED,
  OWNER_OVERRIDE_LOCKED,
} from "../src/lib/owner-override";

test("validateConfirmationPhrase accepts Arabic phrase and English RESET (case-insensitive and trimmed)", () => {
  // Valid cases
  assert.equal(validateConfirmationPhrase("تصفير المبيعات"), true);
  assert.equal(validateConfirmationPhrase("  تصفير المبيعات  "), true);
  assert.equal(validateConfirmationPhrase("RESET"), true);
  assert.equal(validateConfirmationPhrase("reset"), true);
  assert.equal(validateConfirmationPhrase("  RESET  "), true);
  assert.equal(validateConfirmationPhrase("  Reset  "), true);

  // Invalid cases
  assert.equal(validateConfirmationPhrase(""), false);
  assert.equal(validateConfirmationPhrase("   "), false);
  assert.equal(validateConfirmationPhrase(null), false);
  assert.equal(validateConfirmationPhrase(undefined), false);
  assert.equal(validateConfirmationPhrase("تصفير"), false);
  assert.equal(validateConfirmationPhrase("حذف المبيعات"), false);
  assert.equal(validateConfirmationPhrase("CONFIRM"), false);
  assert.equal(validateConfirmationPhrase("DELETE"), false);
});

test("parseDateFilter handles empty, single-boundary, and full range inputs", () => {
  // Empty
  assert.equal(parseDateFilter(undefined, undefined), undefined);
  assert.equal(parseDateFilter("", ""), undefined);
  assert.equal(parseDateFilter("   ", "   "), undefined);
  assert.equal(parseDateFilter("invalid-date", "another-invalid"), undefined);

  // Only from
  const fromOnly = parseDateFilter("2026-11-01T00:00:00.000Z", undefined);
  assert.ok(fromOnly);
  assert.equal(fromOnly.gte?.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(fromOnly.lte, undefined);

  // Only to (date-only: expands to 23:59:59.999 UTC)
  const toDateOnly = parseDateFilter(undefined, "2026-11-08");
  assert.ok(toDateOnly);
  assert.equal(toDateOnly.gte, undefined);
  assert.equal(toDateOnly.lte?.getUTCHours(), 23);
  assert.equal(toDateOnly.lte?.getUTCMinutes(), 59);
  assert.equal(toDateOnly.lte?.getUTCSeconds(), 59);
  assert.equal(toDateOnly.lte?.getUTCMilliseconds(), 999);

  // Both from and to
  const fullRange = parseDateFilter("2026-11-01T08:00:00.000Z", "2026-11-08T20:00:00.000Z");
  assert.ok(fullRange);
  assert.equal(fullRange.gte?.toISOString(), "2026-11-01T08:00:00.000Z");
  assert.equal(fullRange.lte?.toISOString(), "2026-11-08T20:00:00.000Z");
});

test("aggregateRestoredInventory correctly aggregates and restores negative consumption deltas", () => {
  const transactions = [
    // Item 1: Coffee Beans (two deductions: -0.018 kg and -0.036 kg -> +0.054 kg)
    {
      quantity: -0.018,
      inventoryItemId: "item_beans",
      inventoryItem: { id: "item_beans", name: "بن إسبريسو", unit: "KG", branchId: "br_1" },
    },
    {
      quantity: -0.036,
      inventoryItemId: "item_beans",
      inventoryItem: { id: "item_beans", name: "بن إسبريسو", unit: "KG", branchId: "br_1" },
    },
    // Item 2: Milk (three deductions: -0.250 L, -0.250 L, -0.500 L -> +1.000 L)
    {
      quantity: -0.250,
      inventoryItemId: "item_milk",
      inventoryItem: { id: "item_milk", name: "حليب كامل الدسم", unit: "LITER", branchId: "br_1" },
    },
    {
      quantity: -0.250,
      inventoryItemId: "item_milk",
      inventoryItem: { id: "item_milk", name: "حليب كامل الدسم", unit: "LITER", branchId: "br_1" },
    },
    {
      quantity: -0.500,
      inventoryItemId: "item_milk",
      inventoryItem: { id: "item_milk", name: "حليب كامل الدسم", unit: "LITER", branchId: "br_1" },
    },
    // Positive transactions (e.g. purchases, return) must NOT be restored
    {
      quantity: 5.0,
      inventoryItemId: "item_beans",
      inventoryItem: { id: "item_beans", name: "بن إسبريسو", unit: "KG", branchId: "br_1" },
    },
    {
      quantity: 0,
      inventoryItemId: "item_cup",
      inventoryItem: { id: "item_cup", name: "أكواب ورقية", unit: "PIECE", branchId: "br_1" },
    },
  ];

  const restored = aggregateRestoredInventory(transactions);

  assert.equal(restored.length, 2);

  // Sorted by name
  const beans = restored.find((r) => r.id === "item_beans");
  const milk = restored.find((r) => r.id === "item_milk");

  assert.ok(beans);
  assert.equal(beans.name, "بن إسبريسو");
  assert.equal(beans.unit, "KG");
  assert.equal(beans.quantity, 0.054);

  assert.ok(milk);
  assert.equal(milk.name, "حليب كامل الدسم");
  assert.equal(milk.unit, "LITER");
  assert.equal(milk.quantity, 1.0);
});

test("aggregateRestoredInventory handles empty transactions and missing item metadata safely", () => {
  assert.deepEqual(aggregateRestoredInventory([]), []);

  const fallbackTxn = [
    {
      quantity: -3,
      inventoryItemId: "unknown_item_id",
      inventoryItem: null,
    },
  ];
  const res = aggregateRestoredInventory(fallbackTxn);
  assert.equal(res.length, 1);
  assert.equal(res[0].id, "unknown_item_id");
  assert.equal(res[0].name, "unknown_item_id");
  assert.equal(res[0].quantity, 3);
  assert.equal(res[0].unit, "PIECE");
});

test("buildOrderScopeWhere constructs accurate Prisma where filters and guards period mode", () => {
  // Cafe only, resetAll: true
  const whereAll = buildOrderScopeWhere({
    cafeId: "cafe_123",
    resetAll: true,
  });
  assert.deepEqual(whereAll, { cafeId: "cafe_123" });

  // Cafe + specific branch + period
  const wherePeriod = buildOrderScopeWhere({
    cafeId: "cafe_123",
    branchId: "branch_456",
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-11-08T00:00:00.000Z",
    resetAll: false,
  });
  assert.equal(wherePeriod.cafeId, "cafe_123");
  assert.equal(wherePeriod.branchId, "branch_456");
  assert.ok(wherePeriod.createdAt);

  // Branch "ALL" should not restrict branchId
  const whereBranchAll = buildOrderScopeWhere({
    cafeId: "cafe_123",
    branchId: "ALL",
    resetAll: true,
  });
  assert.equal(whereBranchAll.cafeId, "cafe_123");
  assert.equal(whereBranchAll.branchId, undefined);

  // Period mode without valid dates MUST guard against all-order wipeout
  const wherePeriodNoDates = buildOrderScopeWhere({
    cafeId: "cafe_123",
    resetAll: false,
  });
  assert.equal(wherePeriodNoDates.cafeId, "cafe_123");
  assert.equal(wherePeriodNoDates.id, "__NO_MATCH_PERIOD_WITHOUT_DATES__");
});

test("owner override passcode extraction and bcrypt verification", async () => {
  assert.equal(OWNER_OVERRIDE_HEADER, "x-owner-override-code");

  const req = new Request("https://example.com/api/sales/reset/execute", {
    method: "POST",
    headers: { "x-owner-override-code": "842915" },
  });
  assert.equal(overrideCodeFrom(req), "842915");

  const hash = await bcrypt.hash("842915", 4);
  assert.equal(await overrideCodeMatches("842915", hash), true);
  assert.equal(await overrideCodeMatches("842916", hash), false);
  assert.equal(await overrideCodeMatches("123", hash), false);
  assert.equal(await overrideCodeMatches("letters", hash), false);
});

test("effectiveBranchId normalization handles ALL vs specific branch", () => {
  const normalize = (branchId?: string, sessionBranchId?: string) =>
    branchId && branchId !== "ALL" ? branchId : (sessionBranchId ?? "");

  assert.equal(normalize("br_123", "br_999"), "br_123");
  assert.equal(normalize("ALL", "br_999"), "br_999");
  assert.equal(normalize("ALL", undefined), "");
  assert.equal(normalize(undefined, "br_999"), "br_999");
  assert.equal(normalize(undefined, undefined), "");
});

test("CAFE_OWNER authorization gate strictly blocks non-owner roles", () => {
  const isAuthorizedOwner = (role: string) => role === "CAFE_OWNER";

  assert.equal(isAuthorizedOwner("CAFE_OWNER"), true);
  assert.equal(isAuthorizedOwner("BRANCH_MANAGER"), false);
  assert.equal(isAuthorizedOwner("CASHIER"), false);
  assert.equal(isAuthorizedOwner("WAITER"), false);
  assert.equal(isAuthorizedOwner("KITCHEN"), false);
  assert.equal(isAuthorizedOwner("ACCOUNTANT"), false);
  assert.equal(isAuthorizedOwner("SUPER_ADMIN"), false);
});

test("previewSalesReset with mock client computes totals, restored quantities, and affected shifts", async () => {
  const mockOrders = [
    {
      id: "ord_1",
      total: 150.5,
      paidAmount: 150.5,
      saleShiftId: "shift_1",
      servedShiftId: "shift_1",
      branchId: "br_1",
    },
    {
      id: "ord_2",
      total: 85.0,
      paidAmount: 85.0,
      saleShiftId: "shift_1",
      servedShiftId: "shift_2",
      branchId: "br_1",
    },
  ];

  const mockDeductions = [
    {
      quantity: -0.04,
      inventoryItemId: "item_coffee",
      inventoryItem: { id: "item_coffee", name: "قهوة", unit: "KG", branchId: "br_1" },
    },
    {
      quantity: -0.4,
      inventoryItemId: "item_milk",
      inventoryItem: { id: "item_milk", name: "حليب", unit: "LITER", branchId: "br_1" },
    },
  ];

  const mockPayments = [
    { shiftId: "shift_1" },
    { shiftId: "shift_2" },
  ];

  const mockClient = {
    order: {
      findMany: async () => mockOrders,
    },
    inventoryTransaction: {
      findMany: async () => mockDeductions,
    },
    payment: {
      findMany: async () => mockPayments,
    },
  } as any;

  const preview = await previewSalesReset(
    { cafeId: "cafe_test", resetAll: true },
    mockClient
  );

  assert.equal(preview.orderCount, 2);
  assert.equal(preview.totalAmount, 235.5);
  assert.equal(preview.paidAmount, 235.5);
  assert.equal(preview.affectedShiftCount, 2);
  assert.equal(preview.itemsToRestore.length, 2);

  const coffee = preview.itemsToRestore.find((i) => i.id === "item_coffee");
  assert.ok(coffee);
  assert.equal(coffee.quantity, 0.04);
});

test("previewSalesReset returns empty structure when no orders match", async () => {
  const mockClient = {
    order: {
      findMany: async () => [],
    },
  } as any;

  const preview = await previewSalesReset(
    { cafeId: "cafe_empty", resetAll: true },
    mockClient
  );

  assert.equal(preview.orderCount, 0);
  assert.equal(preview.totalAmount, 0);
  assert.equal(preview.paidAmount, 0);
  assert.equal(preview.affectedShiftCount, 0);
  assert.deepEqual(preview.itemsToRestore, []);
  assert.deepEqual(preview.orderIds, []);
});

test("executeSalesReset executes atomic transaction: restores stock, cascades deletions in strict foreign-key order, and updates shift totals", async () => {
  const opLog: string[] = [];

  const mockOrders = [
    {
      id: "ord_101",
      total: 120.0,
      paidAmount: 120.0,
      saleShiftId: "shift_a",
      servedShiftId: "shift_a",
      branchId: "br_main",
      tableSessionId: "session_t1",
    },
  ];

  const mockDeductions = [
    {
      quantity: -0.05,
      inventoryItemId: "inv_coffee",
      inventoryItem: {
        id: "inv_coffee",
        name: "بن برازيلي",
        unit: "KG",
        branchId: "br_main",
      },
    },
  ];

  const mockPayments = [
    {
      id: "pay_1",
      shiftId: "shift_a",
      amount: 120.0,
      method: "CASH",
      type: "COLLECTION",
      status: "PAID",
    },
  ];

  const updatedInventoryItems: any[] = [];
  const createdTransactions: any[] = [];
  let deletedOwnerActionWhere: any = null;
  let shiftUpdateData: any = null;

  let currentPayments = [...mockPayments];

  const mockTx: any = {
    order: {
      findMany: async () => {
        opLog.push("order.findMany");
        return mockOrders;
      },
      updateMany: async (args: any) => {
        opLog.push("order.updateMany");
        return { count: 1 };
      },
      deleteMany: async (args: any) => {
        opLog.push("order.deleteMany");
        return { count: 1 };
      },
      count: async () => 0,
    },
    inventoryTransaction: {
      findMany: async () => {
        opLog.push("inventoryTransaction.findMany");
        return mockDeductions;
      },
      create: async (args: any) => {
        opLog.push("inventoryTransaction.create");
        createdTransactions.push(args.data);
        return { id: "txn_restore_1" };
      },
      deleteMany: async () => {
        opLog.push("inventoryTransaction.deleteMany");
        return { count: 1 };
      },
    },
    inventoryItem: {
      update: async (args: any) => {
        opLog.push("inventoryItem.update");
        updatedInventoryItems.push(args);
        return {
          id: args.where.id,
          branchId: "br_main",
          ledgerVersion: BigInt(5),
          costPerUnit: 400.0,
        };
      },
    },
    payment: {
      findMany: async () => {
        opLog.push("payment.findMany");
        return currentPayments;
      },
      updateMany: async () => {
        opLog.push("payment.updateMany");
        return { count: 0 };
      },
      deleteMany: async () => {
        opLog.push("payment.deleteMany");
        currentPayments = [];
        return { count: 1 };
      },
      count: async () => 0,
    },
    finishedGoodsReturn: {
      deleteMany: async () => {
        opLog.push("finishedGoodsReturn.deleteMany");
        return { count: 0 };
      },
    },
    orderItem: {
      findMany: async () => {
        opLog.push("orderItem.findMany");
        return [{ id: "item_line_1" }];
      },
      updateMany: async () => {
        opLog.push("orderItem.updateMany");
        return { count: 1 };
      },
      deleteMany: async () => {
        opLog.push("orderItem.deleteMany");
        return { count: 1 };
      },
    },
    deferredStockDeduction: {
      deleteMany: async () => {
        opLog.push("deferredStockDeduction.deleteMany");
        return { count: 0 };
      },
    },
    handoverCarriedOrder: {
      deleteMany: async () => {
        opLog.push("handoverCarriedOrder.deleteMany");
        return { count: 0 };
      },
    },
    loyaltyTransaction: {
      deleteMany: async () => {
        opLog.push("loyaltyTransaction.deleteMany");
        return { count: 0 };
      },
    },
    orderAmendment: {
      findMany: async () => {
        opLog.push("orderAmendment.findMany");
        return [{ id: "amend_1" }];
      },
      deleteMany: async () => {
        opLog.push("orderAmendment.deleteMany");
        return { count: 1 };
      },
    },
    amendmentSettlement: {
      deleteMany: async () => {
        opLog.push("amendmentSettlement.deleteMany");
        return { count: 0 };
      },
    },
    ownerActionRequest: {
      deleteMany: async (args: any) => {
        opLog.push("ownerActionRequest.deleteMany");
        deletedOwnerActionWhere = args.where;
        return { count: 1 };
      },
    },
    orderTrace: {
      deleteMany: async () => {
        opLog.push("orderTrace.deleteMany");
        return { count: 0 };
      },
    },
    orderRevision: {
      deleteMany: async () => {
        opLog.push("orderRevision.deleteMany");
        return { count: 0 };
      },
    },
    orderItemPayment: {
      deleteMany: async () => {
        opLog.push("orderItemPayment.deleteMany");
        return { count: 0 };
      },
    },
    orderItemAddOn: {
      deleteMany: async () => {
        opLog.push("orderItemAddOn.deleteMany");
        return { count: 0 };
      },
    },
    tableSession: {
      delete: async () => {
        opLog.push("tableSession.delete");
        return { id: "session_t1" };
      },
    },
    shift: {
      findUnique: async () => {
        opLog.push("shift.findUnique");
        return {
          id: "shift_a",
          openingCashAmount: 500,
          actualCashAmount: 500,
          cashDifference: 0,
          cashToleranceAmount: 10,
          cashWithinTolerance: true,
        };
      },
      update: async (args: any) => {
        opLog.push("shift.update");
        shiftUpdateData = args.data;
        return args;
      },
    },
    purchasePayment: {
      aggregate: async () => ({ _sum: { amount: 0 } }),
    },
    operatingExpense: {
      aggregate: async () => ({ _sum: { amount: 0 } }),
    },
    operatingExpenseReturn: {
      aggregate: async () => ({ _sum: { amount: 0 } }),
    },
    auditLog: {
      create: async () => {
        opLog.push("auditLog.create");
        return { id: "audit_1" };
      },
    },
  };

  const result = await executeSalesReset(
    {
      cafeId: "cafe_1",
      actorId: "user_owner_1",
      resetAll: true,
      reason: "تطهير بيانات التجربة قبل الإطلاق",
    },
    mockTx
  );

  assert.equal(result.success, true);
  assert.equal(result.orderCount, 1);
  assert.equal(result.restoredItemsCount, 1);

  // Verify inventory stock restoration
  assert.equal(updatedInventoryItems.length, 1);
  assert.deepEqual(updatedInventoryItems[0].data.currentStock, { increment: 0.05 });

  // Verify created ADJUSTMENT ledger transaction
  assert.equal(createdTransactions.length, 1);
  assert.equal(createdTransactions[0].type, "ADJUSTMENT");
  assert.equal(createdTransactions[0].quantity, 0.05);
  assert.equal(createdTransactions[0].unitCost, 400.0);
  assert.equal(createdTransactions[0].totalCost, 20.0); // 400 * 0.05 = 20.0

  // Verify OwnerActionRequest deletion criteria uses target fields (NOT orderId!)
  assert.ok(deletedOwnerActionWhere);
  assert.ok(deletedOwnerActionWhere.OR);
  const targetOrderCond = deletedOwnerActionWhere.OR.find((c: any) => c.targetOrderId);
  assert.ok(targetOrderCond);
  assert.deepEqual(targetOrderCond.targetOrderId, { in: ["ord_101"] });

  // Verify orderRevision.deleteMany happened BEFORE orderAmendment.deleteMany
  const revIndex = opLog.indexOf("orderRevision.deleteMany");
  const amendIndex = opLog.indexOf("orderAmendment.deleteMany");
  assert.ok(revIndex !== -1, "orderRevision.deleteMany must be called");
  assert.ok(amendIndex !== -1, "orderAmendment.deleteMany must be called");
  assert.ok(
    revIndex < amendIndex,
    `orderRevision (${revIndex}) must be deleted BEFORE orderAmendment (${amendIndex})`
  );

  // Verify Shift update recalculated expectedCash and cashDifference
  assert.ok(shiftUpdateData);
  assert.equal(shiftUpdateData.orderCount, 0);
  assert.equal(shiftUpdateData.totalSales.toFixed(2), "0.00");
  assert.equal(shiftUpdateData.expectedCashAmount.toNumber(), 500);
  assert.equal(shiftUpdateData.cashDifference.toNumber(), 0);
  assert.equal(shiftUpdateData.cashWithinTolerance, true);
});

test("executeSalesReset handles null costPerUnit by setting totalCost to null rather than 0", async () => {
  const mockOrders = [
    {
      id: "ord_102",
      total: 50.0,
      paidAmount: 50.0,
      saleShiftId: null,
      servedShiftId: null,
      branchId: "br_main",
      tableSessionId: null,
    },
  ];

  const mockDeductions = [
    {
      quantity: -1,
      inventoryItemId: "inv_nocost",
      inventoryItem: {
        id: "inv_nocost",
        name: "خامة بدون سعر",
        unit: "PIECE",
        branchId: "br_main",
      },
    },
  ];

  let createdTxnData: any = null;

  const mockTx: any = {
    order: {
      findMany: async () => mockOrders,
      updateMany: async () => ({ count: 1 }),
      deleteMany: async () => ({ count: 1 }),
      count: async () => 0,
    },
    inventoryTransaction: {
      findMany: async () => mockDeductions,
      create: async (args: any) => {
        createdTxnData = args.data;
        return { id: "txn_1" };
      },
      deleteMany: async () => ({ count: 1 }),
    },
    inventoryItem: {
      update: async (args: any) => ({
        id: args.where.id,
        branchId: "br_main",
        ledgerVersion: BigInt(2),
        costPerUnit: null, // null cost
      }),
    },
    payment: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
    },
    finishedGoodsReturn: { deleteMany: async () => ({ count: 0 }) },
    orderItem: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
    deferredStockDeduction: { deleteMany: async () => ({ count: 0 }) },
    handoverCarriedOrder: { deleteMany: async () => ({ count: 0 }) },
    loyaltyTransaction: { deleteMany: async () => ({ count: 0 }) },
    orderAmendment: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    amendmentSettlement: { deleteMany: async () => ({ count: 0 }) },
    ownerActionRequest: { deleteMany: async () => ({ count: 0 }) },
    orderTrace: { deleteMany: async () => ({ count: 0 }) },
    orderRevision: { deleteMany: async () => ({ count: 0 }) },
    orderItemPayment: { deleteMany: async () => ({ count: 0 }) },
    orderItemAddOn: { deleteMany: async () => ({ count: 0 }) },
    auditLog: { create: async () => ({ id: "audit_1" }) },
  };

  await executeSalesResetInTransaction(mockTx, {
    cafeId: "cafe_1",
    actorId: "user_owner_1",
    resetAll: true,
  });

  assert.ok(createdTxnData);
  assert.equal(createdTxnData.unitCost, null);
  assert.equal(createdTxnData.totalCost, null); // MUST BE NULL, NOT 0!
});

test("executeSalesReset returns empty success when no orders match", async () => {
  let findManyCalled = false;
  let deleteCalled = false;

  const mockTx: any = {
    order: {
      findMany: async () => {
        findManyCalled = true;
        return [];
      },
      deleteMany: async () => {
        deleteCalled = true;
        return { count: 0 };
      },
    },
  };

  const res = await executeSalesResetInTransaction(mockTx, {
    cafeId: "cafe_empty",
    actorId: "user_1",
    resetAll: true,
  });

  assert.equal(findManyCalled, true);
  assert.equal(deleteCalled, false);
  assert.equal(res.success, true);
  assert.equal(res.orderCount, 0);
  assert.equal(res.restoredItemsCount, 0);
});
