// HANDOVER-016 — carrying open orders across a handover close.
//
// A handover close used to be refused while ANY order in the branch was still
// open, and the refusal reached the closer as a bare "things are still open":
// the server named every blocker, but as objects the client threw away.
//
// This suite pins three things:
//   1. The refusal now names the obstacle in Arabic, with the order numbers.
//   2. An owner may switch on `carryOpenOrdersOnHandover`. The close then
//      passes open orders to the incoming shift instead of refusing — and
//      orders already being made (PREPARING / READY) have their recipe
//      deducted against the OUTGOING custody BEFORE the freeze, so the count
//      is not short by drinks already poured and serving them later does not
//      deduct a second time.
//   3. Everything else a close is refused for still refuses it.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { db, teardownTaggedCafe, purgeOrderTracesFor } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

type CashCloseLib = typeof import("@/lib/cash-close");
const cashCloseLib = (): Promise<CashCloseLib> => import("@/lib/cash-close");
type CustodyLib = typeof import("@/lib/custody");
const custodyLib = (): Promise<CustodyLib> => import("@/lib/custody");

let fx: CountCafe;
let categoryId: string;

const GRANTS = { handoverSubmit: true, handoverException: true };

async function setCarry(on: boolean) {
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { carryOpenOrdersOnHandover: on } });
}

async function resetBranch() {
  await db.handoverCarriedOrder.deleteMany({ where: { cafeId: fx.cafeId } });
  await db.inventoryFreeze.deleteMany({ where: { branchId: fx.branchId } });
  await db.handoverSession.deleteMany({ where: { branchId: fx.branchId } });
  await db.stockCountSession.deleteMany({ where: { branchId: fx.branchId } });
  await db.inventoryTransaction.deleteMany({ where: { branchId: fx.branchId } });
  await purgeOrderTracesFor({ branchId: fx.branchId }); await db.order.deleteMany({ where: { branchId: fx.branchId } });
  await db.shift.updateMany({ where: { branchId: fx.branchId }, data: { cashVarianceCaseId: null } });
  await db.varianceCase.deleteMany({ where: { branchId: fx.branchId } });
  await db.tenderReconciliation.deleteMany({ where: { branchId: fx.branchId } });
  await db.shiftCustody.deleteMany({ where: { shift: { branchId: fx.branchId } } });
  await db.custodyParticipant.deleteMany({ where: { custodyPeriod: { branchId: fx.branchId } } });
  await db.custodyPeriod.updateMany({ where: { branchId: fx.branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId: fx.branchId } });
  await db.payment.deleteMany({ where: { shift: { branchId: fx.branchId } } });
  await db.shift.deleteMany({ where: { branchId: fx.branchId } });
  await db.auditLog.deleteMany({ where: { cafeId: fx.cafeId } });
}

async function openOperationalShift(userId: string, openingCash = 100) {
  const last = await db.shift.aggregate({ where: { branchId: fx.branchId }, _max: { shiftNumber: true } });
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId,
      shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: openingCash, expectedCashAmount: openingCash,
    },
  });
  const { ensureCustodyForShift } = await custodyLib();
  await db.$transaction((tx) => ensureCustodyForShift(tx, {
    cafeId: fx.cafeId, branchId: fx.branchId, shiftId: shift.id, userId, openingCashAmount: openingCash,
  }));
  return shift;
}

let seq = 0;
async function drinkWithRecipe(stock: number, perCup: string) {
  seq += 1;
  const item = await countItem(fx, `beans-${seq}`, { stock, costPerUnit: 100 });
  const product = await db.product.create({
    data: { cafeId: fx.cafeId, categoryId, name: `${fx.marker} latte-${seq}`, basePrice: "50.00" },
  });
  await db.recipe.create({
    data: {
      cafeId: fx.cafeId, productId: product.id,
      items: { create: [{ inventoryItemId: item.id, quantity: perCup, unit: "KG" }] },
    },
  });
  return { item, product };
}

