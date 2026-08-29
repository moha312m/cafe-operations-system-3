// ATS-005 — what the shelf holds and what the owner permits are two answers.
//
// This is the distinction the whole feature turns on. "Available to sell" is
// a physical fact: given this recipe and this branch's stock, how many more
// can be made. "May this sale proceed" is the café's policy. Collapsing them
// is how a POS ends up displaying "unlimited" because negative stock is
// allowed — which is not a stock level, it is a permission, and the cashier
// reading it has no idea the freezer is empty.
//
// So each mode is checked twice over: what the till DOES, and what the card
// SAYS while it does it.
//
//   STRICT                refuses at zero; the card says نفد
//   ALLOW_NEGATIVE_STOCK  sells at zero; the card still says zero
//   OVERRIDE_ALL          sells against an unreadable recipe; the card says
//                         غير محسوب, because there is no number to show and
//                         inventing one would be the lie the mode does not ask for
//   NOT_APPLICABLE        sells freely; the card says it is not stock-linked,
//                         which is not the same as out of stock

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { atsCafe, ingredient, product, recipe, setMode, type AtsCafe } from "./helpers/ats";
import { branchAvailability } from "@/lib/stock-availability";
import { configurationFor } from "@/lib/available-to-sell";
import type { InventoryEnforcementMode } from "@prisma/client";

let fx: AtsCafe;

before(async () => {
  await requireServer();
  fx = await atsCafe("ATS005");
});

after(() => teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true }));

async function ats(productId: string, mode: InventoryEnforcementMode) {
  const a = await branchAvailability({ cafeId: fx.cafeId, branchId: fx.branchId, mode });
  return configurationFor(a, productId, null);
}

async function sell(productId: string, quantity = 1) {
  return as<{ order?: { id: string }; error?: string }>(fx.manager.email, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: fx.branchId, type: "DINE_IN", tableNumber: "9",
      collectionMode: "PENDING",
      items: [{ productId, variantId: null, quantity, addOnIds: [] }],
    }),
  });
}

describe("ATS-005 policy decides the sale; the shelf decides the number", () => {
  test("38 — STRICT: nothing left means نفد, and the till refuses", async () => {
    await setMode(fx.cafeId, "STRICT");
    const item = await ingredient(fx, "empty", { stock: 0 });
    const p = await product(fx, "strict-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const a = await ats(p.id, "STRICT");
    assert.equal(a.state, "EXACT");
    assert.equal(a.units, 0);

    const r = await sell(p.id);
    assert.equal(r.status, 409, `STRICT must refuse: ${r.text}`);
  });

  test("39 — ALLOW_NEGATIVE_STOCK: the sale goes through and the count stays zero", async () => {
    await setMode(fx.cafeId, "ALLOW_NEGATIVE_STOCK");
    const item = await ingredient(fx, "negative-ok", { stock: 0 });
    const p = await product(fx, "negative-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    assert.equal((await ats(p.id, "ALLOW_NEGATIVE_STOCK")).units, 0);

    const r = await sell(p.id);
    assert.equal(r.status, 201, `the owner permitted this: ${r.text}`);

    const after = await ats(p.id, "ALLOW_NEGATIVE_STOCK");
    assert.equal(after.state, "EXACT", "still a number, never 'unlimited'");
    assert.equal(after.units, 0, "permission to go negative is not stock");

    // The consumption is still committed, so the physical picture stays
    // honest even though the balance it describes is now below zero.
    const rows = await db.orderInventoryCommitment.findMany({
      where: { orderId: r.body.order!.id },
    });
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].quantity), 0.1);
  });

  test("40 — OVERRIDE_ALL with a readable recipe still shows the physical zero", async () => {
    await setMode(fx.cafeId, "OVERRIDE_ALL");
    const item = await ingredient(fx, "override-known", { stock: 0 });
    const p = await product(fx, "override-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const r = await sell(p.id);
    assert.equal(r.status, 201, r.text);

    const a = await ats(p.id, "OVERRIDE_ALL");
    assert.equal(a.state, "EXACT", "the recipe is readable, so the number is knowable");
    assert.equal(a.units, 0);
  });

  test("41 — OVERRIDE_ALL with no recipe sells, and the count stays UNKNOWN", async () => {
    await setMode(fx.cafeId, "OVERRIDE_ALL");
    const p = await product(fx, "unwritten");

    const a = await ats(p.id, "OVERRIDE_ALL");
    assert.equal(a.state, "UNKNOWN");
    assert.equal(a.units, null, "the mode waives the refusal, not the ignorance");

    const r = await sell(p.id);
    assert.equal(r.status, 201, `OVERRIDE_ALL permits the unknown draw: ${r.text}`);

    // Nothing is committed for a consumption nobody has written down. The
    // absence is the honest record; a zero row would read as "measured".
    const rows = await db.orderInventoryCommitment.findMany({
      where: { orderId: r.body.order!.id },
    });
    assert.equal(rows.length, 0);
    const order = await db.order.findUniqueOrThrow({ where: { id: r.body.order!.id } });
    assert.ok(
      order.inventoryCommittedAt,
      "but the order DID pass through the snapshot step, so it is not a legacy unknown"
    );
  });

  test("42 — NOT_APPLICABLE is allowed everywhere and is never reported as zero", async () => {
    const p = await product(fx, "bottled");
    await recipe(fx, { productId: p.id }, [], { notApplicable: true });

    for (const mode of ["STRICT", "ALLOW_NEGATIVE_STOCK", "OVERRIDE_ALL"] as const) {
      await setMode(fx.cafeId, mode);
      const a = await ats(p.id, mode);
      assert.equal(a.state, "NOT_STOCK_TRACKED", `${mode}: not stock-linked`);
      assert.equal(a.units, null, `${mode}: and therefore not zero`);
      const r = await sell(p.id);
      assert.equal(r.status, 201, `${mode}: ${r.text}`);
    }
  });

  test("a branch that does not carry the ingredient is refused under STRICT and disclosed under OVERRIDE_ALL", async () => {
    // The recipe is readable; the branch is not configured for it. Under
    // STRICT that is a refusal, and under OVERRIDE_ALL it is a sale with the
    // gap on the record — in neither case is stock invented for it.
    const carried = await ingredient(fx, "carried-e", { stock: 5 });
    const absent = await db.inventoryItem.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.otherBranchId,
        name: `${fx.marker} absent-here`, unit: "KG", costPerUnit: 100, currentStock: "50",
      },
    });
    const p = await product(fx, "half-configured");
    await recipe(fx, { productId: p.id }, [
      { itemId: carried.id, qty: "0.100" },
      { itemId: absent.id, qty: "0.010" },
    ]);

    await setMode(fx.cafeId, "STRICT");
    const strict = await ats(p.id, "STRICT");
    assert.equal(strict.state, "NOT_STOCKED");
    assert.equal(strict.units, null);
    assert.equal((await sell(p.id)).status, 409);

    await setMode(fx.cafeId, "OVERRIDE_ALL");
    assert.equal((await sell(p.id)).status, 201);
    const over = await ats(p.id, "OVERRIDE_ALL");
    assert.equal(over.state, "NOT_STOCKED", "the mode permits the sale, not the invention");
  });
});
