// ATS-008 — what the cashier is actually handed.
//
// Two things are being pinned here.
//
// The first is the shape of the load. A café has dozens of products and most
// of them have sizes, so "ask the server per card" is not a slow version of
// the right design, it is a different design that falls over at the counter.
// One request returns the whole board: the branch's free quantities once, and
// each configuration's per-unit requirement against them. Everything the cart
// does afterwards is arithmetic the browser already has the numbers for.
//
// The second is the wording. Every state has to be distinguishable in Arabic
// at a glance, because they call for different actions by different people:
//
//   نفد                    the shelf is empty — order more
//   غير محسوب              nobody wrote the recipe — fix the recipe
//   غير مرتبط بالمخزون     this consumes nothing trackable — nothing to do
//   غير مسجل بالمخزون      the branch was never configured — add the item
//
// Collapsing any of them into "0" sends the wrong person to the wrong screen.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import {
  atsCafe, ingredient, product, addOn, recipe, setRecipeQuantity, setMode,
  type AtsCafe,
} from "./helpers/ats";
import { availabilityLabel, cartAdjusted, configurationFor } from "@/lib/available-to-sell";
import type { BranchAvailability } from "@/lib/available-to-sell";

let fx: AtsCafe;

before(async () => {
  await requireServer();
  fx = await atsCafe("ATS008");
  await setMode(fx.cafeId, "STRICT");
});

after(() => teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true }));

const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

async function board() {
  return as<{ availability: BranchAvailability }>(
    fx.manager.email,
    `/api/pos/availability?branchId=${fx.branchId}`
  );
}