async function openOrder(status: "PENDING_WAITER_APPROVAL" | "CONFIRMED" | "PREPARING" | "READY", productId?: string, productName = "latte") {
  const last = await db.order.aggregate({ where: { branchId: fx.branchId }, _max: { orderNumber: true } });
  return db.order.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      orderNumber: (last._max.orderNumber ?? 0) + 1,
      type: "DINE_IN", status, source: "CASHIER_POS",
      customerName: fx.marker,
      subtotal: 50, total: 50, remainingAmount: 50, paymentStatus: "UNPAID",
      createdById: fx.cashier.id,
      ...(productId
        ? { items: { create: [{ productId, productName, unitPrice: 50, quantity: 1, lineTotal: 50 }] } }
        : {}),
    },
  });
}

async function close(shiftId: string, actorId: string) {
  const { closeShiftWithSettlement } = await cashCloseLib();
  return closeShiftWithSettlement({
    shiftId, actualCash: 100, actorId, closedByManager: false,
    handoverTarget: "SHIFT_TO_SHIFT", grants: GRANTS,
  });
}

const stockOf = async (id: string) =>
  Number((await db.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock);

before(async () => {
  await requireServer();
  fx = await countCafe("HANDOVER016");
  categoryId = (await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: `${fx.marker} drinks` } })).id;
  // A handover-requiring policy, so every close below goes through the blockers.
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY" },
  });
  await countItem(fx, "critical", { stock: 10, isCritical: true });
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

beforeEach(async () => {
  await resetBranch();
  await setCarry(false);
});

