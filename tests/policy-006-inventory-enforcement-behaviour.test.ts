// POLICY-006 — the three enforcement modes, driven through the real POS.
//
// The café chooses how hard the till enforces inventory, and the choice has to
// mean three different things rather than two:
//
//   STRICT                refuse what we cannot make
//   ALLOW_NEGATIVE_STOCK  a KNOWN shortage is the owner's call; the recipe must
//                         still be readable
//   OVERRIDE_ALL          sell anyway, and be honest that consumption is
//                         partly unknown
//
// The line between the second and third is the whole reason a boolean was not
// enough. Going below a balance we can COMPUTE is a priced risk the owner can
// accept. Selling against a recipe nobody has written is an unknown draw on the
// shelf, and it is what leaves theoretical stock that has never met a count.
// Every mode is therefore tested against BOTH a quantity shortage and a recipe
// gap, because a mode that confuses them would still pass a test of either one
// alone.
//
// Driven over HTTP throughout. A policy that only held in a helper would not
// have caught the original defect, and the thing under test is what the server
// does when a cashier presses the button.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { deductStockForOrder, StockError } from "@/lib/stock-deduction";
import type { InventoryEnforcementMode } from "@prisma/client";

let fx: CountCafe;
let categoryId: string;
const extraCafes: string[] = [];

before(async () => {
  await requireServer();
  fx = await countCafe("POL006");
  const category = await db.menuCategory.create({
    data: { cafeId: fx.cafeId, name: `${fx.marker} drinks` },
  });
  categoryId = category.id;
});

after(() =>
  teardownTaggedCafe([...(fx ? [fx.cafeId] : []), ...extraCafes], [], { disconnect: true })
);

// ───────────────────────────── fixtures ──────────────────────────────

let seq = 0;
const uniq = (s: string) => `${s}-${(seq += 1)}`;

/** Set the café's persisted policy. This is the only way a mode is chosen. */
async function setMode(mode: InventoryEnforcementMode, cafeId = fx.cafeId) {
  await db.cafeSettings.upsert({
    where: { cafeId },
    create: { cafeId, inventoryEnforcementMode: mode },
    update: { inventoryEnforcementMode: mode },
  });
}

async function product(name: string) {
  return db.product.create({
    data: {
      cafeId: fx.cafeId, categoryId,
      name: `${fx.marker} ${uniq(name)}`, basePrice: "90.00",
    },
  });
}

async function ingredient(name: string, stock: number) {
  return countItem(fx, uniq(name), { stock, costPerUnit: 120 });
}

async function recipeFor(
  productId: string,
  lines: { itemId: string; qty: string; unit?: "KG" | "ML" }[],
  opts: { notApplicable?: boolean } = {}
) {
  return db.recipe.create({
    data: {
      cafeId: fx.cafeId, productId,
      notApplicable: opts.notApplicable ?? false,
      items: {
        create: lines.map((l) => ({
          inventoryItemId: l.itemId, quantity: l.qty, unit: l.unit ?? "KG",
        })),
      },
    },
  });
}

type OrderResult = {
  status: number;
  body: { error?: string; warnings?: string[]; inventoryPolicy?: string; order?: { id: string; orderNumber: number } };
  text: string;
};

async function order(productId: string, quantity = 1): Promise<OrderResult> {
  return as(fx.owner.email, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: fx.branchId, type: "TAKEAWAY", collectionMode: "PENDING",
      items: [{ productId, quantity, addOnIds: [] }],
    }),
  });
}

const stockOf = async (id: string) =>
  (await db.inventoryItem.findUniqueOrThrow({ where: { id }, select: { currentStock: true } }))
    .currentStock.toString();

/** Drive the real SERVED transition for an order created over HTTP. */
async function serve(orderId: string) {
  return db.$transaction((tx) => deductStockForOrder(tx, orderId, fx.owner.id));
}

const overrideAudits = (orderId: string) =>
  db.auditLog.count({
    where: { cafeId: fx.cafeId, action: "ORDER_INVENTORY_POLICY_OVERRIDE", entityId: orderId },
  });

// ───────────────────────────── MODE 1 · STRICT ───────────────────────

