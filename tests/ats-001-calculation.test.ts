// ATS-001 — how many can we still make?
//
// The POS has always been able to say "this cannot be sold". It has never
// been able to say how many are left, and those are different questions: the
// first is answered by one refusal, the second by the WHOLE recipe measured
// against the whole shelf. A caramel milkshake whose ice cream supports five
// cups and whose milk supports twenty supports five cups, and a system that
// answers twenty because it looked at the first ingredient it found is worse
// than one that says nothing.
//
// So this suite is about the arithmetic, and about the four answers that are
// NOT arithmetic:
//
//   EXACT              a number we stand behind
//   UNKNOWN            the recipe does not resolve — never a number
//   NOT_STOCK_TRACKED  somebody recorded that this consumes nothing
//   NOT_STOCKED        the recipe is readable, the branch is not configured
//
// The last three exist because inventing a zero is the failure mode that
// matters. "Out of stock" and "nobody wrote the recipe down" look identical
// on a screen and mean opposite things to the person who has to fix them.
//
// Precision is load-bearing and gets its own tests. Stock is Decimal(12,3);
// in IEEE floats 0.48 / 0.16 is 2.9999999999999996, and a café holding
// exactly three portions must be told three.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import {
  atsCafe, ingredient, product, addOn, recipe, unstockedIngredient,
  type AtsCafe,
} from "./helpers/ats";
import { branchAvailability } from "@/lib/stock-availability";
import { configurationFor, unitsSupported } from "@/lib/available-to-sell";

let fx: AtsCafe;

before(async () => {
  fx = await atsCafe("ATS001");
});

after(() => teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true }));

/** The branch's whole availability answer, exactly as the POS would load it. */
async function avail() {
  return branchAvailability({ cafeId: fx.cafeId, branchId: fx.branchId, mode: "STRICT" });
}

async function atsFor(productId: string, variantId: string | null = null) {
  return configurationFor(await avail(), productId, variantId);
}

