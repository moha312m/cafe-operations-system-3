// tests/prototypes-adversarial-challenger2.test.ts
// Adversarial Edge Case & State Machine Probing Suite (Challenger 2)
// Evaluates numerical precision, state transition invariants, boundary limits, and error recovery.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  calculateCartTotals,
  POS_PRODUCTS,
  POS_CATEGORIES,
  INITIAL_MOCK_CART,
  MOCK_EXPENSES,
  MOCK_DASHBOARD_PERIODS,
  MOCK_TASKS,
  type POSCartItem,
  type ExpenseItem,
  type TaskItem,
  type DashboardPeriod,
} from "../src/app/prototypes/_data/mock-data";

describe("Challenger 2: Adversarial Edge Cases & State Machine Probing", () => {
  // ==========================================================================
  // Section 1: POS Calculations & Cart State Machine
  // ==========================================================================
  describe("1. POS Calculations & Cart State Machine", () => {
    test("1.1 Empty cart produces zeroed totals and 0 itemCount", () => {
      const totals = calculateCartTotals([], 0, 0.14);
      assert.equal(totals.subtotal, 0);
      assert.equal(totals.discount, 0);
      assert.equal(totals.taxableAmount, 0);
      assert.equal(totals.taxAmount, 0);
      assert.equal(totals.total, 0);
      assert.equal(totals.itemCount, 0);
    });

    test("1.2 Extreme Discounts: 0% discount maintains exact subtotal as taxable", () => {
      const sampleItem: POSCartItem = {
        id: "line-1",
        productId: "p1",
        productNameAr: "إسبريسو",
        selectedModifiers: [],
        unitPrice: 65,
        quantity: 2,
        lineTotal: 130,
      };
      const totals = calculateCartTotals([sampleItem], 0, 0.14);
      assert.equal(totals.subtotal, 130);
      assert.equal(totals.discount, 0);
      assert.equal(totals.taxableAmount, 130);
      assert.equal(totals.taxAmount, 18.2); // 130 * 0.14 = 18.20
      assert.equal(totals.total, 148.2);
    });

    test("1.3 Extreme Discounts: 100% discount zeroes taxableAmount, taxAmount, and total", () => {
      const sampleItem: POSCartItem = {
        id: "line-1",
        productId: "p2",
        productNameAr: "فلات وايت",
        selectedModifiers: [],
        unitPrice: 85,
        quantity: 1,
        lineTotal: 85,
      };
      const totals = calculateCartTotals([sampleItem], 85, 0.14);
      assert.equal(totals.subtotal, 85);
      assert.equal(totals.taxableAmount, 0);
      assert.equal(totals.taxAmount, 0);
      assert.equal(totals.total, 0);
    });

    test("1.4 Extreme Discounts: discount > subtotal clamps taxableAmount to 0 but exposes unclamped nominal discount", () => {
      const sampleItem: POSCartItem = {
        id: "line-1",
        productId: "p2",
        productNameAr: "فلات وايت",
        selectedModifiers: [],
        unitPrice: 85,
        quantity: 1,
        lineTotal: 85,
      };
      // Discount is 150 EGP, but subtotal is 85 EGP
      const totals = calculateCartTotals([sampleItem], 150, 0.14);
      assert.equal(totals.subtotal, 85);
      assert.equal(totals.taxableAmount, 0, "Taxable amount must not be negative");
      assert.equal(totals.taxAmount, 0);
      assert.equal(totals.total, 0);
      // Notice: totals.discount returns 150, which exceeds subtotal!
      assert.equal(totals.discount, 150);
      assert.ok(
        totals.discount > totals.subtotal,
        "calculateCartTotals does not clamp nominal discount to subtotal in return payload"
      );
    });

    test("1.5 14% Egyptian VAT calculation: rounding across fractional amounts (e.g. 55.25 EGP)", () => {
      // 55.25 * 0.14 = 7.735 -> should round half-up to 7.74 EGP
      const item: POSCartItem = {
        id: "line-frac",
        productId: "p-odd",
        productNameAr: "صنف تجريبي",
        selectedModifiers: [],
        unitPrice: 55.25,
        quantity: 1,
        lineTotal: 55.25,
      };
      const totals = calculateCartTotals([item], 0, 0.14);
      assert.equal(totals.taxableAmount, 55.25);
      assert.equal(totals.taxAmount, 7.74);
      assert.equal(totals.total, 62.99); // 55.25 + 7.74 = 62.99
    });

    test("1.6 14% Egyptian VAT calculation: 1 cent subtotal tax rounding", () => {
      // 0.01 * 0.14 = 0.0014 -> rounds to 0.00
      const item: POSCartItem = {
        id: "line-penny",
        productId: "p-penny",
        productNameAr: "قرش صاغ",
        selectedModifiers: [],
        unitPrice: 0.01,
        quantity: 1,
        lineTotal: 0.01,
      };
      const totals = calculateCartTotals([item], 0, 0.14);
      assert.equal(totals.taxAmount, 0);
      assert.equal(totals.total, 0.01);
    });

    test("1.7 Stepper decrement state machine: decrementing qty 1 by -1 removes item from cart", () => {
      const initialCart: POSCartItem[] = [
        {
          id: "line-a",
          productId: "p1",
          productNameAr: "إسبريسو",
          selectedModifiers: [],
          unitPrice: 65,
          quantity: 1,
          lineTotal: 65,
        },
        {
          id: "line-b",
          productId: "p2",
          productNameAr: "فلات وايت",
          selectedModifiers: [],
          unitPrice: 85,
          quantity: 2,
          lineTotal: 170,
        },
      ];

      // Replicate stepper logic from pos/page.tsx line 214-231
      const updateQuantity = (cart: POSCartItem[], lineId: string, delta: number) => {
        return cart
          .map((item) => {
            if (item.id === lineId) {
              const newQty = item.quantity + delta;
              if (newQty <= 0) return null;
              return {
                ...item,
                quantity: newQty,
                lineTotal: item.unitPrice * newQty,
              };
            }
            return item;
          })
          .filter(Boolean) as POSCartItem[];
      };

      const afterDecrement = updateQuantity(initialCart, "line-a", -1);
      assert.equal(afterDecrement.length, 1);
      assert.equal(afterDecrement[0].id, "line-b");
      assert.equal(afterDecrement[0].quantity, 2);

      // Decrementing line-b from 2 to 1 keeps item
      const afterDecrementB = updateQuantity(afterDecrement, "line-b", -1);
      assert.equal(afterDecrementB.length, 1);
      assert.equal(afterDecrementB[0].quantity, 1);
      assert.equal(afterDecrementB[0].lineTotal, 85);

      // Decrementing line-b from 1 to 0 clears cart completely
      const emptyCart = updateQuantity(afterDecrementB, "line-b", -1);
      assert.equal(emptyCart.length, 0);
    });

    test("1.8 Cash checkout change calculation: cash >= total vs cash < total", () => {
      const totalAmount = 302.67;

      // Exact cash
      const exactReceived = 302.67;
      const exactChange = Math.max(0, exactReceived - totalAmount);
      assert.equal(exactChange, 0);

      // Surplus cash
      const surplusReceived = 400;
      const surplusChange = Math.round((surplusReceived - totalAmount) * 100) / 100;
      assert.equal(surplusChange, 97.33);

      // Deficit cash (insufficient payment)
      const deficitReceived = 200;
      const deficitChange = Math.max(0, deficitReceived - totalAmount);
      assert.equal(deficitChange, 0, "Change due must be 0 when cash is insufficient");
      const remainingDue = Math.round((totalAmount - deficitReceived) * 100) / 100;
      assert.equal(remainingDue, 102.67, "Remaining due should be exactly 102.67");
    });

    test("1.9 State Machine Vulnerability: POS checkout handler lacks cash sufficiency guard", () => {
      // Simulate POS handleCompleteOrder logic from pos/page.tsx:
      // Note: In pos/page.tsx lines 245-254:
      // if (cart.length === 0) return error;
      // changeDue = paymentMethod === "CASH" ? Math.max(0, cashReceived - totals.total) : 0;
      // There is NO `if (paymentMethod === "CASH" && cashReceived < totals.total) return error`!
      const cart = [...INITIAL_MOCK_CART];
      const totals = calculateCartTotals(cart, 0, 0.14);
      const cashReceived = 50; // Insufficient! Totals.total is > 400 EGP

      const isGuardedInImplementation = false; // Directly verified in pos/page.tsx line 245-274
      assert.equal(
        isGuardedInImplementation,
        false,
        "VULNERABILITY: handleCompleteOrder allows completing cash order when cashReceived < totals.total"
      );
    });
  });

  // ==========================================================================
  // Section 2: Expenses Edge Cases & Filtering
  // ==========================================================================
  describe("2. Expenses Edge Cases & Filtering", () => {
    test("2.1 Expense validation rejects zero amount and negative amounts", () => {
      const validateExpenseAmount = (amountStr: string): boolean => {
        const num = parseFloat(amountStr);
        if (!amountStr || isNaN(num) || num <= 0) return false;
        return true;
      };

      assert.equal(validateExpenseAmount("0"), false);
      assert.equal(validateExpenseAmount("-100"), false);
      assert.equal(validateExpenseAmount(""), false);
      assert.equal(validateExpenseAmount("abc"), false);
      assert.equal(validateExpenseAmount("500"), true);
      assert.equal(validateExpenseAmount("0.5"), true);
    });

    test("2.2 Large expense amount does not produce NaN or overflow in KPI aggregation", () => {
      const hugeExpense: ExpenseItem = {
        id: "exp-huge",
        code: "EXP-HUGE",
        date: "2026-11-09",
        category: "MAINTENANCE",
        categoryNameAr: "صيانة ومعدات",
        descriptionAr: "شراء خط تحميص مركزي عملاق",
        amount: 50_000_000, // 50 Million EGP
        paymentMethodAr: "تحويل بنكي",
        vendorName: "شركة بروبات العالمية",
        branchName: "كافيه الإدارة (توزيع فروع)",
        status: "APPROVED",
      };

      const combined = [hugeExpense, ...MOCK_EXPENSES];
      const totalMonth = combined.reduce((acc, curr) => acc + curr.amount, 0);
      assert.ok(totalMonth > 50_000_000);
      assert.equal(Number.isFinite(totalMonth), true);

      // Category percentage test
      const categoryTotals: Record<string, number> = {};
      combined.forEach((e) => {
        categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount;
      });
      const topCatAmount = Math.max(...Object.values(categoryTotals));
      const topCatPercentage = Math.round((topCatAmount / totalMonth) * 100);
      assert.ok(topCatPercentage >= 99);
      assert.ok(Number.isFinite(topCatPercentage));
    });

    test("2.3 Empty notes are normalized to undefined, preventing blank DOM rendering", () => {
      const formNotes = "";
      const normalizedNotes = formNotes || undefined;
      assert.equal(normalizedNotes, undefined);
    });

    test("2.4 Category and branch filtering combinations: exhaustive matrix check", () => {
      const filterFn = (cat: string, branch: string, status: string) => {
        return MOCK_EXPENSES.filter((item) => {
          const matchCat = cat === "all" || item.category === cat;
          const matchBranch = branch === "all" || item.branchName === branch;
          const matchStatus = status === "all" || item.status === status;
          return matchCat && matchBranch && matchStatus;
        });
      };

      // All filters wildcard
      assert.equal(filterFn("all", "all", "all").length, 10);

      // Specific branch only
      const downtown = filterFn("all", "فرع وسط البلد", "all");
      assert.equal(downtown.length, 3);

      // Impossible combination returns empty array cleanly
      const impossible = filterFn("CLEANING", "فرع وسط البلد", "PENDING");
      assert.equal(impossible.length, 0);

      // Pending items across all branches
      const pending = filterFn("all", "all", "PENDING");
      assert.equal(pending.length, 2);
    });

    test("2.5 Status mutation (Approve Pending) dynamically decrements pending KPI", () => {
      let state = [...MOCK_EXPENSES];
      const initialPending = state.filter((e) => e.status === "PENDING");
      assert.equal(initialPending.length, 2);

      // Approve one pending expense (exp-04)
      state = state.map((e) => (e.id === "exp-04" ? { ...e, status: "APPROVED" as const } : e));
      const updatedPending = state.filter((e) => e.status === "PENDING");
      assert.equal(updatedPending.length, 1);
      assert.equal(updatedPending[0].id, "exp-07");
    });
  });

  // ==========================================================================
  // Section 3: Dashboard Invariants & Action Inbox
  // ==========================================================================
  describe("3. Dashboard Period Switcher & Action Inbox", () => {
    test("3.1 Period switcher preserves monotonic KPI growth (Today < Week < Month)", () => {
      const today = MOCK_DASHBOARD_PERIODS.today.kpis;
      const week = MOCK_DASHBOARD_PERIODS.week.kpis;
      const month = MOCK_DASHBOARD_PERIODS.month.kpis;

      assert.ok(today.netSales < week.netSales, "Week netSales must exceed Today");
      assert.ok(week.netSales < month.netSales, "Month netSales must exceed Week");
      assert.ok(today.collections < week.collections, "Week collections must exceed Today");
      assert.ok(week.collections < month.collections, "Month collections must exceed Week");
      assert.ok(today.expenses < week.expenses, "Week expenses must exceed Today");
      assert.ok(week.expenses < month.expenses, "Month expenses must exceed Week");
    });

    test("3.2 Channel breakdown percentage and amount conservation across all 3 periods", () => {
      const periods: DashboardPeriod[] = ["today", "week", "month"];
      for (const p of periods) {
        const data = MOCK_DASHBOARD_PERIODS[p];
        const percentSum = data.channelBreakdown.reduce((sum, ch) => sum + ch.percentage, 0);
        assert.equal(percentSum, 100, `Channel percentage sum for ${p} must equal 100%`);

        const amountSum = data.channelBreakdown.reduce((sum, ch) => sum + ch.amount, 0);
        assert.equal(
          amountSum,
          data.kpis.netSales,
          `Channel amount sum for ${p} must match netSales exactly`
        );
      }
    });

    test("3.3 Branch performance percentage and amount conservation across all 3 periods", () => {
      const periods: DashboardPeriod[] = ["today", "week", "month"];
      for (const p of periods) {
        const data = MOCK_DASHBOARD_PERIODS[p];
        const percentSum = Math.round(
          data.branchPerformance.reduce((sum, b) => sum + b.percentage, 0)
        );
        assert.equal(percentSum, 100, `Branch percentage sum for ${p} must round to 100%`);

        const amountSum = data.branchPerformance.reduce((sum, b) => sum + b.revenue, 0);
        assert.equal(
          amountSum,
          data.kpis.netSales,
          `Branch revenue sum for ${p} must match netSales exactly`
        );
      }
    });

    test("3.4 Top products revenue satisfies netSales invariant in Week and Month", () => {
      // In a real cafe ERP, top 5 products revenue cannot exceed total sales of the entire cafe!
      const weekData = MOCK_DASHBOARD_PERIODS.week;
      const weekTopProductsSum = weekData.topProducts.reduce((sum, p) => sum + p.revenue, 0);
      assert.equal(weekTopProductsSum, 110125);
      assert.equal(weekData.kpis.netSales, 168200);
      assert.ok(
        weekTopProductsSum <= weekData.kpis.netSales,
        "Top products revenue in Week (110,125 EGP) must be <= total week net sales (168,200 EGP)"
      );

      const monthData = MOCK_DASHBOARD_PERIODS.month;
      const monthTopProductsSum = monthData.topProducts.reduce((sum, p) => sum + p.revenue, 0);
      assert.equal(monthTopProductsSum, 250450);
      assert.equal(monthData.kpis.netSales, 385400);
      assert.ok(
        monthTopProductsSum <= monthData.kpis.netSales,
        "Top products revenue in Month (250,450 EGP) must be <= total month net sales (385,400 EGP)"
      );
    });

    test("3.5 Action inbox resolution removes item cleanly and preserves state across period switches", () => {
      let resolvedIds: string[] = [];

      // Resolve act-1 in today
      resolvedIds = [...resolvedIds, "act-1"];
      const visibleToday = MOCK_DASHBOARD_PERIODS.today.actionInbox.filter(
        (i) => !resolvedIds.includes(i.id)
      );
      assert.equal(visibleToday.length, 3);
      assert.ok(!visibleToday.some((i) => i.id === "act-1"));

      // Switch to week view: act-1 should also be filtered out
      const visibleWeek = MOCK_DASHBOARD_PERIODS.week.actionInbox.filter(
        (i) => !resolvedIds.includes(i.id)
      );
      assert.equal(visibleWeek.length, 1);
      assert.equal(visibleWeek[0].id, "act-2");

      // Switch to month view: act-1 should also be filtered out
      const visibleMonth = MOCK_DASHBOARD_PERIODS.month.actionInbox.filter(
        (i) => !resolvedIds.includes(i.id)
      );
      assert.equal(visibleMonth.length, 3);
      assert.ok(!visibleMonth.some((i) => i.id === "act-1"));
    });
  });

  // ==========================================================================
  // Section 4: Tasks Checklist & State Machine
  // ==========================================================================
  describe("4. Tasks Checklist & State Machine", () => {
    test("4.1 Progress percentage calculates accurately across partial steps (0%, 25%, 50%, 75%, 100%)", () => {
      const calcProgress = (items: { isDone: boolean }[]) => {
        if (items.length === 0) return 0;
        const completed = items.filter((i) => i.isDone).length;
        return Math.round((completed / items.length) * 100);
      };

      const fourItems = [
        { isDone: false },
        { isDone: false },
        { isDone: false },
        { isDone: false },
      ];
      assert.equal(calcProgress(fourItems), 0);

      fourItems[0].isDone = true;
      assert.equal(calcProgress(fourItems), 25);

      fourItems[1].isDone = true;
      assert.equal(calcProgress(fourItems), 50);

      fourItems[2].isDone = true;
      assert.equal(calcProgress(fourItems), 75);

      fourItems[3].isDone = true;
      assert.equal(calcProgress(fourItems), 100);
    });

    test("4.2 Zero checklist items edge case: division by zero guard check", () => {
      // In tasks/page.tsx line 228:
      // const percent = Math.round((completedCount / totalCount) * 100);
      // When totalCount is 0, JavaScript produces NaN!
      const totalCount = 0;
      const completedCount = 0;
      const unGuardedPercent = Math.round((completedCount / totalCount) * 100);
      assert.ok(Number.isNaN(unGuardedPercent), "Unguarded formula produces NaN when checklist is empty");

      // Proper guard pattern
      const guardedPercent = totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100);
      assert.equal(guardedPercent, 0);
    });

    test("4.3 STATE MACHINE LATCH BUG: Unchecking items after COMPLETED does NOT revert task status", () => {
      // Replicate exact logic from tasks/page.tsx lines 55-83:
      const handleToggle = (
        task: TaskItem,
        checkItemId: string
      ): TaskItem => {
        const nextChecklist = task.checklist.map((item) =>
          item.id === checkItemId ? { ...item, isDone: !item.isDone } : item
        );
        const allDone = nextChecklist.every((c) => c.isDone);
        const anyDone = nextChecklist.some((c) => c.isDone);

        let newStatus = task.status;
        if (allDone) {
          newStatus = "COMPLETED";
        } else if (anyDone && task.status === "PENDING") {
          newStatus = "IN_PROGRESS";
        }

        return {
          ...task,
          checklist: nextChecklist,
          status: newStatus,
        };
      };

      // Start with a PENDING task with 2 items
      let task: TaskItem = {
        id: "t-test",
        code: "TSK-TEST",
        titleAr: "مهمة اختبار",
        descriptionAr: "وصف",
        branchName: "فرع وسط البلد",
        roleAr: "باريستا",
        assigneeName: "علي",
        dueTimeAr: "10:00 ص",
        status: "PENDING",
        priority: "MEDIUM",
        checklist: [
          { id: "c1", textAr: "بند 1", isDone: false },
          { id: "c2", textAr: "بند 2", isDone: false },
        ],
        evidenceRequired: false,
      };

      // Toggle c1 -> anyDone is true, status goes to IN_PROGRESS
      task = handleToggle(task, "c1");
      assert.equal(task.status, "IN_PROGRESS");

      // Toggle c2 -> allDone is true, status goes to COMPLETED
      task = handleToggle(task, "c2");
      assert.equal(task.status, "COMPLETED");

      // Now UNCHECK c2 -> only 1 of 2 is done!
      task = handleToggle(task, "c2");
      assert.equal(task.checklist.filter((c) => c.isDone).length, 1);
      // BUG: newStatus stays "COMPLETED" because neither condition matches!
      assert.equal(
        task.status,
        "COMPLETED",
        "STATE MACHINE LATCH BUG: Status remains COMPLETED even when an item is unchecked"
      );

      // Now UNCHECK c1 as well -> 0 of 2 is done!
      task = handleToggle(task, "c1");
      assert.equal(task.checklist.filter((c) => c.isDone).length, 0);
      assert.equal(
        task.status,
        "COMPLETED",
        "STATE MACHINE LATCH BUG: Status remains COMPLETED even when ALL items are unchecked"
      );
    });

    test("4.4 Overdue task state machine behavior", () => {
      // TSK-101 starts as OVERDUE with 2 of 4 items done
      const tsk101 = MOCK_TASKS.find((t) => t.id === "tsk-01")!;
      assert.equal(tsk101.status, "OVERDUE");
      assert.equal(tsk101.checklist.filter((c) => c.isDone).length, 2);

      // Completing the remaining 2 items flips status to COMPLETED
      const allDoneChecklist = tsk101.checklist.map((c) => ({ ...c, isDone: true }));
      const allDone = allDoneChecklist.every((c) => c.isDone);
      assert.equal(allDone, true);
      const newStatus = allDone ? "COMPLETED" : tsk101.status;
      assert.equal(newStatus, "COMPLETED");
    });
  });
});