describe("POLICY-006 STRICT refuses what the branch cannot make", () => {
  before(() => setMode("STRICT"));

  test("sufficient stock is allowed", async () => {
    const ice = await ingredient("ice", 5);
    const p = await product("shake");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.220" }]);
    assert.equal((await order(p.id)).status, 201);
  });

  test("exactly enough is allowed — the boundary a `<=` would get wrong", async () => {
    const ice = await ingredient("ice exact", 0.22);
    const p = await product("shake exact");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.220" }]);
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    assert.equal(await stockOf(ice.id), "0.22", "availability is read-only");
  });

  test("a shortage is refused with 409", async () => {
    const ice = await ingredient("ice short", 0.1);
    const p = await product("shake short");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.220" }]);
    const r = await order(p.id);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /غير متوفرة بالكمية المطلوبة/);
  });

  test("a missing recipe is refused", async () => {
    const p = await product("unmapped");
    const r = await order(p.id);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /مكوناته غير مضبوطة/);
  });

  test("an incomplete recipe is refused", async () => {
    // The syrup line asks for its 30 in ML against an ingredient stocked by
    // mass, so it cannot be converted and drops out of the consumption.
    const beans = await ingredient("beans partial", 20);
    const syrup = await ingredient("syrup partial", 20);
    const p = await product("partial");
    await recipeFor(p.id, [
      { itemId: beans.id, qty: "0.018" },
      { itemId: syrup.id, qty: "30", unit: "ML" },
    ]);
    const r = await order(p.id);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /وحدة قياس غير متوافقة/);
  });

  test("an ingredient the branch does not carry is refused", async () => {
    const elsewhere = await countItem(fx, uniq("annex only"), {
      stock: 50, costPerUnit: 120, branchId: fx.otherBranchId,
    });
    const p = await product("annex drink");
    await recipeFor(p.id, [{ itemId: elsewhere.id, qty: "0.100" }]);
    const r = await order(p.id);
    assert.equal(r.status, 409, r.text);
    assert.match(r.body.error ?? "", /غير مسجلة في مخزون الفرع/);
  });

  test("an explicit NOT_APPLICABLE recipe is allowed", async () => {
    const p = await product("bottled water");
    await recipeFor(p.id, [], { notApplicable: true });
    assert.equal((await order(p.id)).status, 201);
  });

  test("MISSING_COST alone does not block — cost is not quantity", async () => {
    // The distinction the whole design turns on. The quantity is fully known;
    // only the money is not. Blocking here would make a sellable drink
    // permanently unsellable for a bookkeeping reason.
    const ice = await countItem(fx, uniq("uncosted"), { stock: 5, costPerUnit: 0 });
    const p = await product("uncosted drink");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.100" }]);
    const r = await order(p.id);
    assert.equal(r.status, 201, `a missing cost must never block a sale: ${r.text}`);
  });
});

// ──────────────────── MODE 2 · ALLOW_NEGATIVE_STOCK ──────────────────

describe("POLICY-006 ALLOW_NEGATIVE_STOCK accepts a known shortage only", () => {
  before(() => setMode("ALLOW_NEGATIVE_STOCK"));

  test("a shortage is allowed, and warns rather than blocking", async () => {
    const ice = await ingredient("ice neg", 0.1);
    const p = await product("shake neg");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.160" }]);
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    assert.ok(r.body.warnings?.length, "the cashier must be told stock was short");
    assert.match(r.body.warnings!.join(" "), /رصيد سالب/);
  });

  test("SERVED drives the balance negative by exactly the shortfall", async () => {
    const ice = await ingredient("ice neg served", 0.1);
    const p = await product("shake neg served");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.160" }]);
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);

    await serve(r.body.order!.id);
    // 0.100 − 0.160 = −0.060, the figure from the brief.
    assert.equal(await stockOf(ice.id), "-0.06");
  });

  test("a missing recipe is STILL refused", async () => {
    // The line this mode exists to hold. Negative stock is permission to go
    // below a balance we can compute — not permission to sell an unknown draw.
    const p = await product("unmapped neg");
    const r = await order(p.id);
    assert.equal(r.status, 409, `an unmapped product must not become sellable: ${r.text}`);
    assert.match(r.body.error ?? "", /مكوناته غير مضبوطة/);
  });

  test("an incomplete recipe is STILL refused", async () => {
    const beans = await ingredient("beans neg", 20);
    const syrup = await ingredient("syrup neg", 20);
    const p = await product("partial neg");
    await recipeFor(p.id, [
      { itemId: beans.id, qty: "0.018" },
      { itemId: syrup.id, qty: "30", unit: "ML" },
    ]);
    assert.equal((await order(p.id)).status, 409);
  });

  test("a missing branch inventory row is STILL refused", async () => {
    const elsewhere = await countItem(fx, uniq("annex neg"), {
      stock: 50, costPerUnit: 120, branchId: fx.otherBranchId,
    });
    const p = await product("annex neg");
    await recipeFor(p.id, [{ itemId: elsewhere.id, qty: "0.100" }]);
    assert.equal((await order(p.id)).status, 409);
  });

  test("NOT_APPLICABLE is allowed and is not treated as an override", async () => {
    const p = await product("water neg");
    await recipeFor(p.id, [], { notApplicable: true });
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    assert.equal(await overrideAudits(r.body.order!.id), 0);
  });
});

