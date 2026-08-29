// LEDGER-001 — number the ledger per item, under the item's own lock.
//
// Every physical count measures a shelf against a theoretical balance, and
// that comparison is only meaningful if "the balance at this instant" is a
// thing the database can express. It needs a cursor: a point such that
// everything at or below it is committed and reflected in `currentStock`,
// and nothing above it has been assigned.
//
// A global PostgreSQL sequence cannot be that cursor, and the reason is
// worth stating because it is not obvious. `nextval()` assigns at INSERT,
// not at COMMIT, and it is non-transactional:
//
//     txn A: INSERT … seq = 100      (holds, uncommitted)
//     txn B: INSERT … seq = 101, COMMIT
//     capture: MAX(seq) = 101        ← A is invisible but numerically BELOW
//     txn A: COMMIT
//
// Movement A now sits at or below the captured cursor yet was not in the
// captured `currentStock`. It is excluded from the rebase replay AND absent
// from the expected figure — silently lost, and read later as somebody's
// shortage. Rollback gaps make it worse, not better.
//
// So the counter is item-local and lives IN the item row, advanced only
// under that row's `FOR UPDATE` lock. The lock serialises every mutator of
// that item, so version order IS commit order, by construction. A rolled
// back increment rolls back with the row, leaving no gap. And the whole
// invariant is enforced by the database rather than by the discipline of the
// code, through `UNIQUE (inventoryItemId, itemVersion)`.
//
// This suite asserts the schema and the backfill. T6 asserts the writer that
// maintains it; T7 asserts the capture that reads it.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, fixture, tag, type Fixture } from "./helpers/db";

const MARKER = tag("LEDGER001");
let fx: Fixture;
const createdItemIds: string[] = [];

before(async () => { fx = await fixture(); });

after(async () => {
  if (createdItemIds.length) {
    await db.inventoryTransaction.deleteMany({
      where: { inventoryItemId: { in: createdItemIds } },
    });
    await db.inventoryItem.deleteMany({ where: { id: { in: createdItemIds } } });
  }
  await db.$disconnect();
});

/** An ingredient this suite owns outright. */
async function ingredient(name: string, stock = 0) {
  const item = await db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      name: `${MARKER} ${name}`, unit: "KG", costPerUnit: 100, currentStock: stock,
    },
  });
  createdItemIds.push(item.id);
  return item;
}

describe("LEDGER-001 item-local version schema", () => {
  test("every pre-existing transaction carries a non-null itemVersion", async () => {
    const [{ count }] = await db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
        FROM "InventoryTransaction" WHERE "itemVersion" IS NULL
    `;
    assert.equal(
      Number(count), 0,
      "the backfill must reach every historical row — an unnumbered row is invisible to the cursor"
    );
  });

  test("per item, versions run 1..n in history order with no gap", async () => {
    // Physical scan order is not history, so the backfill orders by
    // (createdAt, id). This asserts the result of that choice: within an
    // item, the version sequence is dense and starts at 1.
    const bad = await db.$queryRaw<{ inventoryItemId: string; expected: bigint; actual: bigint }[]>`
      WITH ordered AS (
        SELECT "inventoryItemId", "itemVersion",
               ROW_NUMBER() OVER (PARTITION BY "inventoryItemId"
                                  ORDER BY "createdAt" ASC, "id" ASC) AS rn
          FROM "InventoryTransaction"
      )
      SELECT "inventoryItemId", rn AS expected, "itemVersion" AS actual
        FROM ordered WHERE "itemVersion" <> rn LIMIT 5
    `;
    assert.deepEqual(bad, [], "versions must be dense and in history order within each item");
  });

  test("each item's ledgerVersion equals its highest itemVersion", async () => {
    const drifted = await db.$queryRaw<{ id: string; ledger: bigint; top: bigint }[]>`
      SELECT i."id", i."ledgerVersion" AS ledger,
             COALESCE(MAX(t."itemVersion"), 0) AS top
        FROM "InventoryItem" i
        LEFT JOIN "InventoryTransaction" t ON t."inventoryItemId" = i."id"
       GROUP BY i."id", i."ledgerVersion"
      HAVING i."ledgerVersion" <> COALESCE(MAX(t."itemVersion"), 0)
       LIMIT 5
    `;
    assert.deepEqual(
      drifted, [],
      "the counter must start where the item's history ends, or the next write reuses a taken number"
    );
  });

  test("an item with no transactions reads ledgerVersion = 0", async () => {
    const item = await ingredient("quiet");
    const fresh = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(fresh.ledgerVersion, BigInt(0), "a shelf nothing has happened to is at version zero");
  });

  test("a duplicate (inventoryItemId, itemVersion) is rejected by the database", async () => {
    // This is the assertion that makes the invariant real. Everything else
    // in this milestone is code that intends to be correct; this is the
    // database refusing to store the incorrect state at all.
    const item = await ingredient("collide");
    const row = {
      cafeId: fx.cafeId, branchId: fx.branchId, inventoryItemId: item.id,
      type: "ADJUSTMENT" as const, quantity: 1, itemVersion: BigInt(1),
    };
    await db.inventoryTransaction.create({ data: row });

    await assert.rejects(
      () => db.inventoryTransaction.create({ data: { ...row, quantity: 2 } }),
      (e: { code?: string }) => e.code === "P2002",
      "two rows may not claim the same version of the same item"
    );
  });

  test("two different items may both hold version 1", async () => {
    // The counter is item-local, not global: independent shelves do not
    // contend, which is the whole reason a per-item counter is usable.
    const a = await ingredient("independent-a");
    const b = await ingredient("independent-b");
    for (const item of [a, b]) {
      await db.inventoryTransaction.create({
        data: {
          cafeId: fx.cafeId, branchId: fx.branchId, inventoryItemId: item.id,
          type: "ADJUSTMENT", quantity: 1, itemVersion: BigInt(1),
        },
      });
    }
    const rows = await db.inventoryTransaction.findMany({
      where: { inventoryItemId: { in: [a.id, b.id] }, itemVersion: BigInt(1) },
    });
    assert.equal(rows.length, 2, "version 1 belongs to each item separately");
  });

  test("no global sequence named `seq` exists", async () => {
    // The rejected design, asserted against the catalog so it cannot creep
    // back in a later migration. A sequence numbers at INSERT, not COMMIT,
    // which is exactly the property that made it unusable as a count point.
    const seqs = await db.$queryRaw<{ sequence_name: string }[]>`
      SELECT sequence_name FROM information_schema.sequences
       WHERE sequence_schema = current_schema()
         AND (sequence_name = 'seq' OR sequence_name ILIKE '%InventoryTransaction_seq%')
    `;
    assert.deepEqual(seqs, [], "the sequence design was rejected and must not return");

    const cols = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'InventoryTransaction' AND column_name = 'seq'
    `;
    assert.deepEqual(cols, [], "InventoryTransaction.seq must not exist");
  });
});
