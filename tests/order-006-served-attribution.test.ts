import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanup,
  cleanupProduct,
  clearOpenShifts,
  db,
  fixture,
  openShift,
  policyProduct,
  sessionFor,
} from "./helpers/db";
import { as, login, requireServer } from "./helpers/http";

const CASHIER = "cashier@demo.com";
const MANAGER = "manager@demo.com";

async function readyOrder(branchId: string, productId: string, marker: string) {
  const created = await as<{ order: { id: string } }>(CASHIER, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId,
      type: "TAKEAWAY",
      customerName: marker,
      collectionMode: "PENDING",
      items: [{ productId, quantity: 1, addOnIds: [] }],
    }),
  });
  assert.ok(created.status < 300, `order setup failed: ${created.text}`);
  for (const status of ["PREPARING", "READY"]) {
    const moved = await as(CASHIER, `/api/orders/${created.body.order.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    assert.ok(moved.status < 300, `walk to ${status} failed: ${moved.text}`);
  }
  return created.body.order.id;
}

describe("ORDER-006 served attribution", () => {
  before(async () => {
    await requireServer();
    await login(CASHIER, "cashier123");
    await login(MANAGER, "manager123");
  });
  after(async () => db.$disconnect());

  test("refuses SERVED while STOCK custody is Branch-held or unassigned without mutation", async () => {
    const fx = await fixture();
    const actor = await sessionFor(CASHIER);
    const marker = `ORD6-BRANCH-${process.pid}`;
    const product = await policyProduct(fx, marker);
    const settings = await db.cafeSettings.findUniqueOrThrow({ where: { cafeId: fx.cafeId } });
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, actor.id);
    const shift = await openShift(fx, actor.id, 100);
    const existing = await db.custodyPeriod.findFirst({
      where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" },
      select: { id: true, status: true, holderType: true, responsibleShiftId: true },
    });
    const custody = existing ?? await db.custodyPeriod.create({
      data: { cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK", holderType: "BRANCH", openedById: actor.id },
    });
    await db.custodyPeriod.update({
      where: { id: custody.id },
      data: { holderType: "BRANCH", responsibleShiftId: null },
    });
    await db.cafeSettings.update({
      where: { cafeId: fx.cafeId },
      data: { takeawayServingPolicy: "ALLOW_BEFORE_PAYMENT" },
    });

    try {
      const id = await readyOrder(fx.branchId, product.id, marker);
      const served = await as(CASHIER, `/api/orders/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "SERVED" }),
      });

      assert.ok(served.status >= 400, "Branch-held stock must refuse SERVED");
      const order = await db.order.findUniqueOrThrow({ where: { id } });
      assert.equal(order.status, "READY");
      assert.equal(order.servedAt, null);
      assert.equal(order.stockDeductedAt, null);

      await db.custodyPeriod.update({
        where: { id: custody.id },
        data: { holderType: "USER", responsibleShiftId: null },
      });
      const unassignedId = await readyOrder(fx.branchId, product.id, `${marker}-UNASSIGNED`);
      const unassigned = await as(CASHIER, `/api/orders/${unassignedId}/status`, {
        method: "PATCH", body: JSON.stringify({ status: "SERVED" }),
      });
      assert.ok(unassigned.status >= 400, "Unassigned USER stock must refuse SERVED");
      const unassignedOrder = await db.order.findUniqueOrThrow({ where: { id: unassignedId } });
      assert.equal(unassignedOrder.status, "READY");
      assert.equal(unassignedOrder.servedAt, null);
      assert.equal(unassignedOrder.stockDeductedAt, null);

      await db.custodyPeriod.update({ where: { id: custody.id }, data: { status: "TRANSFERRED" } });
      const missingId = await readyOrder(fx.branchId, product.id, `${marker}-MISSING`);
      const missing = await as(CASHIER, `/api/orders/${missingId}/status`, {
        method: "PATCH", body: JSON.stringify({ status: "SERVED" }),
      });
      assert.ok(missing.status >= 400, "Missing stock custody must refuse SERVED");
      const missingOrder = await db.order.findUniqueOrThrow({ where: { id: missingId } });
      assert.equal(missingOrder.status, "READY");
      assert.equal(missingOrder.servedAt, null);
      assert.equal(missingOrder.stockDeductedAt, null);
    } finally {
      await cleanup(marker);
      if (existing) {
        await db.custodyPeriod.update({
          where: { id: existing.id },
          data: { status: existing.status, holderType: existing.holderType, responsibleShiftId: existing.responsibleShiftId },
        });
      } else {
        await db.custodyPeriod.delete({ where: { id: custody.id } });
      }
      await db.shift.delete({ where: { id: shift.id } });
      await db.cafeSettings.update({
        where: { cafeId: fx.cafeId },
        data: { takeawayServingPolicy: settings.takeawayServingPolicy },
      });
      await cleanupProduct(product.id);
    }
  });

  test("captures the serving actor and the custody responsible shift exactly once", async () => {
    const fx = await fixture();
    const actor = await sessionFor(CASHIER);
    const responsible = await sessionFor(MANAGER);
    const marker = `ORD6-IMMUTABLE-${process.pid}`;
    const product = await policyProduct(fx, marker);
    const settings = await db.cafeSettings.findUniqueOrThrow({ where: { cafeId: fx.cafeId } });
    await cleanup(marker);
    await clearOpenShifts(fx.branchId, actor.id);
    await clearOpenShifts(fx.branchId, responsible.id);
    const actorShift = await openShift(fx, actor.id, 100);
    const responsibleShift = await openShift(fx, responsible.id, 100);
    const existing = await db.custodyPeriod.findFirst({
      where: { branchId: fx.branchId, scope: "STOCK", status: "OPEN" },
      select: { id: true, holderType: true, responsibleShiftId: true },
    });
    const custody = existing ?? await db.custodyPeriod.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK", holderType: "USER",
        openedById: responsible.id, responsibleShiftId: responsibleShift.id,
      },
    });
    await db.custodyPeriod.update({
      where: { id: custody.id },
      data: { holderType: "USER", responsibleShiftId: responsibleShift.id },
    });
    await db.cafeSettings.update({
      where: { cafeId: fx.cafeId }, data: { takeawayServingPolicy: "ALLOW_BEFORE_PAYMENT" },
    });

    try {
      const id = await readyOrder(fx.branchId, product.id, marker);
      const served = await as(CASHIER, `/api/orders/${id}/status`, {
        method: "PATCH", body: JSON.stringify({ status: "SERVED" }),
      });
      assert.equal(served.status, 200, served.text);
      const first = await db.order.findUniqueOrThrow({ where: { id } });
      assert.equal(first.servedById, actor.id);
      assert.equal(first.servedStockCustodyPeriodId, custody.id);
      assert.equal(first.servedShiftId, responsibleShift.id);

      await db.custodyPeriod.update({
        where: { id: custody.id }, data: { responsibleShiftId: actorShift.id },
      });
      const replay = await as(CASHIER, `/api/orders/${id}/status`, {
        method: "PATCH", body: JSON.stringify({ status: "SERVED" }),
      });
      assert.equal(replay.status, 200, replay.text);
      const replayed = await db.order.findUniqueOrThrow({ where: { id } });
      assert.equal(replayed.servedById, actor.id);
      assert.equal(replayed.servedStockCustodyPeriodId, custody.id);
      assert.equal(replayed.servedShiftId, responsibleShift.id);
    } finally {
      await cleanup(marker);
      if (existing) {
        await db.custodyPeriod.update({
          where: { id: existing.id },
          data: { holderType: existing.holderType, responsibleShiftId: existing.responsibleShiftId },
        });
      } else {
        await db.custodyPeriod.delete({ where: { id: custody.id } });
      }
      await db.shift.deleteMany({ where: { id: { in: [actorShift.id, responsibleShift.id] } } });
      await db.cafeSettings.update({
        where: { cafeId: fx.cafeId }, data: { takeawayServingPolicy: settings.takeawayServingPolicy },
      });
      await cleanupProduct(product.id);
    }
  });
});
