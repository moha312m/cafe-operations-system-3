// STOCK-004 — the pre-sale availability check, across a whole cart.
//
// STOCK-003 proved the hole: POST /api/orders sold a drink the branch could
// not make. This suite is about the shape of the answer that replaced it, and
// most of it is about the two ways a naive fix gets it wrong.
//
// The first is arithmetic. Checking each line against the same opening
// balance makes two milkshakes look affordable when only one is — 0.300 KG
// satisfies 0.220 twice if you ask the question twice, and never satisfies
// 0.440 once. So the cart is summed per BRANCH stock row before anything is
// compared, and the same ingredient reached by a base recipe, an add-on and a
// second cart line lands on one total.
//
// The second is conflating two different refusals. A quantity shortage is a
// known number and `allowNegativeStock` is the owner's decision about selling
// past it. A recipe that does not resolve is an unknown consumption, and
// negative stock says nothing about it — it is permission to go below a
// balance we can compute, not permission to sell a draw nobody wrote down.
// The tests hold those apart in both directions: a known shortage passes when
// the café allows it, and a configuration gap does not.
//
// Everything drives the real endpoint. A pre-sale check that lived only in a
// helper would not have caught the original defect, because the helper was
// never called.
//
// What must NOT change, and is re-proved at the bottom: SERVED still deducts,
// still rolls the transition back when the locked balance is short, and still
// refuses to deduct twice. The pre-sale check is an operational answer laid
// on top of that guard, not a replacement for it.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { deductStockForOrder, StockError } from "@/lib/stock-deduction";

let fx: CountCafe;
let categoryId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("STOCK004");
  await db.cafe.update({
    where: { id: fx.cafeId },
    data: { allowNegativeStock: false },
  });
  const category = await db.menuCategory.create({
    data: { cafeId: fx.cafeId, name: `${fx.marker} drinks` },
  });
  categoryId = category.id;
});

after(() => teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true }));

// ───────────────────────────── fixtures ──────────────────────────────

let seq = 0;
/** A distinct name per fixture, so branch matching (name+unit) cannot alias. */
const uniq = (s: string) => `${s}-${(seq += 1)}`;

async function product(name: string, opts: { variants?: string[] } = {}) {
  return db.product.create({
    data: {
      cafeId: fx.cafeId,
      categoryId,
      name: `${fx.marker} ${uniq(name)}`,
      basePrice: "90.00",
      ...(opts.variants
        ? { variants: { create: opts.variants.map((v, i) => ({ name: v, price: 90 + i * 10 })) } }
        : {}),
    },
    include: { variants: true },
  });
}

/** An ingredient stocked at a branch of this café. KG unless stated. */
async function ingredient(name: string, stock: number, opts: { branchId?: string } = {}) {
  return countItem(fx, uniq(name), { stock, costPerUnit: 120, branchId: opts.branchId });
}

type Line = { itemId: string; qty: string; unit?: "KG" | "GRAM" | "ML" };

async function recipeFor(
  scope: { productId?: string; variantId?: string; addOnId?: string },
  lines: Line[],
  opts: { notApplicable?: boolean; appliesToAllVariants?: boolean } = {}
) {
  return db.recipe.create({
    data: {
      cafeId: fx.cafeId,
      ...scope,
      notApplicable: opts.notApplicable ?? false,
      appliesToAllVariants: opts.appliesToAllVariants ?? false,
      items: {
        create: lines.map((l) => ({
          inventoryItemId: l.itemId,
          quantity: l.qty,
          unit: l.unit ?? "KG",
        })),
      },
    },
  });
}

async function addOn(name: string, productId: string) {
  const a = await db.addOn.create({
    data: { cafeId: fx.cafeId, name: `${fx.marker} ${uniq(name)}`, price: "10.00" },
  });
  await db.productAddOn.create({ data: { productId, addOnId: a.id } });
  return a;
}

type OrderItem = {
  productId: string;
  variantId?: string | null;
  quantity: number;
  addOnIds?: string[];
};

/** Place an order over HTTP as the owner, who must name the branch. */
async function order(items: OrderItem[], opts: { collectionMode?: "NOW" | "PENDING"; method?: string } = {}) {
  return as<{ error?: string; order?: { id: string } }>(fx.owner.email, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: fx.branchId,
      type: "TAKEAWAY",
      collectionMode: opts.collectionMode ?? "PENDING",
      ...(opts.method ? { method: opts.method } : {}),
      items: items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId ?? null,
        quantity: i.quantity,
        addOnIds: i.addOnIds ?? [],
      })),
    }),
  });
}

