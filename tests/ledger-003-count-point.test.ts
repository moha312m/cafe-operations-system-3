// LEDGER-003 — fix the shelf at a version the ledger cannot slip past.
//
// A count point is the instant a physical count is measured against. It is
// not a special operation: it takes the same FOR UPDATE lock as every
// mutation, so it cannot interleave with one.
//
// The soundness argument in one line: a concurrent mutator must take that
// same lock to assign version N+1, so at capture time every version at or
// below the captured one is committed AND reflected in the `currentStock`
// read under the same lock. There is no numbered-but-invisible row.
//
// That last sentence is the whole reason the rejected sequence design was
// rejected, and test 6 is what would have failed against it: with
// `nextval()`, a transaction can hold a LOW number and commit AFTER a
// capture that already read past it, so a movement can be simultaneously
// below the cursor and absent from the balance — lost, and later read as
// somebody's shortage.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, fixture, tag, type Fixture } from "./helpers/db";
import { captureCountPoint } from "@/lib/count-point";
import { applyStockMutation, ledgerDeltaAbove } from "@/lib/ledger";

const MARKER = tag("LEDGER003");
let fx: Fixture;
const itemIds: string[] = [];

before(async () => { fx = await fixture(); });

after(async () => {
  if (itemIds.length) {
    await db.inventoryTransaction.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  }
  await db.$disconnect();
});

async function ingredient(name: string, stock: string | number = 0) {
  const item = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      name: `${MARKER} ${name}`, unit: "KG", costPerUnit: 450, currentStock: stock,
    },
  });
  itemIds.push(item.id);
  return item;
}

/** One movement, in its own transaction, through the guarded writer. */
function mutate(itemId: string, quantity: number) {
  return db.$transaction((tx) =>
    applyStockMutation(tx, {
      inventoryItemId: itemId, cafeId: fx.cafeId, branchId: fx.branchId,
      type: "ADJUSTMENT", quantity, allowNegative: true,
    })
  );
}

const stockOf = async (id: string) =>
  Number((await db.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock);

describe("LEDGER-003 count-point capture", () => {
  test("capture on a quiet item returns its stock and its current version", async () => {
    const item = await ingredient("quiet", "7.5");
    const r = await mutate(item.id, 0.5);

    const point = await db.$transaction((tx) => captureCountPoint(tx, item.id));
    assert.equal(point.expectedQuantity, 8);
    assert.equal(point.itemVersion, r.itemVersion);
    assert.equal(point.inventoryItemId, item.id);
    assert.ok(point.capturedAt instanceof Date);
  });

  test("a movement committed before capture is included, and sits at or below the cursor", async () => {
    const item = await ingredient("before", 10);
    const r = await mutate(item.id, 2);

    const point = await db.$transaction((tx) => captureCountPoint(tx, item.id));
    assert.equal(point.expectedQuantity, 12, "the movement is in the balance");
    assert.ok(r.itemVersion <= point.itemVersion, "and at or below the cursor");
  });

  test("a movement committed after capture is excluded, and sits above the cursor", async () => {
    const item = await ingredient("after", 10);
    const point = await db.$transaction((tx) => captureCountPoint(tx, item.id));
    const r = await mutate(item.id, 3);

    assert.equal(point.expectedQuantity, 10, "the later movement is not in the captured figure");
    assert.ok(r.itemVersion > point.itemVersion, "and strictly above the cursor");
    assert.equal(await stockOf(item.id), 13, "while the shelf itself moved on");
  });

  test("two captures in one transaction return the same version", async () => {
    const item = await ingredient("stable", 4);
    const [a, b] = await db.$transaction(async (tx) => [
      await captureCountPoint(tx, item.id),
      await captureCountPoint(tx, item.id),
    ]);
    assert.equal(a.itemVersion, b.itemVersion, "the lock is held; nothing can move between them");
    assert.equal(a.expectedQuantity, b.expectedQuantity);
  });

  test("conservation under load: expected + everything above the cursor === currentStock", async () => {
    // Thirty concurrent 18 g movements racing one capture. Whatever
    // interleaving the database chooses, the identity must hold exactly —
    // every movement is either in the captured figure or above the cursor,
    // and never both, and never neither.
    const item = await ingredient("race", 0);

    const capture = db.$transaction((tx) => captureCountPoint(tx, item.id));
    const movements = Array.from({ length: 30 }, () => mutate(item.id, 0.018));
    const [point] = await Promise.all([capture, ...movements]);

    const above = await ledgerDeltaAbove(db, item.id, point.itemVersion);
    const final = await stockOf(item.id);

    assert.equal(
      Math.round((point.expectedQuantity + above.delta) * 1000) / 1000, final,
      "the captured balance plus everything above the cursor must equal the shelf, to the gram"
    );
    assert.equal(final, 0.54, "thirty lots of 18 g is 540 g");
  });

  test("no numbered-but-invisible row: replaying the ledger to the cursor reproduces the captured figure", async () => {
    // THE test the rejected sequence design fails. It replays from zero and
    // sums every row at or below the captured version; if any committed-late
    // row had been numbered below the cursor while being absent from the
    // captured balance, these two numbers would differ.
    const item = await ingredient("replay", 0);

    const capture = db.$transaction((tx) => captureCountPoint(tx, item.id));
    const movements = Array.from({ length: 12 }, (_, i) => mutate(item.id, i % 2 ? 0.25 : -0.1));
    const [point] = await Promise.all([capture, ...movements]);

    const rows = await db.inventoryTransaction.findMany({
      where: { inventoryItemId: item.id },
      omit: { itemVersion: false },
    });
    const atOrBelow = rows
      .filter((r) => r.itemVersion <= point.itemVersion)
      .reduce((sum, r) => sum + Number(r.quantity), 0);

    assert.equal(
      Math.round(atOrBelow * 1000) / 1000, point.expectedQuantity,
      "every row at or below the cursor must already be in the captured balance"
    );
  });

  test("a rolled-back movement racing a capture affects neither the stock nor the version", async () => {
    const item = await ingredient("rollback", 5);

    await assert.rejects(() =>
      db.$transaction(async (tx) => {
        await applyStockMutation(tx, {
          inventoryItemId: item.id, cafeId: fx.cafeId, branchId: fx.branchId,
          type: "ADJUSTMENT", quantity: 99,
        });
        throw new Error("deliberate rollback");
      })
    );

    const point = await db.$transaction((tx) => captureCountPoint(tx, item.id));
    assert.equal(point.expectedQuantity, 5, "the abandoned movement is not in the balance");
    assert.equal(point.itemVersion, BigInt(0), "nor did it consume a version");
  });

  test("the basis is named, so a stored count point says what it means", () => {
    // A count point read months later must state the rule it was captured
    // under, not leave a reader to infer it from the code of the day.
    return db.$transaction(async (tx) => {
      const item = await ingredient("basis", 1);
      const point = await captureCountPoint(tx, item.id);
      assert.equal(point.basis, "LOCKED_ITEM_VERSION");
    });
  });
});
