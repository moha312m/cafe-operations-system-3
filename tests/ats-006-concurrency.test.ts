// ATS-006 — a number on a screen is not a reservation.
//
// Both tills load availability, both read "5 available", both take an order
// for 4, and both are told yes. Under STRICT the café has now accepted eight
// portions of a five-portion ingredient, and nobody finds out until the
// second order reaches SERVED, hours later, with the drink made and the money
// taken. At that point the locked deduction refuses and the only options left
// are a negative balance or a cancellation of something already handed over.
//
// The pre-sale check cannot fix this on its own, and deliberately does not
// try: it holds no lock, because locking every ingredient row for the length
// of a POS request would serialise the café behind the slowest cashier and
// still not hold anything after the response was sent.
//
// The fix is that ACCEPTANCE takes the capacity. Order creation locks the
// branch rows it needs, re-reads stock and live commitments under those
// locks, applies the café's policy, and either writes the order together with
// its commitment or writes neither. The locks live for the length of one
// transaction and are never held while anybody waits for a cashier.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { atsCafe, ingredient, product, recipe, setMode, type AtsCafe } from "./helpers/ats";

let fx: AtsCafe;

before(async () => {
  await requireServer();
  fx = await atsCafe("ATS006");
  await setMode(fx.cafeId, "STRICT");
});

after(() => teardownTaggedCafe(fx ? [fx.cafeId] : [], [], { disconnect: true }));

/** Two different signed-in accounts, so this is genuinely two tills. */
function order(email: string, productId: string, quantity: number) {
  return as<{ order?: { id: string }; error?: string }>(email, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: fx.branchId, type: "DINE_IN", tableNumber: "1",
      collectionMode: "PENDING",
      items: [{ productId, variantId: null, quantity, addOnIds: [] }],
    }),
  });
}

describe("ATS-006 concurrent acceptance cannot overcommit", () => {
  test("43 — two tills, five portions, four each: at most one is accepted", async () => {
    const item = await ingredient(fx, "contested", { stock: 0.5 });
    const p = await product(fx, "contested-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const [a, b] = await Promise.all([
      order(fx.manager.email, p.id, 4),
      order(fx.owner.email, p.id, 4),
    ]);

    const accepted = [a, b].filter((r) => r.status === 201);
    const refused = [a, b].filter((r) => r.status === 409);
    assert.equal(
      accepted.length, 1,
      `exactly one may take four of five: ${a.status}/${a.text} ${b.status}/${b.text}`
    );
    assert.equal(refused.length, 1, "and the other is told the branch cannot make it");

    // The invariant that actually matters: what is promised never exceeds
    // what exists.
    const committed = await db.orderInventoryCommitment.aggregate({
      where: { inventoryItemId: item.id, releasedAt: null },
      _sum: { quantity: true },
    });
    assert.equal(
      Number(committed._sum.quantity ?? 0), 0.4,
      "0.400 KG promised out of 0.500 — never 0.800"
    );

    const stock = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(Number(stock.currentStock), 0.5, "and nothing has left the shelf yet");
  });

  test("a refused order leaves no order behind, and no half-written commitment", async () => {
    const item = await ingredient(fx, "rollback", { stock: 0.2 });
    const p = await product(fx, "rollback-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const before = await db.order.count({ where: { cafeId: fx.cafeId } });
    const r = await order(fx.manager.email, p.id, 5);
    assert.equal(r.status, 409, r.text);

    assert.equal(
      await db.order.count({ where: { cafeId: fx.cafeId } }), before,
      "a blocked sale writes no order"
    );
    assert.equal(
      await db.orderInventoryCommitment.count({ where: { inventoryItemId: item.id } }), 0,
      "and no commitment"
    );
  });

  test("sequential orders draw down the same capacity", async () => {
    const item = await ingredient(fx, "sequential", { stock: 0.5 });
    const p = await product(fx, "sequential-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    assert.equal((await order(fx.manager.email, p.id, 3)).status, 201);
    const second = await order(fx.manager.email, p.id, 3);
    assert.equal(second.status, 409, "three then three is six out of five");
    assert.equal((await order(fx.manager.email, p.id, 2)).status, 201, "two still fits");
  });

  test("a sale lost to the race leaves the same evidence as one lost to an empty shelf", async () => {
    // The owner reads ORDER_BLOCKED_STOCK_UNAVAILABLE to find the ingredient
    // that is costing them orders, and a refusal that never reached the audit
    // is the one they would never be able to explain. `raced` separates "the
    // shelf was already empty" from "another till took it in between" —
    // identical to the customer, entirely different to fix.
    const item = await ingredient(fx, "audited", { stock: 0.5 });
    const p = await product(fx, "audited-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const before = await db.auditLog.count({
      where: { cafeId: fx.cafeId, action: "ORDER_BLOCKED_STOCK_UNAVAILABLE" },
    });

    const [a, b] = await Promise.all([
      order(fx.manager.email, p.id, 4),
      order(fx.owner.email, p.id, 4),
    ]);
    assert.equal([a, b].filter((r) => r.status === 201).length, 1);
    assert.equal([a, b].filter((r) => r.status === 409).length, 1);

    const rows = await db.auditLog.findMany({
      where: { cafeId: fx.cafeId, action: "ORDER_BLOCKED_STOCK_UNAVAILABLE" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    assert.equal(
      await db.auditLog.count({
        where: { cafeId: fx.cafeId, action: "ORDER_BLOCKED_STOCK_UNAVAILABLE" },
      }),
      before + 1,
      "the refusal is on the record exactly once"
    );
    const details = rows[0].details as { raced?: boolean; reason?: string };
    assert.equal(typeof details.reason, "string", "and says which ingredient");
    assert.equal(
      typeof details.raced, "boolean",
      "and whether it was the shelf or another till"
    );
  });

  test("reading availability writes nothing at all", async () => {
    // A cashier idling on the POS generates a steady trickle of these. An
    // audit row per read would bury the events that actually matter — a
    // blocked sale, an override, a deduction — under thousands of
    // "somebody looked".
    const before = await db.auditLog.count({ where: { cafeId: fx.cafeId } });
    for (let i = 0; i < 5; i += 1) {
      const r = await as(fx.manager.email, `/api/pos/availability?branchId=${fx.branchId}`);
      assert.equal(r.status, 200, r.text);
    }
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId } }), before,
      "reads are reads"
    );
  });

  test("a permissive café still records what it promised", async () => {
    // ALLOW_NEGATIVE_STOCK may accept past the balance — that is the owner's
    // decision — but the commitment is still written, so the displayed
    // physical count keeps telling the truth about the hole.
    await setMode(fx.cafeId, "ALLOW_NEGATIVE_STOCK");
    const item = await ingredient(fx, "permissive", { stock: 0.2 });
    const p = await product(fx, "permissive-drink");
    await recipe(fx, { productId: p.id }, [{ itemId: item.id, qty: "0.100" }]);

    const [a, b] = await Promise.all([
      order(fx.manager.email, p.id, 2),
      order(fx.owner.email, p.id, 2),
    ]);
    assert.equal(a.status, 201, a.text);
    assert.equal(b.status, 201, b.text);

    const committed = await db.orderInventoryCommitment.aggregate({
      where: { inventoryItemId: item.id, releasedAt: null },
      _sum: { quantity: true },
    });
    assert.equal(Number(committed._sum.quantity ?? 0), 0.4, "0.400 promised against 0.200 held");
    await setMode(fx.cafeId, "STRICT");
  });
});