const stockOf = async (id: string) =>
  (await db.inventoryItem.findUniqueOrThrow({ where: { id }, select: { currentStock: true } }))
    .currentStock.toString();

// ──────────────────────── quantity availability ──────────────────────

describe("STOCK-004 quantity availability", () => {
  test("available < required is refused", async () => {
    const ice = await ingredient("ice cream", 0.1);
    const p = await product("shake");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);

    const r = await order([{ productId: p.id, quantity: 1 }]);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /غير متوفرة بالكمية المطلوبة/);
    // The cashier is told the two numbers that matter, not an id.
    assert.match(r.body.error ?? "", /0\.1/);
    assert.match(r.body.error ?? "", /0\.22/);
  });

  test("available exactly equal to required is allowed", async () => {
    // The boundary that a `<=` would get wrong: a branch holding the last
    // exact portion may sell it and finish at zero.
    const ice = await ingredient("ice cream exact", 0.22);
    const p = await product("shake exact");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);

    const r = await order([{ productId: p.id, quantity: 1 }]);
    assert.equal(r.status, 201, r.text);
    // Availability is read-only: the balance only moves at SERVED.
    assert.equal(await stockOf(ice.id), "0.22");
  });

  test("available greater than required is allowed", async () => {
    const ice = await ingredient("ice cream plenty", 5);
    const p = await product("shake plenty");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);

    assert.equal((await order([{ productId: p.id, quantity: 1 }])).status, 201);
  });

  test("a shortage passes when the café has chosen to allow negative stock", async () => {
    // H: a KNOWN quantity shortage is the owner's call, and the system honours
    // it. This is the only door negative stock opens.
    const ice = await ingredient("ice cream negative", 0);
    const p = await product("shake negative");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);

    await db.cafe.update({ where: { id: fx.cafeId }, data: { allowNegativeStock: true } });
    try {
      const r = await order([{ productId: p.id, quantity: 1 }]);
      assert.equal(r.status, 201, r.text);
    } finally {
      await db.cafe.update({ where: { id: fx.cafeId }, data: { allowNegativeStock: false } });
    }
  });
});

// ───────────────────────── cart-level aggregation ────────────────────

describe("STOCK-004 demand is aggregated across the whole cart", () => {
  test("two lines of the same drink are summed, not checked separately", async () => {
    // The exact defect a per-line check hides: each 0.220 fits inside 0.300,
    // so line-by-line both pass; together they need 0.440 and must not.
    const ice = await ingredient("ice cream two lines", 0.3);
    const p = await product("shake two lines");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);

    const r = await order([
      { productId: p.id, quantity: 1 },
      { productId: p.id, quantity: 1 },
    ]);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /0\.44/);
  });

  test("quantity on one line is summed the same way", async () => {
    const ice = await ingredient("ice cream qty2", 0.3);
    const p = await product("shake qty2");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);

    const r = await order([{ productId: p.id, quantity: 2 }]);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /0\.44/);
  });

  test("two different products drawing on one ingredient are summed", async () => {
    const milk = await ingredient("milk shared", 0.5);
    const a = await product("latte shared");
    const b = await product("cappuccino shared");
    await recipeFor({ productId: a.id }, [{ itemId: milk.id, qty: "0.300" }]);
    await recipeFor({ productId: b.id }, [{ itemId: milk.id, qty: "0.300" }]);

    const r = await order([
      { productId: a.id, quantity: 1 },
      { productId: b.id, quantity: 1 },
    ]);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /0\.6/);
  });

  test("an ingredient used by both the base recipe and an add-on is summed", async () => {
    // An extra shot is more of the same beans. If base and add-on are checked
    // as separate demands, 0.018 and 0.018 both fit in 0.030 and the order
    // passes while the shelf only has enough for one of them.
    const beans = await ingredient("beans base plus addon", 0.03);
    const p = await product("espresso base plus addon");
    const shot = await addOn("extra shot", p.id);
    await recipeFor({ productId: p.id }, [{ itemId: beans.id, qty: "0.018" }]);
    await recipeFor({ addOnId: shot.id }, [{ itemId: beans.id, qty: "0.018" }]);

    const r = await order([{ productId: p.id, quantity: 1, addOnIds: [shot.id] }]);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /0\.036/);
  });

  test("add-on demand alone is counted", async () => {
    const syrup = await ingredient("syrup addon only", 0.01);
    const p = await product("latte addon only");
    const vanilla = await addOn("vanilla", p.id);
    // The base consumes nothing trackable, by explicit decision, so the only
    // demand in the cart comes from the add-on.
    await recipeFor({ productId: p.id }, [], { notApplicable: true });
    await recipeFor({ addOnId: vanilla.id }, [{ itemId: syrup.id, qty: "0.030" }]);

    const r = await order([{ productId: p.id, quantity: 1, addOnIds: [vanilla.id] }]);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /0\.03/);
  });
});

