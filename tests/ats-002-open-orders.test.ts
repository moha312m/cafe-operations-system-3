// ATS-002 — an accepted order has already spent the stock.
//
// `InventoryItem.currentStock` does not move until SERVED. That is correct —
// the deduction is a locked, audited, ledgered mutation and it belongs at the
// moment the drink is actually handed over. But it means the shelf balance
// alone is a lie to the next cashier: three milkshakes accepted two minutes
// ago are three milkshakes' worth of ice cream that is spoken for and still
// sitting in `currentStock`.
//
// So an accepted order persists what it will consume, and available-to-sell
// is stock MINUS those live commitments. This suite is about the lifecycle of
// that commitment, and mostly about its two ends:
//
//   at SERVED     the stock moves and the commitment must stop counting, in
//                 the SAME transaction — never both, never neither
//   at CANCELLED  the commitment stops counting and the evidence stays
//
// The "never neither" half is the one that is easy to get wrong and
// invisible when you do: release the commitment in one statement and deduct
// in another, and between them the branch briefly looks richer than it has
// ever been.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import {
  atsCafe, ingredient, product, recipe, rawOrder, setMode,
  type AtsCafe,
} from "./helpers/ats";
import { branchAvailability } from "@/lib/stock-availability";
import { configurationFor } from "@/lib/available-to-sell";

let fx: AtsCafe;

before(async () => {
  await requireServer();
  fx = await atsCafe("ATS002");
  await setMode(fx.cafeId, "STRICT");
});

after(() => teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true }));

async function units(productId: string): Promise<number | null> {
  const a = await branchAvailability({
    cafeId: fx.cafeId, branchId: fx.branchId, mode: "STRICT",
  });
  return configurationFor(a, productId, null).units;
}

/** Place a real order through the till, as the branch manager. */
async function placeOrder(
  items: { productId: string; variantId?: string | null; quantity: number; addOnIds?: string[] }[]
) {
  return as<{ order: { id: string }; error?: string }>(fx.manager.email, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: fx.branchId,
      type: "DINE_IN",
      tableNumber: "7",
      collectionMode: "PENDING",
      items: items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId ?? null,
        quantity: i.quantity,
        addOnIds: i.addOnIds ?? [],
      })),
    }),
  });
}

