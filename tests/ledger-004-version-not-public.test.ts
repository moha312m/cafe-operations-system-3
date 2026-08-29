// LEDGER-004 — the version counters are internal, and the boundary is the
// HTTP response, not the database client.
//
// `InventoryItem.ledgerVersion` and `InventoryTransaction.itemVersion` have
// to be readable by the services that maintain them: the guarded writer
// advances the counter, the count point reads it under a lock, and the
// rebase replay sums everything above it. Hiding them at the Prisma client
// would take that away from the code that most needs it.
//
// They must NOT reach a client. Two independent reasons:
//
//   • They are BigInt, and `JSON.stringify` throws on BigInt. A route that
//     returns one of these rows whole does not render a slightly wrong
//     response — it returns 500. Five routes did.
//
//   • They are not part of any API contract. The number only means anything
//     to someone holding the item's row lock; published, it invites a reader
//     to reason about ordering without one.
//
// So the rule is directional, and this suite asserts both directions:
//
//     database / internal service   →  available
//     HTTP response                 →  absent
//
// The absence checks scan the whole response body recursively rather than
// looking at the top level, because the field that actually escaped in
// review was nested two levels down, inside a recipe's ingredient.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, fixture, tag, type Fixture } from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";
import { applyStockMutation, lockItemForUpdate, ledgerDeltaAbove } from "@/lib/ledger";

const MARKER = tag("LEDGER004");
const OWNER = "owner@demo.com";
let fx: Fixture;
const itemIds: string[] = [];

before(async () => {
  fx = await fixture();
  await requireServer();
  await login(OWNER, "owner1234");
});

after(async () => {
  if (itemIds.length) {
    await db.inventoryTransaction.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  }
  await db.$disconnect();
});

async function ingredient(name: string, stock: string | number = 10) {
  const item = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      name: `${MARKER} ${name}`, unit: "KG", costPerUnit: 450, currentStock: stock,
    },
  });
  itemIds.push(item.id);
  return item;
}

/** Every JSON path at which `key` appears anywhere in the body. */
function pathsTo(value: unknown, key: string, at = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => pathsTo(v, key, `${at}[${i}]`));
  }
  if (value && typeof value === "object") {
    const found: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (k === key) found.push(`${at}.${k}`);
      found.push(...pathsTo(v, key, `${at}.${k}`));
    }
    return found;
  }
  return [];
}

/** Assert a response both succeeded and carries neither internal counter. */
function assertClean(label: string, r: { status: number; text: string }) {
  assert.ok(
    r.status < 300,
    `${label} must serialize successfully — a BigInt in the payload returns 500, not a bad field: ${r.text.slice(0, 300)}`
  );
  const body = JSON.parse(r.text);
  assert.deepEqual(pathsTo(body, "ledgerVersion"), [], `${label} leaked ledgerVersion`);
  assert.deepEqual(pathsTo(body, "itemVersion"), [], `${label} leaked itemVersion`);
}

describe("LEDGER-004 internal version fields never reach a client", () => {
  test("the path scanner finds a nested field, so the assertions below can fail", () => {
    // Guard against a vacuous check: if `pathsTo` could not see through
    // nesting, every assertion in this suite would pass unconditionally.
    const shaped = { recipe: { items: [{ inventoryItem: { ledgerVersion: 3 } }] } };
    assert.deepEqual(
      pathsTo(shaped, "ledgerVersion"),
      ["$.recipe.items[0].inventoryItem.ledgerVersion"]
    );
    assert.deepEqual(pathsTo({ a: 1 }, "ledgerVersion"), []);
  });

  test("the movement route serializes, and hides the counter", async () => {
    const item = await ingredient("movement", "12.018");
    const r = await as(OWNER, `/api/inventory/${item.id}/movement`, {
      method: "POST",
      body: JSON.stringify({ type: "WASTE", quantity: 0.018, note: MARKER }),
    });
    assertClean("POST /api/inventory/[id]/movement", r);
  });

  test("the item update route serializes, and hides the counter", async () => {
    const item = await ingredient("update");
    const r = await as(OWNER, `/api/inventory/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ minimumStock: 2 }),
    });
    assertClean("PATCH /api/inventory/[id]", r);
  });

  test("the inventory list and report hide both counters", async () => {
    await ingredient("listed");
    assertClean("GET /api/inventory", await as(OWNER, "/api/inventory"));
    // The report returns whole ledger rows, which is where `itemVersion`
    // rides out if nothing strips it.
    assertClean("GET /api/inventory/report", await as(OWNER, "/api/inventory/report"));
  });

  test("the recipe routes hide the counter nested inside an ingredient", async () => {
    // The nesting is the point: `ledgerVersion` here is two levels below the
    // response root, inside a recipe item's inventoryItem.
    const recipe = await db.recipe.findFirst({
      where: { items: { some: {} } },
      select: { id: true, productId: true },
    });
    assert.ok(recipe, "this café needs at least one recipe with ingredients");

    assertClean(`GET /api/recipes/${recipe.id}`, await as(OWNER, `/api/recipes/${recipe.id}`));
    assertClean(
      `GET /api/products/${recipe.productId}/recipe`,
      await as(OWNER, `/api/products/${recipe.productId}/recipe`)
    );
  });

  test("internal service code can still read and use the version fields", async () => {
    // The other direction. If this ever fails, the redaction has been pushed
    // down into the client and the guarded writer has lost the value the
    // whole invariant is built on.
    const item = await ingredient("internal", 5);

    const viaPrisma = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(
      typeof viaPrisma.ledgerVersion, "bigint",
      "ledgerVersion must remain readable through the ordinary Prisma client"
    );

    const applied = await db.$transaction(async (tx) => {
      const locked = await lockItemForUpdate(tx, item.id);
      assert.equal(typeof locked.ledgerVersion, "bigint", "the locked read must carry the version");
      return applyStockMutation(tx, {
        inventoryItemId: item.id, cafeId: fx.cafeId, branchId: fx.branchId,
        type: "ADJUSTMENT", quantity: 1,
      });
    });
    assert.equal(applied.itemVersion, viaPrisma.ledgerVersion + BigInt(1));

    const row = await db.inventoryTransaction.findUniqueOrThrow({
      where: { id: applied.transactionId },
    });
    assert.equal(row.itemVersion, applied.itemVersion, "the ledger row's stamp is readable too");

    const above = await ledgerDeltaAbove(db, item.id, viaPrisma.ledgerVersion);
    assert.equal(above.delta, 1, "and the replay can still sum by version");
  });

  test("the Prisma client applies no global omit to either field", async () => {
    // Asserted structurally, not just behaviourally: a future `omit` in
    // src/lib/db.ts would take these fields away from the services that
    // maintain them, and the failure would surface far from its cause.
    const item = await ingredient("no-omit");
    const keys = Object.keys(await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } }));
    assert.ok(keys.includes("ledgerVersion"), "a default item read must include ledgerVersion");
  });
});