// ───────────────────────── MODE 3 · OVERRIDE_ALL ─────────────────────

describe("POLICY-006 OVERRIDE_ALL sells anyway, and says so", () => {
  before(() => setMode("OVERRIDE_ALL"));

  test("a shortage is allowed and SERVED goes negative", async () => {
    const ice = await ingredient("ice over", 0.1);
    const p = await product("shake over");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.160" }]);
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    await serve(r.body.order!.id);
    assert.equal(await stockOf(ice.id), "-0.06");
  });

  test("a missing recipe is allowed, with a non-blocking warning", async () => {
    const p = await product("unmapped over");
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    assert.match(
      (r.body.warnings ?? []).join(" "),
      /تم السماح بالبيع حسب سياسة المنشأة/,
      "the cashier must see that policy, not stock, let this through"
    );
    assert.equal(r.body.inventoryPolicy, "OVERRIDE_ALL");
  });

  test("an incomplete recipe is allowed", async () => {
    const beans = await ingredient("beans over", 20);
    const syrup = await ingredient("syrup over", 20);
    const p = await product("partial over");
    await recipeFor(p.id, [
      { itemId: beans.id, qty: "0.018" },
      { itemId: syrup.id, qty: "30", unit: "ML" },
    ]);
    assert.equal((await order(p.id)).status, 201);
  });

  test("what CAN be resolved is still deducted; what cannot is not invented", async () => {
    // The honest half of the override. The beans line resolves and must come
    // off the shelf. The syrup line does not convert, so it contributes
    // nothing — and nothing is guessed in its place.
    const beans = await ingredient("beans deducted", 5);
    const syrup = await ingredient("syrup untouched", 5);
    const p = await product("partial deducted");
    await recipeFor(p.id, [
      { itemId: beans.id, qty: "0.018" },
      { itemId: syrup.id, qty: "30", unit: "ML" },
    ]);
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);

    const result = await serve(r.body.order!.id);
    assert.equal(await stockOf(beans.id), "4.982", "the resolvable line is deducted");
    assert.equal(await stockOf(syrup.id), "5", "the unresolvable line is NOT invented");
    assert.ok(
      result.configurationsWithIncompleteRecipe.length > 0,
      "the gap must be reported, not absorbed"
    );
  });

  test("the override is audited, naming the order, the mode and why", async () => {
    const p = await product("unmapped audited");
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);

    const row = await db.auditLog.findFirst({
      where: {
        cafeId: fx.cafeId,
        action: "ORDER_INVENTORY_POLICY_OVERRIDE",
        entityId: r.body.order!.id,
      },
    });
    assert.ok(row, "an override must leave a record");
    const d = row!.details as Record<string, unknown>;
    assert.equal(d.mode, "OVERRIDE_ALL");
    assert.ok(Array.isArray(d.reasonCategories) && (d.reasonCategories as string[]).length > 0);
    assert.equal(d.consumptionPartial, true, "the record must admit consumption is incomplete");
    assert.ok(Array.isArray(d.recipeGaps) && (d.recipeGaps as unknown[]).length > 0);
  });

  test("NOT_APPLICABLE produces NO override audit — it is not an override", async () => {
    // A recorded decision that something consumes nothing trackable is an
    // answer, not a gap. Auditing it as an override would bury the real ones.
    const p = await product("water over");
    await recipeFor(p.id, [], { notApplicable: true });
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    assert.equal(await overrideAudits(r.body.order!.id), 0);
    assert.equal(r.body.warnings, undefined, "nothing was waived, so nothing to warn about");
  });

  test("a fully-stocked sale produces no override audit either", async () => {
    const ice = await ingredient("ice plenty over", 9);
    const p = await product("shake plenty over");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.220" }]);
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    assert.equal(await overrideAudits(r.body.order!.id), 0);
  });
});

// ──────────────────── security / multi-tenant ────────────────────────

