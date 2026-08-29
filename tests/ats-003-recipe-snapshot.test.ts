// ATS-003 — a recipe edit governs the next order, never the last one.
//
// Two things must be true at once, and they pull in opposite directions:
//
//   the owner fixes a recipe at 10:05, and the till must immediately price
//   and count NEW drinks by the new figure;
//
//   order #50 was accepted at 10:00 under the OLD figure, and the ice cream
//   it is holding is the amount that was actually promised. Rewriting it to
//   today's number would make the branch's committed stock depend on an edit
//   made after the customer was told yes.
//
// The system already applies exactly this rule to money — `taxRateSnapshot`
// exists so a settings change never rewrites what somebody was charged — and
// to enforcement, which the order now carries as `inventoryEnforcementMode`.
// Consumption is the same kind of fact, so it is snapshotted at acceptance
// and never recomputed.
//
// The failure this prevents is quiet: recompute open commitments from the
// current recipe and a single edit silently moves every open order's claim on
// the shelf, in whichever direction the edit went, with no record that it
// happened.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import {
  atsCafe, ingredient, product, recipe, setRecipeQuantity, setMode,
  type AtsCafe,
} from "./helpers/ats";
import { branchAvailability } from "@/lib/stock-availability";
import { configurationFor } from "@/lib/available-to-sell";

let fx: AtsCafe;

before(async () => {
  await requireServer();
  fx = await atsCafe("ATS003");
  await setMode(fx.cafeId, "STRICT");
});

after(() => teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true }));

async function units(productId: string): Promise<number | null> {
  const a = await branchAvailability({
    cafeId: fx.cafeId, branchId: fx.branchId, mode: "STRICT",
  });
  return configurationFor(a, productId, null).units;
}

async function placeOrder(productId: string, quantity: number) {
  return as<{ order: { id: string } }>(fx.manager.email, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: fx.branchId, type: "DINE_IN", tableNumber: "3",
      collectionMode: "PENDING",
      items: [{ productId, variantId: null, quantity, addOnIds: [] }],
    }),
  });
}