// ─────────────────────── recipe resolution gaps ──────────────────────

describe("STOCK-004 a configuration whose consumption is unknown is refused", () => {
  test("a product with no recipe at all is refused", async () => {
    const p = await product("unmapped");
    const r = await order([{ productId: p.id, quantity: 1 }]);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /لا توجد وصفة|مكوناته غير مضبوطة/);
  });

  test("a recipe with no ingredient lines is refused", async () => {
    const p = await product("empty recipe");
    await recipeFor({ productId: p.id }, []);
    const r = await order([{ productId: p.id, quantity: 1 }]);
    assert.equal(r.status, 409, r.text);
  });

  test("a half-resolvable recipe is refused rather than partly counted", async () => {
    // The syrup line asks for its 30 in ML — a volume — against an ingredient
    // stocked by mass, so it cannot be converted and drops out of the
    // consumption entirely. Deducting only the part we understood is how an
    // unresolved ingredient becomes zero by omission and, later, somebody's
    // stock shortage. Both ingredients are plentiful: the refusal here is
    // about the gap, not about a quantity.
    const beans = await ingredient("beans partial", 20);
    const syrup = await ingredient("syrup partial", 20);
    const p = await product("partial");
    await recipeFor({ productId: p.id }, [
      { itemId: beans.id, qty: "0.018" },
      { itemId: syrup.id, qty: "30", unit: "ML" },
    ]);

    const r = await order([{ productId: p.id, quantity: 1 }]);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /وحدة قياس غير متوافقة/);
  });

  test("an explicit NOT_APPLICABLE recipe is allowed", async () => {
    // "This consumes nothing trackable" is a decision somebody recorded. It is
    // the one empty consumption that is an answer rather than a gap.
    const p = await product("bottled water");
    await recipeFor({ productId: p.id }, [], { notApplicable: true });
    assert.equal((await order([{ productId: p.id, quantity: 1 }])).status, 201);
  });

  test("a recipe gap is NOT waved through by allowNegativeStock", async () => {
    // The distinction the whole policy turns on. Negative stock is permission
    // to go below a balance we can compute; it is not permission to sell a
    // consumption nobody has written down.
    const p = await product("unmapped negative");
    await db.cafe.update({ where: { id: fx.cafeId }, data: { allowNegativeStock: true } });
    try {
      const r = await order([{ productId: p.id, quantity: 1 }]);
      assert.equal(r.status, 409, `an unmapped product must not become sellable: ${r.text}`);
      assert.match(r.body.error ?? "", /مكوناته غير مضبوطة/);
    } finally {
      await db.cafe.update({ where: { id: fx.cafeId }, data: { allowNegativeStock: false } });
    }
  });
});

// ───────────────────────── exact configuration ───────────────────────