describe("POLICY-006 the policy comes from the café, never from the caller", () => {
  test("a request body cannot choose its own enforcement mode", async () => {
    await setMode("STRICT");
    const ice = await ingredient("ice tamper", 0);
    const p = await product("shake tamper");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.220" }]);

    // Every shape a client might try. All are ignored: the server reads the
    // café's persisted policy and nothing else.
    for (const body of [
      { inventoryEnforcementMode: "OVERRIDE_ALL" },
      { mode: "OVERRIDE_ALL" },
      { allowNegativeStock: true },
      { enforcement: "OVERRIDE_ALL", overrideStock: true },
    ]) {
      const r = await as<{ error?: string }>(fx.owner.email, "/api/orders", {
        method: "POST",
        body: JSON.stringify({
          branchId: fx.branchId, type: "TAKEAWAY", collectionMode: "PENDING",
          items: [{ productId: p.id, quantity: 1, addOnIds: [] }],
          ...body,
        }),
      });
      assert.equal(
        r.status, 409,
        `a till must not be able to relax enforcement: ${JSON.stringify(body)} -> ${r.text}`
      );
    }
  });

  test("another café's OVERRIDE_ALL does not leak into this one", async () => {
    // Policy is per-café. A neighbour running wide open must not change what
    // this café will sell.
    const other = await countCafe("POL006X");
    extraCafes.push(other.cafeId);
    await setMode("OVERRIDE_ALL", other.cafeId);
    await setMode("STRICT", fx.cafeId);

    const p = await product("unmapped tenant");
    assert.equal((await order(p.id)).status, 409);
  });

  test("another branch's stock cannot satisfy this branch's requirement", async () => {
    await setMode("STRICT");
    const name = uniq("cocoa");
    const here = await countItem(fx, name, { stock: 0, costPerUnit: 120 });
    await countItem(fx, name, { stock: 99, costPerUnit: 120, branchId: fx.otherBranchId });
    const p = await product("cocoa drink");
    await recipeFor(p.id, [{ itemId: here.id, qty: "0.100" }]);
    assert.equal((await order(p.id)).status, 409);
  });
});

// ─────────────────────────── regression ──────────────────────────────

describe("POLICY-006 the SERVED guard is unchanged", () => {
  test("STRICT still fails safely when stock is short at hand-over", async () => {
    await setMode("STRICT");
    const ice = await ingredient("ice raced", 0.5);
    const p = await product("shake raced");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.400" }]);
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);

    // Somebody else empties the shelf between the sale and the hand-over.
    await db.inventoryItem.update({ where: { id: ice.id }, data: { currentStock: "0.100" } });

    await assert.rejects(
      () => serve(r.body.order!.id),
      (e: unknown) => e instanceof StockError && /كمية كافية/.test((e as Error).message)
    );
    assert.equal(await stockOf(ice.id), "0.1", "a refused deduction moves nothing");
  });

  test("stockDeductedAt still makes a second deduction impossible", async () => {
    await setMode("STRICT");
    const ice = await ingredient("ice idem", 5);
    const p = await product("shake idem");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.220" }]);
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);

    await serve(r.body.order!.id);
    await db.order.update({
      where: { id: r.body.order!.id }, data: { stockDeductedAt: new Date() },
    });
    await assert.rejects(
      () => serve(r.body.order!.id),
      (e: unknown) => e instanceof StockError && /من قبل/.test((e as Error).message)
    );
    assert.equal(await stockOf(ice.id), "4.78", "exactly one deduction");
  });

  test("a blocked order still creates nothing at all", async () => {
    await setMode("STRICT");
    const ice = await ingredient("ice nothing", 0);
    const p = await product("shake nothing");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.220" }]);

    const before = {
      orders: await db.order.count({ where: { cafeId: fx.cafeId } }),
      payments: await db.payment.count({ where: { cafeId: fx.cafeId } }),
      ledger: await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId } }),
    };
    const r = await as(fx.owner.email, "/api/orders", {
      method: "POST",
      body: JSON.stringify({
        branchId: fx.branchId, type: "TAKEAWAY",
        collectionMode: "NOW", method: "CASH",
        items: [{ productId: p.id, quantity: 1, addOnIds: [] }],
      }),
    });
    assert.equal(r.status, 409, r.text);
    assert.equal(await db.order.count({ where: { cafeId: fx.cafeId } }), before.orders);
    assert.equal(await db.payment.count({ where: { cafeId: fx.cafeId } }), before.payments);
    assert.equal(
      await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId } }), before.ledger
    );
    assert.equal(await stockOf(ice.id), "0");
  });
});
