// ATS-007 — availability is a fact about ONE shelf.
//
// Every number this feature produces is a subtraction between two sets of
// rows: what a branch holds, and what that branch's open orders have already
// promised. Both sides have to be scoped, and getting either wrong fails in
// the direction that sells drinks the branch cannot make — a sister branch's
// full freezer making this branch look stocked, or another café's orders
// eating capacity here.
//
// Matching ingredients by name+unit is what makes this worth testing rather
// than assuming: it is the rule the deduction already uses, and it is exactly
// the kind of rule that reaches across a tenant boundary if the query filter
// is forgotten. Two branches of one café stock «لبن» in LITER, and so does
// the café next door.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { atsCafe, ingredient, product, recipe, rawOrder, setMode, type AtsCafe } from "./helpers/ats";
import { branchAvailability } from "@/lib/stock-availability";
import { configurationFor } from "@/lib/available-to-sell";

let fx: AtsCafe;
let other: AtsCafe;

before(async () => {
  await requireServer();
  fx = await atsCafe("ATS007");
  other = await atsCafe("ATS007B");
  await setMode(fx.cafeId, "STRICT");
  await setMode(other.cafeId, "STRICT");
});

after(() =>
  teardownTaggedCafe(
    [fx?.cafeId, other?.cafeId].filter(Boolean) as string[],
    [],
    { disconnect: true }
  )
);

async function units(cafeId: string, branchId: string, productId: string) {
  const a = await branchAvailability({ cafeId, branchId, mode: "STRICT" });
  return configurationFor(a, productId, null).units;
}

describe("ATS-007 availability and commitments are tenant-scoped", () => {
  test("44 — a commitment names the café it was made in", async () => {
    const item = await ingredient(fx, "scoped", { stock: 1.0 });
    const p = await product(fx, "scoped-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const r = await as<{ order: { id: string } }>(fx.manager.email, "/api/orders", {
      method: "POST",
      body: JSON.stringify({
        branchId: fx.branchId, type: "DINE_IN", tableNumber: "4",
        collectionMode: "PENDING",
        items: [{ productId: p.id, variantId: null, quantity: 2, addOnIds: [] }],
      }),
    });
    assert.equal(r.status, 201, r.text);

    const rows = await db.orderInventoryCommitment.findMany({
      where: { orderId: r.body.order.id },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cafeId, fx.cafeId);
  });

  test("45 — and the branch whose shelf it will empty", async () => {
    const rows = await db.orderInventoryCommitment.findMany({ where: { cafeId: fx.cafeId } });
    assert.ok(rows.length > 0, "the previous test left one");
    for (const row of rows) {
      assert.equal(row.branchId, fx.branchId, "a commitment belongs to one branch");
      const item = await db.inventoryItem.findUniqueOrThrow({
        where: { id: row.inventoryItemId },
      });
      assert.equal(item.branchId, row.branchId, "and points at that branch's own stock row");
      assert.equal(item.cafeId, row.cafeId);
    }
  });

  test("46 — another branch's stock does not make this branch look stocked", async () => {
    // Same name, same unit, different branch: the annex is full and the main
    // branch is empty.
    const here = await db.inventoryItem.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId,
        name: `${fx.marker} twin-milk`, unit: "LITER", costPerUnit: 40, currentStock: "0",
      },
    });
    await db.inventoryItem.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.otherBranchId,
        name: `${fx.marker} twin-milk`, unit: "LITER", costPerUnit: 40, currentStock: "100",
      },
    });
    const p = await product(fx, "twin-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: here.id, qty: "200", unit: "ML" }]);

    assert.equal(
      await units(fx.cafeId, fx.branchId, p.id), 0,
      "the annex's hundred litres are not on this counter"
    );
    assert.equal(
      await units(fx.cafeId, fx.otherBranchId, p.id), 500,
      "and the annex can make five hundred"
    );
  });

  test("46b — another branch's open orders do not eat this branch's capacity", async () => {
    const here = await ingredient(fx, "branch-split", { stock: 1.0 });
    const there = await db.inventoryItem.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.otherBranchId,
        name: here.name, unit: here.unit, costPerUnit: 120, currentStock: "1.000",
      },
    });
    const p = await product(fx, "split-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: here.id, qty: "0.100" }]);

    await rawOrder(fx, {
      branchId: fx.otherBranchId,
      items: [{ productId: p.id, quantity: 5 }],
      commitments: [{ inventoryItemId: there.id, quantity: 0.5 }],
    });

    assert.equal(await units(fx.cafeId, fx.branchId, p.id), 10, "the main branch is untouched");
    assert.equal(await units(fx.cafeId, fx.otherBranchId, p.id), 5, "the annex spent its own");
  });

  test("47 — another café cannot move this café's numbers in either direction", async () => {
    const mine = await ingredient(fx, "cross", { stock: 1.0 });
    const p = await product(fx, "cross-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: mine.id, qty: "0.100" }]);
    assert.equal(await units(fx.cafeId, fx.branchId, p.id), 10);

    // The café next door: same ingredient name, same unit, plenty of stock,
    // and an open order that has committed all of it.
    const theirs = await db.inventoryItem.create({
      data: {
        cafeId: other.cafeId, branchId: other.branchId,
        name: mine.name, unit: mine.unit, costPerUnit: 120, currentStock: "50",
      },
    });
    const theirProduct = await product(other, "their-drink");
    await recipe(other, { productId: theirProduct.id }, [{ itemId: theirs.id, qty: "0.100" }]);
    await rawOrder(other, {
      items: [{ productId: theirProduct.id, quantity: 100 }],
      commitments: [{ inventoryItemId: theirs.id, quantity: 10 }],
    });

    assert.equal(
      await units(fx.cafeId, fx.branchId, p.id), 10,
      "neither their stock nor their promises reach this shelf"
    );

    const a = await branchAvailability({
      cafeId: fx.cafeId, branchId: fx.branchId, mode: "STRICT",
    });
    const foreign = a.configurations.find((c) => c.productId === theirProduct.id);
    assert.equal(foreign, undefined, "and their menu is not on this branch's board");
  });

  test("the batch endpoint refuses a branch outside the caller's café", async () => {
    const r = await as<{ error?: string }>(
      fx.manager.email,
      `/api/pos/availability?branchId=${other.branchId}`
    );
    assert.ok(r.status === 403 || r.status === 404, `cross-tenant read refused: ${r.status}`);
  });
});