describe("STOCK-004 the exact sold configuration decides the demand", () => {
  test("a variant's own recipe is used, not the product default", async () => {
    // A large latte is not a small one. The branch holds enough for the
    // default's 0.150 and not for the large's 0.400.
    const milk = await ingredient("milk variant", 0.2);
    const p = await product("latte sizes", { variants: ["small", "large"] });
    const large = p.variants.find((v) => v.name === "large")!;
    const small = p.variants.find((v) => v.name === "small")!;
    await recipeFor({ productId: p.id }, [{ itemId: milk.id, qty: "0.150" }], {
      appliesToAllVariants: true,
    });
    await recipeFor({ productId: p.id, variantId: large.id }, [
      { itemId: milk.id, qty: "0.400" },
    ]);

    const big = await order([{ productId: p.id, variantId: large.id, quantity: 1 }]);
    assert.equal(big.status, 409, `the large's own 0.400 must govern: ${big.text}`);
    assert.match(big.body.error ?? "", /0\.4/);

    // The size that falls back to the covering default still resolves at
    // 0.150 and fits, which is what makes the refusal above about the variant
    // recipe rather than about the ingredient being short for everything.
    const little = await order([{ productId: p.id, variantId: small.id, quantity: 1 }]);
    assert.equal(little.status, 201, little.text);
  });

  test("a product default does not silently stand in for a missing variant recipe", async () => {
    // The old model had no choice but to reuse the default, which is how a
    // large latte came to be costed — and deducted — as a small one. The
    // default only reaches a size when someone declared that it does.
    const milk = await ingredient("milk no cover", 50);
    const p = await product("tea sizes", { variants: ["small", "large"] });
    const large = p.variants.find((v) => v.name === "large")!;
    await recipeFor({ productId: p.id }, [{ itemId: milk.id, qty: "0.150" }], {
      appliesToAllVariants: false,
    });

    const r = await order([{ productId: p.id, variantId: large.id, quantity: 1 }]);
    assert.equal(
      r.status,
      409,
      `an uncovered variant has no recipe and must not borrow the default: ${r.text}`
    );
    assert.match(r.body.error ?? "", /الحجم ده مالوش وصفة|لا توجد وصفة/);
  });

  test("a product default DOES cover a variant when it was declared to", async () => {
    const milk = await ingredient("milk covered", 50);
    const p = await product("mocha sizes", { variants: ["small", "large"] });
    const large = p.variants.find((v) => v.name === "large")!;
    await recipeFor({ productId: p.id }, [{ itemId: milk.id, qty: "0.150" }], {
      appliesToAllVariants: true,
    });

    const r = await order([{ productId: p.id, variantId: large.id, quantity: 1 }]);
    assert.equal(r.status, 201, r.text);
  });
});

// ─────────────────────── branch and café scoping ─────────────────────

describe("STOCK-004 stock is resolved to this branch of this café", () => {
  test("an ingredient the branch does not carry is refused", async () => {
    // The recipe names a café-level ingredient held only at the annex. The
    // shelf that would empty is this branch's, and it has no such row.
    const elsewhere = await ingredient("annex only", 50, { branchId: fx.otherBranchId });
    const p = await product("annex drink");
    await recipeFor({ productId: p.id }, [{ itemId: elsewhere.id, qty: "0.100" }]);

    const r = await order([{ productId: p.id, quantity: 1 }]);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /غير مسجلة في مخزون الفرع/);
  });

  test("another branch's stock cannot satisfy this branch's demand", async () => {
    // Same name and unit at both branches, so the only thing separating them
    // is the branch scope. The annex is full; the till is at main, which is
    // empty, and the order must be refused on main's balance alone.
    const name = uniq("cocoa");
    const here = await countItem(fx, name, { stock: 0, costPerUnit: 120 });
    await countItem(fx, name, { stock: 99, costPerUnit: 120, branchId: fx.otherBranchId });
    const p = await product("cocoa drink");
    await recipeFor({ productId: p.id }, [{ itemId: here.id, qty: "0.100" }]);

    const r = await order([{ productId: p.id, quantity: 1 }]);
    assert.equal(r.status, 409, `annex stock must not make main servable: ${r.text}`);
  });

  test("another café's stock cannot satisfy this café's demand", async () => {
    // A neighbouring tagged café with a plentiful, identically named
    // ingredient. Nothing about it may reach this order.
    const other = await countCafe("STOCK004X");
    try {
      const name = uniq("hazelnut");
      const mine = await countItem(fx, name, { stock: 0, costPerUnit: 120 });
      await db.inventoryItem.create({
        data: {
          cafeId: other.cafeId,
          branchId: other.branchId,
          // Byte-identical name and unit, so only the café scope separates them.
          name: mine.name,
          unit: "KG",
          costPerUnit: 120,
          currentStock: "99",
        },
      });
      const p = await product("hazelnut drink");
      await recipeFor({ productId: p.id }, [{ itemId: mine.id, qty: "0.100" }]);

      const r = await order([{ productId: p.id, quantity: 1 }]);
      assert.equal(r.status, 409, `another café's stock must not be spendable: ${r.text}`);
    } finally {
      await teardownTaggedCafe([other.cafeId]);
    }
  });
});

// ──────────────────────── the refusal is read-only ───────────────────