describe("ATS-001 available-to-sell calculation", () => {
  test("1 — one ingredient: capacity is stock divided by the portion", async () => {
    const ice = await ingredient(fx, "ice-cream", { stock: 0.8 });
    const p = await product(fx, "single");
    await recipe(fx, { productId: p.id }, [{ itemId: ice.id, qty: "0.160" }]);

    const a = await atsFor(p.id);
    assert.equal(a.state, "EXACT");
    assert.equal(a.units, 5, "0.800 KG at 0.160 KG a cup is five cups");
  });

  test("2 — several ingredients: the limiting one decides", async () => {
    // The example from the brief, with the numbers that make the wrong
    // answer look plausible: milk alone would say twenty.
    const ice = await ingredient(fx, "ice-cream", { stock: 0.8 }); // 5
    const milk = await ingredient(fx, "milk", { stock: 3.0 }); // 20
    const caramel = await ingredient(fx, "caramel", { stock: 0.36 }); // 8
    const p = await product(fx, "milkshake");
    await recipe(fx, { productId: p.id }, [
      { itemId: ice.id, qty: "0.160" },
      { itemId: milk.id, qty: "0.150" },
      { itemId: caramel.id, qty: "0.045" },
    ]);

    const a = await atsFor(p.id);
    assert.equal(a.units, 5, "ice cream is the limiting ingredient");
    assert.ok(a.limiting?.includes("ice-cream"), `limiting ingredient is named: ${a.limiting}`);
  });

  test("3 — the exact boundary is inclusive, and survives binary floats", async () => {
    // 0.48 / 0.16 is 2.9999999999999996 in IEEE 754. A café holding exactly
    // three portions is holding three.
    const item = await ingredient(fx, "boundary", { stock: 0.48 });
    const p = await product(fx, "boundary-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.160" }]);

    assert.equal((await atsFor(p.id)).units, 3);
    assert.equal(unitsSupported(0.48, 0.16), 3, "the pure calculation says so too");
  });

  test("4 — a fractional portion truncates rather than rounds", async () => {
    const item = await ingredient(fx, "fractional", { stock: 1.0 });
    const p = await product(fx, "fractional-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.333" }]);

    // 3.003 portions is three cups, not four: a partial cup cannot be sold.
    assert.equal((await atsFor(p.id)).units, 3);
  });

  test("5 — GRAM in the recipe against KG on the shelf", async () => {
    const item = await ingredient(fx, "beans", { stock: 0.8, unit: "KG" });
    const p = await product(fx, "espresso");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "160", unit: "GRAM" }]);

    assert.equal((await atsFor(p.id)).units, 5);
  });

  test("6 — ML in the recipe against LITER on the shelf", async () => {
    const item = await ingredient(fx, "fresh-milk", { stock: 1.5, unit: "LITER" });
    const p = await product(fx, "latte");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "150", unit: "ML" }]);

    assert.equal((await atsFor(p.id)).units, 10);
  });

  test("7 — PIECE counts whole things", async () => {
    const item = await ingredient(fx, "cups", { stock: 7, unit: "PIECE" });
    const p = await product(fx, "double-cup");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "2", unit: "PIECE" }]);

    assert.equal((await atsFor(p.id)).units, 3, "seven cups make three doubles");
  });

  test("8 — a base and an add-on naming the same ingredient add up", async () => {
    // 0.100 in the drink and 0.050 in the extra shot is 0.150 a cup, not two
    // independent 0.100 and 0.050 questions against the same 0.600.
    const milk = await ingredient(fx, "shared-milk", { stock: 0.6 });
    const p = await product(fx, "flat-white");
    await recipe(fx, { productId: p.id }, [{ itemId: milk.id, qty: "0.100" }]);
    const extra = await addOn(fx, "extra-milk", p.id);
    await recipe(fx, { addOnId: extra.id }, [{ itemId: milk.id, qty: "0.050" }]);

    const a = await avail();
    assert.equal(configurationFor(a, p.id, null).units, 6, "the drink alone is six");

    const withAddOn = configurationFor(a, p.id, null, [extra.id]);
    assert.equal(withAddOn.units, 4, "0.600 at 0.150 a cup is four, not six");
  });

  test("9 — a negative balance is zero available, never a negative count", async () => {
    const item = await ingredient(fx, "overdrawn", { stock: -0.5 });
    const p = await product(fx, "overdrawn-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const a = await atsFor(p.id);
    assert.equal(a.state, "EXACT");
    assert.equal(a.units, 0, "the shelf owes stock; it does not owe drinks");
  });

  test("10 — an unpriced ingredient does not change what can be made", async () => {
    // MISSING_COST is a costing gap. We still know the drink takes 0.100 KG,
    // and refusing to count it because nobody priced the bag would be the
    // system inventing a stockout out of an accounting hole.
    const item = await ingredient(fx, "unpriced", { stock: 0.5, costPerUnit: 0 });
    const p = await product(fx, "unpriced-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const a = await atsFor(p.id);
    assert.equal(a.state, "EXACT", "cost and quantity are independent");
    assert.equal(a.units, 5);
  });

  test("11 — NOT_APPLICABLE is not stock-limited, and is not zero", async () => {
    const p = await product(fx, "bottled-water");
    await recipe(fx, { productId: p.id }, [], { notApplicable: true });

    const a = await atsFor(p.id);
    assert.equal(a.state, "NOT_STOCK_TRACKED");
    assert.equal(a.units, null, "a thing that consumes nothing has no count");
  });

  test("12 — an unreadable recipe is UNKNOWN, and never a number", async () => {
    const noRecipe = await product(fx, "unconfigured");
    const a = await atsFor(noRecipe.id);
    assert.equal(a.state, "UNKNOWN");
    assert.equal(a.units, null, "no quantity is invented for a recipe nobody wrote");
    assert.ok(a.issues.includes("MISSING_RECIPE"), `the reason is stated: ${a.issues}`);

    // An empty recipe is the same gap wearing a row.
    const empty = await product(fx, "empty-recipe");
    await recipe(fx, { productId: empty.id }, []);
    const b = await atsFor(empty.id);
    assert.equal(b.state, "UNKNOWN");
    assert.equal(b.units, null);
  });

  test("13 — a known recipe the branch does not stock is NOT_STOCKED, not UNKNOWN", async () => {
    // The distinction is the whole point: the recipe is perfectly readable,
    // so telling the owner "the recipe is missing" would send them to fix the
    // wrong screen. Nothing is invented for the absent shelf either.
    const carried = await ingredient(fx, "carried", { stock: 5 });
    const absent = await unstockedIngredient(fx, "never-carried");
    const p = await product(fx, "half-stocked");
    await recipe(fx, { productId: p.id }, [
      { itemId: carried.id, qty: "0.100" },
      { itemId: absent.id, qty: "0.010" },
    ]);

    const a = await atsFor(p.id);
    assert.equal(a.state, "NOT_STOCKED");
    assert.equal(a.units, null, "no stock is invented for a row that does not exist");
    assert.equal(a.missing.length, 1);
    assert.ok(a.missing[0].includes("never-carried"), `the ingredient is named: ${a.missing}`);
    assert.ok(
      !a.issues.includes("MISSING_RECIPE"),
      "the recipe is fine — the branch configuration is not"
    );
  });

  test("the answer is scoped to the café and its branch", async () => {
    const a = await avail();
    const itemIds = new Set(
      (
        await db.inventoryItem.findMany({
          where: { cafeId: fx.cafeId, branchId: fx.branchId },
          select: { name: true },
        })
      ).map((i) => i.name)
    );
    for (const slot of a.ingredients) {
      assert.ok(itemIds.has(slot.name), `${slot.name} belongs to this branch`);
    }
  });
});