describe("ATS-003 order-time recipe snapshot", () => {
  test("21 — an accepted order records exactly what it will consume", async () => {
    const ice = await ingredient(fx, "ice-cream", { stock: 0.8 });
    const p = await product(fx, "milkshake");
    await recipe(fx, { productId: p.id }, [{ itemId: ice.id, qty: "0.160" }]);

    const r = await placeOrder(p.id, 3);
    assert.equal(r.status, 201, r.text);

    const rows = await db.orderInventoryCommitment.findMany({
      where: { orderId: r.body.order.id },
    });
    assert.equal(rows.length, 1, "one row per branch inventory item");
    assert.equal(
      Number(rows[0].quantity), 0.48,
      "three cups at 0.160 KG is 0.480 KG, in the ingredient's own stock unit"
    );
    assert.equal(rows[0].inventoryItemId, ice.id, "against the BRANCH row that will be deducted");
    assert.equal(rows[0].unit, "KG");
    assert.equal(rows[0].releasedAt, null, "and it is live");

    const order = await db.order.findUniqueOrThrow({ where: { id: r.body.order.id } });
    assert.ok(order.inventoryCommittedAt, "the order records that it HAS a snapshot");
  });

  test("22 — a smaller recipe immediately makes more available for NEW sales", async () => {
    const ice = await ingredient(fx, "ice-cream-b", { stock: 0.8 });
    const p = await product(fx, "shake-b");
    const rec = await recipe(fx, { productId: p.id }, [{ itemId: ice.id, qty: "0.160" }]);

    assert.equal(await units(p.id), 5);

    await setRecipeQuantity(rec.id, ice.id, "0.100");
    assert.equal(await units(p.id), 8, "0.800 at 0.100 a cup is eight");
  });

  test("23 — a larger recipe immediately makes fewer available for NEW sales", async () => {
    const ice = await ingredient(fx, "ice-cream-c", { stock: 0.8 });
    const p = await product(fx, "shake-c");
    const rec = await recipe(fx, { productId: p.id }, [{ itemId: ice.id, qty: "0.160" }]);

    assert.equal(await units(p.id), 5);

    await setRecipeQuantity(rec.id, ice.id, "0.200");
    assert.equal(await units(p.id), 4);
  });

  test("24 — an open order's commitment is untouched by the edit", async () => {
    const ice = await ingredient(fx, "ice-cream-d", { stock: 2.0 });
    const p = await product(fx, "shake-d");
    const rec = await recipe(fx, { productId: p.id }, [{ itemId: ice.id, qty: "0.160" }]);

    const r = await placeOrder(p.id, 2);
    assert.equal(r.status, 201, r.text);
    const before = await db.orderInventoryCommitment.findFirstOrThrow({
      where: { orderId: r.body.order.id },
    });
    assert.equal(Number(before.quantity), 0.32);

    await setRecipeQuantity(rec.id, ice.id, "0.100");

    const after = await db.orderInventoryCommitment.findFirstOrThrow({
      where: { orderId: r.body.order.id },
    });
    assert.equal(
      Number(after.quantity), 0.32,
      "order #50 still holds the 0.320 KG it was accepted for"
    );
    assert.equal(
      after.createdAt.getTime(), before.createdAt.getTime(),
      "the row was not rewritten"
    );
  });

  test("25 — the next order uses the new recipe", async () => {
    const ice = await ingredient(fx, "ice-cream-e", { stock: 2.0 });
    const p = await product(fx, "shake-e");
    const rec = await recipe(fx, { productId: p.id }, [{ itemId: ice.id, qty: "0.160" }]);

    const first = await placeOrder(p.id, 1);
    await setRecipeQuantity(rec.id, ice.id, "0.100");
    const second = await placeOrder(p.id, 1);
    assert.equal(second.status, 201, second.text);

    const a = await db.orderInventoryCommitment.findFirstOrThrow({
      where: { orderId: first.body.order.id },
    });
    const b = await db.orderInventoryCommitment.findFirstOrThrow({
      where: { orderId: second.body.order.id },
    });
    assert.equal(Number(a.quantity), 0.16, "accepted under the old recipe");
    assert.equal(Number(b.quantity), 0.1, "accepted under the new one");
  });

  test("26 — no recipe edit ever rewrites an existing order's commitment", async () => {
    const ice = await ingredient(fx, "ice-cream-f", { stock: 3.0 });
    const milk = await ingredient(fx, "milk-f", { stock: 3.0 });
    const p = await product(fx, "shake-f");
    const rec = await recipe(fx, { productId: p.id }, [{ itemId: ice.id, qty: "0.160" }]);

    const r = await placeOrder(p.id, 2);
    const orderId = r.body.order.id;
    const snapshot = await db.orderInventoryCommitment.findMany({
      where: { orderId }, orderBy: { inventoryItemId: "asc" },
    });

    // Every shape of edit the owner's screen can make: change a quantity,
    // add an ingredient, remove one, and replace the whole recipe.
    await setRecipeQuantity(rec.id, ice.id, "0.400");
    await db.recipeItem.create({
      data: { recipeId: rec.id, inventoryItemId: milk.id, quantity: "0.250", unit: "KG" },
    });
    await db.recipeItem.delete({
      where: { recipeId_inventoryItemId: { recipeId: rec.id, inventoryItemId: ice.id } },
    });

    const after = await db.orderInventoryCommitment.findMany({
      where: { orderId }, orderBy: { inventoryItemId: "asc" },
    });
    assert.deepEqual(
      after.map((c) => [c.inventoryItemId, Number(c.quantity), c.releasedAt]),
      snapshot.map((c) => [c.inventoryItemId, Number(c.quantity), c.releasedAt]),
      "the accepted order is evidence, not a view over the current recipe"
    );

    // And the NEW recipe is what the next sale is measured against: the
    // drink now draws milk, so the ice cream the old order is still holding
    // stops limiting it.
    assert.equal(await units(p.id), 12, "3.000 KG of milk at 0.250 a cup");
  });
});