describe("STOCK-004 a refused order leaves nothing behind", () => {
  test("no order, no payment, no ledger row, no moved balance — even when paying now", async () => {
    // STOCK-003 covers the same contract for a pending-collection order. This
    // one attaches money, because creating an order WITH payment is the path
    // that writes a Payment row, and the refusal has to land before it.
    const ice = await ingredient("ice cream readonly", 0);
    const p = await product("shake readonly");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);

    const before = {
      orders: await db.order.count({ where: { cafeId: fx.cafeId } }),
      payments: await db.payment.count({ where: { cafeId: fx.cafeId } }),
      ledger: await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId } }),
      stock: await stockOf(ice.id),
    };

    const r = await order([{ productId: p.id, quantity: 1 }], {
      collectionMode: "NOW",
      method: "CASH",
    });
    assert.equal(r.status, 409, r.text);

    assert.equal(await db.order.count({ where: { cafeId: fx.cafeId } }), before.orders);
    assert.equal(await db.payment.count({ where: { cafeId: fx.cafeId } }), before.payments);
    assert.equal(
      await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId } }),
      before.ledger,
      "a read-only check must not write the stock ledger"
    );
    assert.equal(await stockOf(ice.id), before.stock);
  });

  test("an allowed order still does not move stock before it is served", async () => {
    // The check is availability, not reservation. Nothing is held.
    const ice = await ingredient("ice cream unreserved", 5);
    const p = await product("shake unreserved");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);

    const r = await order([{ productId: p.id, quantity: 1 }]);
    assert.equal(r.status, 201, r.text);
    assert.equal(await stockOf(ice.id), "5");
    assert.equal(
      await db.inventoryTransaction.count({ where: { inventoryItemId: ice.id } }),
      0
    );
  });
});

// ───────────── the SERVED guard is unchanged and still final ─────────

describe("STOCK-004 the SERVED-time deduction remains the authority", () => {
  /** An order row placed directly, so the SERVED path can be driven alone. */
  async function placedOrder(productId: string, productName: string, quantity = 1) {
    const last = await db.order.aggregate({
      where: { branchId: fx.branchId },
      _max: { orderNumber: true },
    });
    return db.order.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        orderNumber: (last._max.orderNumber ?? 0) + 1,
        type: "TAKEAWAY",
        status: "READY",
        source: "CASHIER_POS",
        subtotal: 90,
        total: 90,
        remainingAmount: 90,
        paymentStatus: "PENDING_COLLECTION",
        createdById: fx.owner.id,
        items: {
          create: [{ productId, productName, unitPrice: 90, quantity, lineTotal: 90 }],
        },
      },
    });
  }

  test("serving still deducts exactly what the recipe consumes", async () => {
    const ice = await ingredient("ice cream served", 1);
    const p = await product("shake served");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);
    const o = await placedOrder(p.id, p.name);

    const result = await db.$transaction((tx) => deductStockForOrder(tx, o.id, fx.owner.id));
    assert.deepEqual(
      result.deducted.map((d) => d.quantity),
      [0.22]
    );
    assert.equal(await stockOf(ice.id), "0.78");
    assert.equal(
      await db.inventoryTransaction.count({ where: { orderId: o.id, type: "USAGE" } }),
      1
    );
  });

  test("an insufficient locked balance at SERVED still rolls the whole thing back", async () => {
    // The window the pre-sale check cannot close: stock consumed by another
    // order between order creation and hand-over. The locked read is what
    // catches it, and the transaction is what makes the failure total.
    const ice = await ingredient("ice cream raced", 0.5);
    const p = await product("shake raced");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.400" }]);
    const o = await placedOrder(p.id, p.name);

    // Somebody else empties the shelf after the sale was accepted.
    await db.inventoryItem.update({
      where: { id: ice.id },
      data: { currentStock: "0.100" },
    });

    await assert.rejects(
      () => db.$transaction((tx) => deductStockForOrder(tx, o.id, fx.owner.id)),
      (e: unknown) => e instanceof StockError && /كمية كافية/.test((e as Error).message)
    );
    assert.equal(await stockOf(ice.id), "0.1", "a refused deduction must move nothing");
    assert.equal(await db.inventoryTransaction.count({ where: { orderId: o.id } }), 0);
  });

  test("stockDeductedAt still makes a second deduction impossible", async () => {
    const ice = await ingredient("ice cream idempotent", 1);
    const p = await product("shake idempotent");
    await recipeFor({ productId: p.id }, [{ itemId: ice.id, qty: "0.220" }]);
    const o = await placedOrder(p.id, p.name);

    await db.$transaction((tx) => deductStockForOrder(tx, o.id, fx.owner.id));
    await db.order.update({ where: { id: o.id }, data: { stockDeductedAt: new Date() } });

    await assert.rejects(
      () => db.$transaction((tx) => deductStockForOrder(tx, o.id, fx.owner.id)),
      (e: unknown) => e instanceof StockError && /من قبل/.test((e as Error).message)
    );
    assert.equal(await stockOf(ice.id), "0.78", "the balance must reflect exactly one deduction");
  });
});
