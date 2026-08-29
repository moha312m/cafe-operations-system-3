// ATS-004 — the count belongs to a CONFIGURATION, not to a product.
//
// A large latte is not a small one. They are sold separately, priced
// separately and — since variant-aware recipes — costed separately, so they
// empty the shelf at different rates and a single number on the product card
// would be wrong for at least one of them. The same is true of an extra shot:
// choosing it changes what the cup draws, and a count that ignores it tells
// the cashier they can sell ten when the caramel supports three.
//
// The other half of this suite is the cart. Availability that only counts
// what is on the SHELF goes stale the moment the cashier taps a product: five
// left, add two, and the card still says five. So the cart's own demand is
// subtracted alongside the open orders' — by the same per-ingredient
// aggregation, because two cart lines drawing the same milk must compete for
// it rather than each seeing the full balance.
//
// The cart arithmetic runs in the browser, on the numbers the batch endpoint
// already sent, so tapping a product does not cost a round trip. It is the
// SAME function the server uses; a second implementation in the client is
// exactly how a POS ends up disagreeing with the order it just posted.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { teardownTaggedCafe } from "./helpers/db";
import {
  atsCafe, ingredient, product, addOn, recipe, setRecipeQuantity,
  type AtsCafe,
} from "./helpers/ats";
import { branchAvailability } from "@/lib/stock-availability";
import { cartAdjusted, configurationFor } from "@/lib/available-to-sell";

let fx: AtsCafe;

before(async () => {
  fx = await atsCafe("ATS004");
});

after(() => teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true }));

const avail = () =>
  branchAvailability({ cafeId: fx.cafeId, branchId: fx.branchId, mode: "STRICT" });