describe("ATS-008 the POS availability surface", () => {
  test("48 — one request carries the whole board, configuration by configuration", async () => {
    const milk = await ingredient(fx, "milk", { stock: 2.0 });
    const caramel = await ingredient(fx, "caramel", { stock: 0.06 });
    const p = await product(fx, "latte", { variants: ["صغير", "كبير"] });
    const [small, large] = p.variants;
    await recipe(fx, { productId: p.id, variantId: small.id }, [{ itemId: milk.id, qty: "0.100" }]);
    await recipe(fx, { productId: p.id, variantId: large.id }, [{ itemId: milk.id, qty: "0.200" }]);
    const sauce = await addOn(fx, "caramel", p.id);
    await recipe(fx, { addOnId: sauce.id }, [{ itemId: caramel.id, qty: "0.030" }]);

    const r = await board();
    assert.equal(r.status, 200, r.text);
    const a = r.body.availability;

    assert.equal(a.branchId, fx.branchId);
    assert.equal(a.mode, "STRICT");

    assert.equal(configurationFor(a, p.id, small.id).units, 20);
    assert.equal(configurationFor(a, p.id, large.id).units, 10);
    assert.equal(
      configurationFor(a, p.id, large.id, [sauce.id]).units, 2,
      "and the add-on's own draw travels with it"
    );

    assert.ok(
      a.addOns.some((x) => x.addOnId === sauce.id),
      "add-ons are carried separately so any combination can be summed"
    );
    assert.ok(a.ingredients.length > 0, "the branch's free quantities are sent once");
  });

  test("49 — the board carries no inventory row identifiers", async () => {
    // Product and variant ids are already the POS's own vocabulary. Inventory
    // rows are not: the cashier never names one, so shipping their ids would
    // be leaking storage keys into a screen that has no use for them.
    const item = await ingredient(fx, "hidden", { stock: 1.0 });
    const p = await product(fx, "hidden-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const r = await board();
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(item.id), "the inventory item id is not in the payload");
    assert.ok(
      r.text.includes(item.name),
      "its NAME is, because that is what a shortage message has to say"
    );
    // Slots are positional, so an ingredient is addressed by where it sits in
    // this response and nowhere else.
    for (const c of r.body.availability.configurations) {
      for (const [slot] of c.requirements) {
        assert.equal(typeof slot, "number");
        assert.ok(slot >= 0 && slot < r.body.availability.ingredients.length);
      }
    }
  });

  test("50 — each state reads correctly in Arabic", async () => {
    const stocked = await ingredient(fx, "arabic-stocked", { stock: 1.2 });
    const empty = await ingredient(fx, "arabic-empty", { stock: 0 });
    const many = await product(fx, "arabic-many");
    const one = await product(fx, "arabic-one");
    const none = await product(fx, "arabic-none");
    const unwritten = await product(fx, "arabic-unwritten");
    const notApplicable = await product(fx, "arabic-na");
    await recipe(fx, { productId: many.id }, [{ itemId: stocked.id, qty: "0.100" }]);
    await recipe(fx, { productId: one.id }, [{ itemId: stocked.id, qty: "1.100" }]);
    await recipe(fx, { productId: none.id }, [{ itemId: empty.id, qty: "0.100" }]);
    await recipe(fx, { productId: notApplicable.id }, [], { notApplicable: true });

    const a = (await board()).body.availability;
    const label = (id: string) =>
      availabilityLabel(configurationFor(a, id, null), { mode: "STRICT" });

    assert.equal(label(many.id).text, "متاح: 12");
    assert.equal(label(one.id).text, "متاح: 1");
    assert.equal(label(none.id).text, "نفد");
    assert.equal(label(unwritten.id).text, "غير محسوب");
    assert.equal(label(notApplicable.id).text, "غير مرتبط بالمخزون");

    // A shortage the owner has agreed to sell through is still reported as a
    // shortage — the permission goes in the hint, never in the number.
    const permissive = availabilityLabel(configurationFor(a, none.id, null), {
      mode: "ALLOW_NEGATIVE_STOCK",
    });
    assert.equal(permissive.text, "متاح فعليًا: 0");
    assert.equal(permissive.hint, "السالب مسموح");
    assert.ok(
      !JSON.stringify(permissive).includes("غير محدود"),
      "permission to go negative is never described as unlimited stock"
    );
  });

  test("51 — the count on the card follows the cart", async () => {
    const item = await ingredient(fx, "cart-view", { stock: 0.5 });
    const p = await product(fx, "cart-view-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const a = (await board()).body.availability;
    const sel = { productId: p.id, variantId: null, addOnIds: [] };

    assert.equal(availabilityLabel(cartAdjusted(a, sel, []), { mode: "STRICT" }).text, "متاح: 5");
    assert.equal(
      availabilityLabel(cartAdjusted(a, sel, [{ ...sel, quantity: 2 }]), {
        mode: "STRICT", afterCart: true,
      }).text,
      "متاح بعد الطلب: 3"
    );
    assert.equal(
      availabilityLabel(cartAdjusted(a, sel, [{ ...sel, quantity: 5 }]), {
        mode: "STRICT", afterCart: true,
      }).text,
      "نفد"
    );

    // The screen has to actually ask for this and actually refresh it.
    const page = src("src/app/(app)/pos/page.tsx");
    assert.ok(page.includes("/api/pos/availability"), "the POS loads the board");
    assert.ok(
      /focus/.test(page),
      "and refreshes it when the till comes back to the front"
    );
    const card = src("src/components/pos/product-card.tsx");
    assert.ok(
      card.includes("availabilityLabel"),
      "the card renders the shared label rather than its own wording"
    );
  });

  test("52 — a recipe change shows up on the next load", async () => {
    const item = await ingredient(fx, "refresh", { stock: 0.8 });
    const p = await product(fx, "refresh-drink");
    const rec = await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.160" }]);

    assert.equal(configurationFor((await board()).body.availability, p.id, null).units, 5);

    await setRecipeQuantity(rec.id, item.id, "0.100");

    assert.equal(
      configurationFor((await board()).body.availability, p.id, null).units, 8,
      "no cache holds the old figure — availability is not menu data"
    );
  });

  test("the board is loaded in a bounded number of queries, not one per card", async () => {
    // Twenty products with two sizes each is forty configurations. A per-card
    // design would be forty round trips before the first tap.
    const milk = await ingredient(fx, "bulk-milk", { stock: 50 });
    for (let i = 0; i < 20; i += 1) {
      const p = await product(fx, `bulk-${i}`, { variants: ["صغير", "كبير"] });
      for (const v of p.variants) {
        await recipe(fx, { productId: p.id, variantId: v.id }, [
          { itemId: milk.id, qty: "0.100" },
        ]);
      }
    }

    const started = Date.now();
    const r = await board();
    assert.equal(r.status, 200, r.text);
    const elapsed = Date.now() - started;

    const configs = r.body.availability.configurations.length;
    assert.ok(configs >= 40, `every configuration is on the board (${configs})`);
    assert.ok(
      elapsed < 4000,
      `a whole menu loads in one bounded request (${elapsed}ms for ${configs} configurations)`
    );

    // And the service itself is the only place the arithmetic lives.
    const route = src("src/app/api/pos/availability/route.ts");
    assert.ok(
      !/for\s*\([^)]*\)[^]*?await db\./.test(route),
      "no per-configuration query loop in the route"
    );
  });
});