async function moveTo(orderId: string, status: string) {
  return as<{ error?: string }>(fx.manager.email, `/api/orders/${orderId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

describe("ATS-002 open orders reduce available-to-sell", () => {
  test("14 — one accepted open order takes its share off the shelf", async () => {
    const item = await ingredient(fx, "beans", { stock: 1.0 });
    const p = await product(fx, "drip");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    assert.equal(await units(p.id), 10, "nothing accepted yet");

    const r = await placeOrder([{ productId: p.id, quantity: 3 }]);
    assert.equal(r.status, 201, r.text);

    assert.equal(await units(p.id), 7, "three cups are spoken for");
    const stock = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(
      Number(stock.currentStock), 1.0,
      "and the shelf has NOT moved — deduction still belongs at SERVED"
    );
  });

  test("15 — several open orders aggregate", async () => {
    const item = await ingredient(fx, "syrup", { stock: 1.0 });
    const p = await product(fx, "vanilla");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    await placeOrder([{ productId: p.id, quantity: 2 }]);
    await placeOrder([{ productId: p.id, quantity: 3 }]);

    assert.equal(await units(p.id), 5, "two orders and three orders are five cups");
  });

  test("16 — quantity on one line aggregates the same way", async () => {
    const item = await ingredient(fx, "cocoa", { stock: 1.0 });
    const p = await product(fx, "mocha");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    await placeOrder([{ productId: p.id, quantity: 4 }]);
    assert.equal(await units(p.id), 6);
  });

  test("17 — a shared ingredient reduces every product that draws on it", async () => {
    const milk = await ingredient(fx, "shared-milk", { stock: 2.0 });
    const latte = await product(fx, "latte");
    const cappuccino = await product(fx, "cappuccino");
    await recipe(fx, { productId: latte.id }, [{ itemId: milk.id, qty: "0.200" }]);
    await recipe(fx, { productId: cappuccino.id }, [{ itemId: milk.id, qty: "0.100" }]);

    assert.equal(await units(latte.id), 10);
    assert.equal(await units(cappuccino.id), 20);

    // Five lattes is 1.000 KG of milk, whichever drink asks for it next.
    await placeOrder([{ productId: latte.id, quantity: 5 }]);

    assert.equal(await units(latte.id), 5);
    assert.equal(await units(cappuccino.id), 10, "the cappuccino lost milk it never ordered");
  });

  test("18 — cancelling releases the commitment without deleting the evidence", async () => {
    const item = await ingredient(fx, "cancel-me", { stock: 1.0 });
    const p = await product(fx, "cancellable");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const r = await placeOrder([{ productId: p.id, quantity: 4 }]);
    assert.equal(r.status, 201, r.text);
    assert.equal(await units(p.id), 6);

    const c = await moveTo(r.body.order.id, "CANCELLED");
    assert.equal(c.status, 200, c.text);

    assert.equal(await units(p.id), 10, "a cancelled order is not future consumption");

    const rows = await db.orderInventoryCommitment.findMany({
      where: { orderId: r.body.order.id },
    });
    assert.equal(rows.length, 1, "the commitment row is still there");
    assert.ok(rows[0].releasedAt, "it is released, not deleted");
    assert.equal(rows[0].releaseReason, "CANCELLED");
  });

  test("19 — at SERVED the shelf moves and the commitment stops, never both", async () => {
    const item = await ingredient(fx, "serve-me", { stock: 1.0 });
    const p = await product(fx, "servable");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const r = await placeOrder([{ productId: p.id, quantity: 4 }]);
    assert.equal(r.status, 201, r.text);
    const orderId = r.body.order.id;
    assert.equal(await units(p.id), 6, "committed but not yet deducted");

    for (const s of ["PREPARING", "READY", "SERVED"]) {
      const m = await moveTo(orderId, s);
      assert.equal(m.status, 200, `${s}: ${m.text}`);
    }

    const stock = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(Number(stock.currentStock), 0.6, "0.400 KG left the shelf");

    // The number the cashier sees must be the same before and after the
    // handover: the consumption moved from one representation to the other,
    // it did not happen twice and it did not briefly stop existing.
    assert.equal(await units(p.id), 6, "still six — counted once, not twice");

    const rows = await db.orderInventoryCommitment.findMany({ where: { orderId } });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].releasedAt, "released by the deduction");
    assert.equal(rows[0].releaseReason, "DEDUCTED");
  });

  test("20 — SERVED is idempotent: neither stock nor availability moves twice", async () => {
    const item = await ingredient(fx, "serve-twice", { stock: 1.0 });
    const p = await product(fx, "twice-served");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const r = await placeOrder([{ productId: p.id, quantity: 2 }]);
    const orderId = r.body.order.id;
    for (const s of ["PREPARING", "READY", "SERVED"]) await moveTo(orderId, s);

    const after1 = await units(p.id);
    const stock1 = Number(
      (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock
    );

    // SERVED → SERVED is not a legal transition, so the second attempt is
    // refused rather than silently deducting again. Either way the invariant
    // is the same: the shelf moved exactly once.
    const again = await moveTo(orderId, "SERVED");
    assert.ok(again.status >= 400, "a served order cannot be served again");

    const stock2 = Number(
      (await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock
    );
    assert.equal(stock2, stock1, "no second deduction");
    assert.equal(stock2, 0.8);
    assert.equal(await units(p.id), after1, "and no second release either");
  });

  test("an order still waiting for approval has not been accepted, so it commits nothing", async () => {
    const item = await ingredient(fx, "pending", { stock: 1.0 });
    const p = await product(fx, "pending-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    await rawOrder(fx, {
      status: "PENDING_WAITER_APPROVAL",
      items: [{ productId: p.id, quantity: 5 }],
    });

    assert.equal(
      await units(p.id), 10,
      "an order nobody has accepted is not a promise about the shelf"
    );
  });

  test("an open order from before the commitment ledger is declared uncertain, not guessed", async () => {
    // No snapshot exists for it and OrderItem carries no consumption
    // evidence, so recomputing it from today's recipe would be inventing
    // history. It is counted and disclosed instead.
    const item = await ingredient(fx, "legacy", { stock: 1.0 });
    const p = await product(fx, "legacy-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const before = await branchAvailability({
      cafeId: fx.cafeId, branchId: fx.branchId, mode: "STRICT",
    });

    const legacy = await rawOrder(fx, {
      status: "CONFIRMED",
      committedAt: null, // the pre-feature shape: accepted, never snapshotted
      items: [{ productId: p.id, quantity: 3 }],
    });

    const a = await branchAvailability({
      cafeId: fx.cafeId, branchId: fx.branchId, mode: "STRICT",
    });
    assert.equal(
      a.uncertainOpenOrders, before.uncertainOpenOrders + 1,
      "the branch says how many open orders it cannot account for"
    );
    assert.equal(
      configurationFor(a, p.id, null).units, 10,
      "and does not fabricate a draw it has no record of"
    );

    // Once it finalises, the uncertainty finalises with it.
    await db.order.update({ where: { id: legacy.id }, data: { status: "CANCELLED" } });
    const b = await branchAvailability({
      cafeId: fx.cafeId, branchId: fx.branchId, mode: "STRICT",
    });
    assert.equal(b.uncertainOpenOrders, before.uncertainOpenOrders);
  });
});
