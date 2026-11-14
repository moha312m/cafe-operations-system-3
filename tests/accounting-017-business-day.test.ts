import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, sessionFor, teardownTaggedCafe } from "./helpers/db";
import { as, requireServer } from "./helpers/http";
import { countCafe, countItem } from "./helpers/count";
import { dateStrInTz } from "@/lib/date-range";
import { inventoryReconciliation, supplierPosition } from "@/lib/accounting/subledgers";
import { recordNightCash } from "@/lib/overnight-cash";
import { refundOrder } from "@/lib/refunds";
import { balanceSheet, cashFlow, postOpeningBalances } from "@/lib/accounting/statements";
import { openPeriod, trialBalance } from "@/lib/accounting/ledger";

after(() => db.$disconnect());

test("one business day reconciles supported events and flags the unapproved expense", { timeout: 180000 }, async () => {
  await requireServer();
  const fx = await countCafe("ACC017DAY");
  const day = dateStrInTz(new Date());
  const write = async <T>(email: string, path: string, body: object = {}, status = 200, method = "POST") => {
    const response = await as<T>(email, path, { method, body: JSON.stringify(body), headers: { "Idempotency-Key": randomUUID() } });
    assert.equal(response.status, status, `${path}: ${response.text}`);
    return response.body;
  };
  const owner = fx.owner.email, manager = fx.manager.email;
  try {
    await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "NO_SHIFT_COUNT" } });
    await write(owner, "/api/accounting/pnl");
    await db.$transaction(async (tx) => {
      await openPeriod(tx, { cafeId: fx.cafeId, startsOn: day, endsOn: day });
      await postOpeningBalances(tx, { cafeId: fx.cafeId, asOf: day, actorId: fx.owner.id, lines: [
        { account: { key: "CASH_DRAWER" }, branchId: fx.branchId, debit: 100 },
      ] });
    });
    const { shift } = await write<{ shift: { id: string } }>(manager, "/api/shifts", { branchId: fx.branchId, openingCashAmount: 100 }, 201);
    const item = await countItem(fx, "beans", { stock: 0 });
    const supplier = await db.supplier.create({ data: { cafeId: fx.cafeId, name: fx.marker } });
    const draft = await write<{ id: string }>(owner, "/api/purchases", {
      branchId: fx.branchId, supplierId: supplier.id, items: [{ inventoryItemId: item.id, quantity: 10, unitCost: 5 }],
    }, 201);
    await write(owner, `/api/purchases/${draft.id}/confirm`);

    const category = await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: fx.marker } });
    const product = await db.product.create({ data: { cafeId: fx.cafeId, categoryId: category.id, name: fx.marker, basePrice: 30 } });
    await db.recipe.create({ data: { cafeId: fx.cafeId, productId: product.id, items: { create: { inventoryItemId: item.id, unit: "KG", quantity: 1 } } } });
    const selling = { branchId: fx.branchId, type: "TAKEAWAY", method: "CASH", items: [{ productId: product.id, quantity: 1 }] };
    const makeSale = async () => {
      const { order } = await write<{ order: { id: string } }>(manager, "/api/orders", selling, 201);
      for (const status of ["PREPARING", "READY", "SERVED"]) {
        await write(manager, `/api/orders/${order.id}/status`, { status }, 200, "PATCH");
      }
      return order.id;
    };
    await makeSale();
    const returned = await makeSale();
    assert.equal(await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId, type: "USAGE" } }), 2);

    await db.userPermissionOverride.create({ data: { userId: fx.manager.id, permissionKey: "expenses.manage", allowed: true } });
    const { category: expenseCategory } = await write<{ category: { id: string } }>(owner, "/api/expenses/categories", {
      code: "CLEANING", nameAr: "مستلزمات النظافة", classification: "OPERATING_EXPENSE",
    }, 201);
    await write(manager, "/api/expenses", { branchId: fx.branchId, categoryId: expenseCategory.id, amount: 7, description: "مستلزمات تنظيف" }, 201);
    await write(manager, `/api/purchases/${draft.id}/payments`, { amount: 20, method: "CASH", fundingSource: "DRAWER" });
    await refundOrder(returned, await sessionFor(manager), "مرتجع عميل في اختبار التسوية");
    assert.equal(Number((await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).expectedCashAmount), 103);
    await write(manager, `/api/shifts/${shift.id}/close`, { actualCashAmount: 103 });

    // The night storage service requires the branch-custody handover link.
    const handover = await db.handoverSession.create({ data: {
      cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: shift.id, outgoingUserId: fx.manager.id, target: "BRANCH_CUSTODY",
    } });
    await db.$transaction((tx) => recordNightCash(tx, {
      cafeId: fx.cafeId, branchId: fx.branchId, shiftId: shift.id, handoverId: handover.id,
      actorId: fx.manager.id, actualCash: 103, disposition: { leftInDrawer: 53, toTreasury: 50 },
    }));

    type Projection = { posted: number; replayed: number; exceptions: { sourceType: string }[] };
    const project = () => write<Projection>(owner, "/api/accounting/projection", { from: day, to: day });
    const first = await project(), again = await project();
    assert.ok(first.posted > 0);
    assert.deepEqual(first.exceptions.map((i) => i.sourceType), ["OPERATING_EXPENSE"]);
    assert.deepEqual([again.posted, again.replayed], [0, first.posted]);
    const tb = await trialBalance({ cafeId: fx.cafeId, from: day, to: day });
    assert.equal(tb.balanced, true);
    assert.deepEqual(Object.fromEntries(tb.accounts.map((r) => [r.systemKey, r.balance])), {
      CASH_DRAWER: 60, CASH_SAFE: 50, CUSTOMER_RECEIVABLE: 0, INVENTORY: 40,
      ACCOUNTS_PAYABLE: 30, GOODS_RECEIVED_NOT_INVOICED: 0, CUSTOMER_CREDIT: 0,
      OPENING_BALANCE: 100, SALES: 60, SALES_RETURNS: 30, COST_OF_SALES: 10,
    });
    const operatingLines = await db.journalLine.findMany({ where: { cafeId: fx.cafeId, entry: { sourceType: { not: "OPENING_BALANCE" } } } });
    assert.ok(operatingLines.every((line) => line.branchId === fx.branchId));
    const inventory = await inventoryReconciliation({ cafeId: fx.cafeId, branchId: fx.branchId, asOf: day });
    assert.deepEqual([inventory.glInventory, inventory.ledgerValue, inventory.uncostedRows], [40, 40, 0]);
    assert.equal((await supplierPosition({ cafeId: fx.cafeId, asOf: day })).payable, 30);
    const pnl = await as<{ kpis: { netProfit: number; operatingExpenses: number } }>(owner, `/api/accounting/pnl?from=${day}&to=${day}`);
    assert.equal(pnl.status, 200, pnl.text);
    assert.deepEqual([pnl.body.kpis.netProfit, pnl.body.kpis.operatingExpenses], [20, 0]);
    assert.equal((await balanceSheet({ cafeId: fx.cafeId, asOf: day })).balanced, true);
    const cash = await cashFlow({ cafeId: fx.cafeId, from: day, to: day });
    assert.deepEqual([cash.opening, cash.closing, cash.netChange, cash.balanced], [100, 110, 10, true]);
  } finally {
    await teardownTaggedCafe(fx.cafeId);
  }
});