describe("HANDOVER-016 — open orders at a handover close", () => {
  test("default (off): the close is refused and the refusal names the orders in Arabic", async () => {
    const shift = await openOperationalShift(fx.cashier.id);
    const ready = await openOrder("READY");
    const pending = await openOrder("PENDING_WAITER_APPROVAL");

    await assert.rejects(close(shift.id, fx.cashier.id), (error: unknown) => {
      const e = error as { status?: number; blockers?: Array<{ code: string; messageAr?: string; refs?: string[] }> };
      assert.equal(e.status, 409);
      const unserved = e.blockers?.find((b) => b.code === "UNSERVED_ORDERS");
      const approval = e.blockers?.find((b) => b.code === "PENDING_APPROVAL_ORDERS");
      assert.ok(unserved?.messageAr && /أوردرات/.test(unserved.messageAr));
      assert.deepEqual(unserved?.refs, [`#${ready.orderNumber}`]);
      assert.deepEqual(approval?.refs, [`#${pending.orderNumber}`]);
      return true;
    });
    const after_ = await db.shift.findUniqueOrThrow({ where: { id: shift.id } });
    assert.equal(after_.status, "OPEN");
    assert.equal(await db.handoverCarriedOrder.count({ where: { cafeId: fx.cafeId } }), 0);
  });

  test("on: open orders pass to the incoming shift; only orders being made are deducted, against the outgoing custody", async () => {
    await setCarry(true);
    const shift = await openOperationalShift(fx.cashier.id);
    const stockCustody = await db.custodyPeriod.findFirstOrThrow({
      where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" },
    });

    const a = await drinkWithRecipe(5, "0.200");
    const b = await drinkWithRecipe(5, "0.300");
    const c = await drinkWithRecipe(5, "0.400");
    const ready = await openOrder("READY", a.product.id);
    const preparing = await openOrder("PREPARING", b.product.id);
    const confirmed = await openOrder("CONFIRMED", c.product.id);
    const pending = await openOrder("PENDING_WAITER_APPROVAL");

    const result = await close(shift.id, fx.cashier.id);
    assert.equal(result.status, "AWAITING_HANDOVER");
    assert.ok(result.handoverId && result.freezeId);
    assert.deepEqual(
      result.carriedOrders.map((o) => [o.orderNumber, o.stockDeductedAtHandover]),
      [
        [ready.orderNumber, true],
        [preparing.orderNumber, true],
        [confirmed.orderNumber, false],
        [pending.orderNumber, false],
      ],
    );

    // Made drinks left the shelf on the outgoing shift's watch; the unstarted
    // one did not.
    assert.equal(await stockOf(a.item.id), 4.8);
    assert.equal(await stockOf(b.item.id), 4.7);
    assert.equal(await stockOf(c.item.id), 5);

    const usage = await db.inventoryTransaction.findMany({
      where: { branchId: fx.branchId, type: "USAGE" },
      orderBy: { orderId: "asc" },
    });
    assert.equal(usage.length, 2);
    for (const row of usage) {
      assert.equal(row.custodyPeriodId, stockCustody.id, "attributed to the custody being handed over");
      assert.equal(row.shiftId, stockCustody.responsibleShiftId);
    }
    const readyRow = await db.order.findUniqueOrThrow({ where: { id: ready.id } });
    const confirmedRow = await db.order.findUniqueOrThrow({ where: { id: confirmed.id } });
    assert.ok(readyRow.stockDeductedAt, "the double-deduction guard is set");
    assert.equal(readyRow.status, "READY", "carrying never changes the order's own status");
    assert.equal(confirmedRow.stockDeductedAt, null);

    const carried = await db.handoverCarriedOrder.findMany({
      where: { shiftId: shift.id }, orderBy: { orderNumber: "asc" },
    });
    assert.equal(carried.length, 4);
    for (const row of carried) {
      assert.equal(row.handoverId, result.handoverId);
      assert.equal(row.paymentStatusAtHandover, "UNPAID");
      assert.equal(Number(row.remainingAtHandover), 50);
    }

    const audit = await db.auditLog.findFirstOrThrow({
      where: { cafeId: fx.cafeId, action: "HANDOVER_ORDERS_CARRIED", entityId: shift.id },
    });
    const details = audit.details as { unpaidTotal: number; orders: Array<{ orderNumber: number; deducted: unknown[] }> };
    assert.equal(details.unpaidTotal, 200);
    assert.equal(details.orders.length, 4);
    assert.equal(details.orders.find((o) => o.orderNumber === ready.orderNumber)?.deducted.length, 1);
  });

  test("on: every other blocker still refuses the close", async () => {
    await setCarry(true);
    const other = await openOperationalShift(fx.manager.id);
    await db.handoverSession.create({
      data: { cafeId: fx.cafeId, branchId: fx.branchId, outgoingShiftId: other.id, outgoingUserId: fx.manager.id, status: "DRAFT" },
    });
    const shift = await openOperationalShift(fx.cashier.id);
    await openOrder("READY");

    await assert.rejects(close(shift.id, fx.cashier.id), (error: unknown) => {
      const e = error as { status?: number; blockers?: Array<{ code: string }> };
      assert.equal(e.status, 409);
      assert.deepEqual(e.blockers?.map((b) => b.code), ["EXISTING_ACTIVE_HANDOVER"],
        "the waived order blockers are not reported, the real one is");
      return true;
    });
    assert.equal(await db.handoverCarriedOrder.count({ where: { cafeId: fx.cafeId } }), 0);
  });

  test("on: a missing branch recipe ingredient remains an explanatory 409", async () => {
    await setCarry(true);
    const shift = await openOperationalShift(fx.cashier.id);
    const d = await drinkWithRecipe(5, "0.250");
    const ready = await openOrder("READY", d.product.id);
    await db.inventoryItem.update({ where: { id: d.item.id }, data: { branchId: fx.otherBranchId } });
    await assert.rejects(close(shift.id, fx.cashier.id), (error: unknown) => {
      const e = error as { status?: number; message?: string };
      assert.equal(e.status, 409); assert.match(e.message ?? "", new RegExp(`#${ready.orderNumber}`)); return true;
    });
    assert.equal((await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).status, "OPEN");
    assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), 0);
  });

  test("on: a STRICT shortage on a made order refuses the whole close and names the order", async () => {
    await setCarry(true);
    const shift = await openOperationalShift(fx.cashier.id);
    const d = await drinkWithRecipe(0.1, "0.250");
    const ready = await openOrder("READY", d.product.id);

    await assert.rejects(close(shift.id, fx.cashier.id), (error: unknown) => {
      const e = error as { status?: number; message?: string };
      assert.equal(e.status, 409);
      assert.match(e.message ?? "", new RegExp(`#${ready.orderNumber}`));
      return true;
    });
    assert.equal((await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).status, "OPEN");
    assert.equal(await stockOf(d.item.id), 0.1, "nothing moved");
    assert.equal(await db.inventoryTransaction.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal(await db.handoverSession.count({ where: { branchId: fx.branchId } }), 0);
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: ready.id } })).stockDeductedAt, null);
  });

  test("serving a carried, already-deducted order marks it SERVED and moves no stock again", async () => {
    await setCarry(true);
    const shift = await openOperationalShift(fx.cashier.id);
    const e = await drinkWithRecipe(5, "0.200");
    const ready = await openOrder("READY", e.product.id);
    await close(shift.id, fx.cashier.id);
    const deductedAt = (await db.order.findUniqueOrThrow({ where: { id: ready.id } })).stockDeductedAt;
    assert.equal(await stockOf(e.item.id), 4.8);

    const served = await as<{ order?: { status: string }; error?: string }>(
      fx.owner.email, `/api/orders/${ready.id}/status`,
      { method: "PATCH", body: JSON.stringify({ status: "SERVED" }) },
    );
    assert.equal(served.status, 200, served.text);
    assert.equal(served.body.order?.status, "SERVED");

    const row = await db.order.findUniqueOrThrow({ where: { id: ready.id } });
    assert.equal(row.stockDeductedAt?.getTime(), deductedAt?.getTime(), "the handover deduction stays the record");
    assert.ok(row.servedById && row.servedStockCustodyPeriodId);
    assert.equal(await stockOf(e.item.id), 4.8, "exactly one deduction");
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: ready.id } }), 1);
  });

  test("a carried CONFIRMED order can be served before acceptance; its stock waits for the freeze to lift", async () => {
    await setCarry(true);
    const shift = await openOperationalShift(fx.cashier.id);
    const e = await drinkWithRecipe(5, "0.200");
    const confirmed = await openOrder("CONFIRMED", e.product.id);
    const result = await close(shift.id, fx.cashier.id);
    assert.equal(result.status, "AWAITING_HANDOVER");

    for (const next of ["PREPARING", "READY", "SERVED"]) {
      const r = await as<{ order?: { status: string }; stockDeferred?: boolean; error?: string }>(
        fx.owner.email, `/api/orders/${confirmed.id}/status`,
        { method: "PATCH", body: JSON.stringify({ status: next }) },
      );
      assert.equal(r.status, 200, `${next}: ${r.text}`);
      assert.equal(r.body.stockDeferred, next === "SERVED" ? true : undefined, `${next} tells the till the deduction waited`);
    }
    const row = await db.order.findUniqueOrThrow({ where: { id: confirmed.id } });
    assert.equal(row.status, "SERVED");
    assert.equal(row.stockDeductedAt, null);
    assert.equal(await stockOf(e.item.id), 5, "the frozen shelf did not move");
    const deferred = await db.deferredStockDeduction.findUniqueOrThrow({ where: { orderId: confirmed.id } });
    assert.equal(deferred.handoverId, result.handoverId);
    assert.equal(deferred.appliedAt, null);

    const listed = await as<{ orders: {
      id: string;
      handoverCarries: { statusAtHandover: string; shift: { shiftNumber: number; cashier: { name: string } } }[];
      deferredStockDeduction: { appliedAt: string | null } | null;
    }[] }>(fx.owner.email, `/api/orders?branchId=${fx.branchId}&status=SERVED`);
    assert.equal(listed.status, 200, listed.text);
    const card = listed.body.orders.find((o) => o.id === confirmed.id);
    assert.ok(card, "the served order is listed");
    assert.equal(card.handoverCarries.length, 1);
    assert.equal(card.handoverCarries[0].statusAtHandover, "CONFIRMED");
    assert.equal(card.handoverCarries[0].shift.shiftNumber, shift.shiftNumber);
    assert.equal(card.handoverCarries[0].shift.cashier.name, fx.cashier.name);
    assert.deepEqual(card.deferredStockDeduction?.appliedAt, null);

    // Both ways a freeze is released apply what was deferred, in the same transaction.
    const source = readFileSync("src/lib/handover.ts", "utf8");
    const releases = source.match(/await releaseInventoryFreeze\(tx, \{[\s\S]*?\}\);\s*\n(\s*\/\/[^\n]*\n)*\s*await applyDeferredDeductions\(tx,/g) ?? [];
    assert.equal(releases.length, 2);
  });

  test("the incoming shift sees what it inherited and what it must still collect", async () => {
    await setCarry(true);
    const shift = await openOperationalShift(fx.cashier.id);
    const ready = await openOrder("READY");
    const confirmed = await openOrder("CONFIRMED");
    await close(shift.id, fx.cashier.id);

    const list = await as<{ orders: Array<{ orderNumber: number; remaining: number; status: string; fromShiftNumber: number }> }>(
      fx.manager.email, "/api/handovers/carried-orders",
    );
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(
      list.body.orders.map((o) => o.orderNumber).sort((x, y) => x - y),
      [ready.orderNumber, confirmed.orderNumber],
    );
    assert.ok(list.body.orders.every((o) => o.remaining === 50 && o.fromShiftNumber === shift.shiftNumber));

    // Cancelled orders drop off the list.
    await db.order.update({ where: { id: confirmed.id }, data: { status: "CANCELLED" } });
    const after_ = await as<{ orders: Array<{ orderNumber: number }> }>(fx.manager.email, "/api/handovers/carried-orders");
    assert.deepEqual(after_.body.orders.map((o) => o.orderNumber), [ready.orderNumber]);

    // Another branch's manager cannot ask for this branch.
    const cross = await as(fx.manager.email, `/api/handovers/carried-orders?branchId=${fx.otherBranchId}`);
    assert.equal(cross.status, 403);
  });

  test("the setting is the owner's: audited, validated, refused to a cashier", async () => {
    const read = await as<{ carryOpenOrdersOnHandover: boolean }>(fx.cashier.email, "/api/cafe/handover-policy");
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.carryOpenOrdersOnHandover, false);

    const denied = await as(fx.cashier.email, "/api/cafe/handover-policy", {
      method: "PATCH", body: JSON.stringify({ carryOpenOrdersOnHandover: true }),
    });
    assert.equal(denied.status, 403);

    const bad = await as(fx.owner.email, "/api/cafe/handover-policy", {
      method: "PATCH", body: JSON.stringify({ carryOpenOrdersOnHandover: "yes" }),
    });
    assert.equal(bad.status, 400);

    const ok = await as<{ carryOpenOrdersOnHandover: boolean }>(fx.owner.email, "/api/cafe/handover-policy", {
      method: "PATCH", body: JSON.stringify({ carryOpenOrdersOnHandover: true }),
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.carryOpenOrdersOnHandover, true);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { cafeId: fx.cafeId, action: "HANDOVER_CARRY_OPEN_ORDERS_CHANGED" },
    });
    const details = audit.details as { oldValue: boolean; newValue: boolean };
    assert.equal(details.oldValue, false);
    assert.equal(details.newValue, true);
  });

  test("the close dialog renders structured blockers instead of dropping them", async () => {
    const { ApiRequestError, blockersOf } = await import("@/lib/client");
    const lines = blockersOf(new ApiRequestError("x", 409, {
      blockers: [
        { code: "UNSERVED_ORDERS", count: 3, message: "en", messageAr: "أوردرات لسه متقدمتش", ids: ["a", "b"], refs: ["#12", "#13"] },
        { code: "HANDOVER_CONFIG_ERROR", count: 1, message: "en", messageAr: "إعدادات", ids: ["X"] },
        "plain reason",
        { junk: true },
      ],
    }));
    assert.deepEqual(lines, [
      "plain reason",
      "أوردرات لسه متقدمتش (3): #12، #13 و1 غيرهم",
      "إعدادات (1)",
    ]);
  });

  test("the migration is additive and defaults to today's behaviour", () => {
    const dir = readdirSync("prisma/migrations").find((d) => d.endsWith("_carry_open_orders_on_handover"));
    assert.ok(dir, "migration exists");
    const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8");
    assert.match(sql, /"carryOpenOrdersOnHandover" BOOLEAN NOT NULL DEFAULT false/);
    assert.ok(!/DROP |_disposable_test_database|UPDATE "/i.test(sql), "nothing dropped or rewritten");
  });
});