describe("ATS-004 variants, add-ons and the cart", () => {
  test("27 — small and large are counted independently", async () => {
    const milk = await ingredient(fx, "milk", { stock: 2.4 });
    const p = await product(fx, "latte", { variants: ["صغير", "كبير"] });
    const [small, large] = p.variants;
    await recipe(fx, { productId: p.id, variantId: small.id }, [{ itemId: milk.id, qty: "0.100" }]);
    await recipe(fx, { productId: p.id, variantId: large.id }, [{ itemId: milk.id, qty: "0.200" }]);

    const a = await avail();
    assert.equal(configurationFor(a, p.id, small.id).units, 24);
    assert.equal(configurationFor(a, p.id, large.id).units, 12);
  });

  test("28 — editing the large recipe leaves the small count alone", async () => {
    const milk = await ingredient(fx, "milk-b", { stock: 2.4 });
    const p = await product(fx, "flat", { variants: ["صغير", "كبير"] });
    const [small, large] = p.variants;
    await recipe(fx, { productId: p.id, variantId: small.id }, [{ itemId: milk.id, qty: "0.100" }]);
    const bigRecipe = await recipe(fx, { productId: p.id, variantId: large.id }, [
      { itemId: milk.id, qty: "0.200" },
    ]);

    await setRecipeQuantity(bigRecipe.id, milk.id, "0.400");

    const a = await avail();
    assert.equal(configurationFor(a, p.id, small.id).units, 24, "the small size did not change");
    assert.equal(configurationFor(a, p.id, large.id).units, 6);
  });

  test("29 — a product whose sizes differ has no single honest number", async () => {
    const milk = await ingredient(fx, "milk-c", { stock: 1.0 });
    const p = await product(fx, "mixed", { variants: ["صغير", "كبير"] });
    const [small, large] = p.variants;
    await recipe(fx, { productId: p.id, variantId: small.id }, [{ itemId: milk.id, qty: "0.100" }]);
    await recipe(fx, { productId: p.id, variantId: large.id }, [{ itemId: milk.id, qty: "0.250" }]);

    const a = await avail();
    // The product-level entry exists and is explicitly NOT a count: with no
    // size chosen there is nothing to count, and picking either size's number
    // would be a lie about the other.
    const productLevel = configurationFor(a, p.id, null);
    assert.equal(productLevel.state, "PER_VARIANT");
    assert.equal(productLevel.units, null);

    assert.equal(configurationFor(a, p.id, small.id).units, 10);
    assert.equal(configurationFor(a, p.id, large.id).units, 4);
  });

  test("30 — choosing an add-on lowers what the configuration supports", async () => {
    const beans = await ingredient(fx, "beans", { stock: 1.0 });
    const caramel = await ingredient(fx, "caramel", { stock: 0.09 });
    const p = await product(fx, "americano");
    await recipe(fx, { productId: p.id }, [{ itemId: beans.id, qty: "0.100" }]);
    const sauce = await addOn(fx, "caramel-shot", p.id);
    await recipe(fx, { addOnId: sauce.id }, [{ itemId: caramel.id, qty: "0.030" }]);

    const a = await avail();
    assert.equal(configurationFor(a, p.id, null).units, 10, "the drink alone");
    assert.equal(
      configurationFor(a, p.id, null, [sauce.id]).units, 3,
      "with the sauce, the sauce is the limit"
    );
  });

  test("31 — base and add-on drawing the same ingredient are summed, not raced", async () => {
    const milk = await ingredient(fx, "milk-d", { stock: 0.6 });
    const p = await product(fx, "cortado");
    await recipe(fx, { productId: p.id }, [{ itemId: milk.id, qty: "0.100" }]);
    const extra = await addOn(fx, "extra-milk", p.id);
    await recipe(fx, { addOnId: extra.id }, [{ itemId: milk.id, qty: "0.050" }]);

    const a = await avail();
    assert.equal(
      configurationFor(a, p.id, null, [extra.id]).units, 4,
      "0.150 a cup out of 0.600, not 0.100 and 0.050 asked separately"
    );
  });

  test("32 — two add-ons aggregate with each other and with the base", async () => {
    const milk = await ingredient(fx, "milk-e", { stock: 1.0 });
    const syrup = await ingredient(fx, "syrup-e", { stock: 0.5 });
    const p = await product(fx, "double-add");
    await recipe(fx, { productId: p.id }, [{ itemId: milk.id, qty: "0.100" }]);
    const more = await addOn(fx, "more-milk", p.id);
    await recipe(fx, { addOnId: more.id }, [{ itemId: milk.id, qty: "0.100" }]);
    const vanilla = await addOn(fx, "vanilla", p.id);
    await recipe(fx, { addOnId: vanilla.id }, [
      { itemId: milk.id, qty: "0.050" },
      { itemId: syrup.id, qty: "0.020" },
    ]);

    const a = await avail();
    // Milk: 0.100 + 0.100 + 0.050 = 0.250 → 4. Syrup: 0.020 → 25.
    assert.equal(configurationFor(a, p.id, null, [more.id, vanilla.id]).units, 4);
  });

  test("33 — adding to the cart lowers what is left", async () => {
    const item = await ingredient(fx, "cart-a", { stock: 0.5 });
    const p = await product(fx, "cart-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const a = await avail();
    const sel = { productId: p.id, variantId: null, addOnIds: [] };
    assert.equal(cartAdjusted(a, sel, []).units, 5);
    assert.equal(
      cartAdjusted(a, sel, [{ ...sel, quantity: 2 }]).units, 3,
      "five on the shelf, two in the cart, three left to sell"
    );
  });

  test("34 — taking one back out restores it", async () => {
    const item = await ingredient(fx, "cart-b", { stock: 0.5 });
    const p = await product(fx, "cart-drink-b");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const a = await avail();
    const sel = { productId: p.id, variantId: null, addOnIds: [] };
    assert.equal(cartAdjusted(a, sel, [{ ...sel, quantity: 2 }]).units, 3);
    assert.equal(cartAdjusted(a, sel, [{ ...sel, quantity: 1 }]).units, 4);
    assert.equal(cartAdjusted(a, sel, []).units, 5);
  });

  test("35 — two cart lines sharing an ingredient compete for it", async () => {
    const milk = await ingredient(fx, "milk-f", { stock: 1.0 });
    const latte = await product(fx, "latte-f");
    const mocha = await product(fx, "mocha-f");
    await recipe(fx, { productId: latte.id }, [{ itemId: milk.id, qty: "0.200" }]);
    await recipe(fx, { productId: mocha.id }, [{ itemId: milk.id, qty: "0.100" }]);

    const a = await avail();
    const latteSel = { productId: latte.id, variantId: null, addOnIds: [] };
    const mochaSel = { productId: mocha.id, variantId: null, addOnIds: [] };
    const cart = [
      { ...latteSel, quantity: 2 }, // 0.400
      { ...mochaSel, quantity: 3 }, // 0.300
    ];
    // 1.000 − 0.700 = 0.300 free.
    assert.equal(cartAdjusted(a, latteSel, cart).units, 1);
    assert.equal(cartAdjusted(a, mochaSel, cart).units, 3);
  });

  test("36 — a cart line's variant draws that variant's own recipe", async () => {
    const milk = await ingredient(fx, "milk-g", { stock: 1.0 });
    const p = await product(fx, "sized", { variants: ["صغير", "كبير"] });
    const [small, large] = p.variants;
    await recipe(fx, { productId: p.id, variantId: small.id }, [{ itemId: milk.id, qty: "0.100" }]);
    await recipe(fx, { productId: p.id, variantId: large.id }, [{ itemId: milk.id, qty: "0.250" }]);

    const a = await avail();
    const smallSel = { productId: p.id, variantId: small.id, addOnIds: [] };
    const largeSel = { productId: p.id, variantId: large.id, addOnIds: [] };
    // Two larges is 0.500, leaving 0.500.
    const cart = [{ ...largeSel, quantity: 2 }];
    assert.equal(cartAdjusted(a, smallSel, cart).units, 5);
    assert.equal(cartAdjusted(a, largeSel, cart).units, 2);
  });

  test("37 — a cart line's add-on counts against the shelf too", async () => {
    const beans = await ingredient(fx, "beans-h", { stock: 1.0 });
    const caramel = await ingredient(fx, "caramel-h", { stock: 0.1 });
    const p = await product(fx, "caramel-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: beans.id, qty: "0.100" }]);
    const sauce = await addOn(fx, "sauce-h", p.id);
    await recipe(fx, { addOnId: sauce.id }, [{ itemId: caramel.id, qty: "0.020" }]);

    const a = await avail();
    const plain = { productId: p.id, variantId: null, addOnIds: [] };
    const sauced = { productId: p.id, variantId: null, addOnIds: [sauce.id] };

    assert.equal(cartAdjusted(a, sauced, []).units, 5, "caramel supports five");
    assert.equal(
      cartAdjusted(a, sauced, [{ ...sauced, quantity: 3 }]).units, 2,
      "three sauced drinks in the cart take 0.060 of the caramel"
    );
    assert.equal(
      cartAdjusted(a, plain, [{ ...sauced, quantity: 3 }]).units, 7,
      "the plain drink only loses the beans those three took"
    );
  });
});
