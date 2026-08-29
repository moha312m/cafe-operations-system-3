// LEDGER-002 — one door in and out of the ledger, and it holds the lock.
//
// LEDGER-001 established the invariant: within an item, version order is
// commit order, because the counter advances only under that item's
// FOR UPDATE lock. An invariant like that is worth exactly as much as its
// weakest writer, and before this task there were six of them:
//
//   opening balance on item create   — in NO transaction at all
//   TRANSFER_OUT / TRANSFER_IN       — interactive tx
//   manual movement                  — array-form $transaction, which
//                                      CANNOT hold a row lock
//   purchase confirm                 — interactive tx
//   recipe deduction                 — interactive tx
//
// Two of those are structurally incapable of the contract. So the contract
// stops being a convention and becomes a structure: one writer, and test 5
// asserts no other exists — a seventh cannot be added quietly.
//
// The refactor also carries a fix that is not incidental. Purchase confirm
// computed `round2(oldStock + qty)` on a Decimal(12,3) column: an 18 g
// receipt landed as 20 g. That is the same corruption STOCK-001 fixed in the
// movement and transfer routes, still live in purchases, silently damaging
// the baseline every physical count is measured against. The single writer
// uses round3 throughout, and test 9 pins it.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { db, fixture, tag, type Fixture } from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";
import { applyStockMutation, lockItemForUpdate, ledgerDeltaAbove } from "@/lib/ledger";

const MARKER = tag("LEDGER002");
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

const stockOf = async (id: string) =>
  Number((await db.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock);
const versionOf = async (id: string) =>
  (await db.inventoryItem.findUniqueOrThrow({ where: { id } })).ledgerVersion;

describe("LEDGER-002 the single guarded stock writer", () => {
  test("a mutation advances ledgerVersion by exactly one and stamps the row with it", async () => {
    const item = await ingredient("advance", 10);
    const before = await versionOf(item.id);

    const result = await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: item.id, type: "ADJUSTMENT", quantity: 1.5,
        cafeId: fx.cafeId, branchId: fx.branchId,
      })
    );

    assert.equal(await versionOf(item.id), before + BigInt(1), "exactly one step");
    assert.equal(result.itemVersion, before + BigInt(1));

    const row = await db.inventoryTransaction.findUniqueOrThrow({
      where: { id: result.transactionId },
    });
    assert.equal(
      row.itemVersion, result.itemVersion,
      "the ledger row must carry the version it was written at"
    );
  });

  test("stockAfter is round3 of stockBefore plus the delta", async () => {
    // 12.018 kg is what a shelf looks like after recipe deduction has taken
    // 18 g off it — precisely the state a two-decimal round trip destroys.
    const item = await ingredient("precision", "12.018");
    const r = await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: item.id, type: "WASTE", quantity: -0.018,
        cafeId: fx.cafeId, branchId: fx.branchId,
      })
    );
    assert.equal(r.stockBefore, 12.018);
    assert.equal(r.stockAfter, 12, "12.018 less 0.018 is 12 exactly");
    assert.equal(await stockOf(item.id), 12);
  });

  test("a rolled-back mutation leaves ledgerVersion unchanged, and the next write reuses that number", async () => {
    // The gap-free property a sequence cannot give: the counter lives in the
    // row, so a rolled-back increment rolls back with it.
    const item = await ingredient("rollback", 10);
    const before = await versionOf(item.id);

    await assert.rejects(() =>
      db.$transaction(async (tx) => {
        await applyStockMutation(tx, {
          inventoryItemId: item.id, type: "ADJUSTMENT", quantity: 5,
          cafeId: fx.cafeId, branchId: fx.branchId,
        });
        throw new Error("deliberate rollback");
      })
    );

    assert.equal(await versionOf(item.id), before, "a rollback leaves no gap");
    assert.equal(await stockOf(item.id), 10, "and no stock change");

    const r = await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: item.id, type: "ADJUSTMENT", quantity: 1,
        cafeId: fx.cafeId, branchId: fx.branchId,
      })
    );
    assert.equal(r.itemVersion, before + BigInt(1), "the number is reused, not burned");
  });

  test("allowNegative false refuses to go below zero, and writes nothing", async () => {
    const item = await ingredient("negative", 1);
    const before = await versionOf(item.id);

    await assert.rejects(
      () => db.$transaction((tx) =>
        applyStockMutation(tx, {
          inventoryItemId: item.id, type: "USAGE", quantity: -5,
          cafeId: fx.cafeId, branchId: fx.branchId, allowNegative: false,
        })
      ),
      /كمية|stock/i
    );

    assert.equal(await stockOf(item.id), 1, "the shelf is untouched");
    assert.equal(await versionOf(item.id), before, "and so is the counter");
  });

  test("no RUNTIME path outside src/lib/ledger.ts writes the ledger or currentStock", async () => {
    // The structural assertion. A convention degrades; a test that reads the
    // source tree does not — a seventh writer cannot be added silently.
    //
    // Scope is deliberately `src/`: the invariant is about RUNTIME stock
    // mutation. `prisma/seed.ts` writes opening rows too, but it is bootstrap
    // code that runs against an empty database with nothing to race, and it
    // states its versions explicitly (verified on the scratch database:
    // ledgerVersion == MAX(itemVersion) for every seeded item). Counting it
    // as a writer would blur the thing this test exists to protect.
    const offenders: string[] = [];
    const allowed = join("src", "lib", "ledger.ts");

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.tsx?$/.test(path)) continue;
        if (path === allowed) continue;

        const src = readFileSync(path, "utf8");
        if (/inventoryTransaction\.create/.test(src)) {
          offenders.push(`${path}: inventoryTransaction.create`);
        }
        // A `currentStock:` inside an update payload is a direct write.
        // Reads (`select`, comparisons, `currentStock` in a `where`) are
        // fine, so the match is anchored on the update call itself.
        // `[\s\S]` rather than the `s` flag: the project targets ES2017.
        if (/\.update\(\{[\s\S]{0,400}?currentStock\s*:/.test(src)) {
          offenders.push(`${path}: writes currentStock`);
        }
        // A create may open an item, but only at zero. Creating one with a
        // balance already on it would put stock on the shelf that no ledger
        // row accounts for — the same phantom the opening-balance refactor
        // removed, reintroduced through a different door.
        for (const m of src.matchAll(/\.create\(\{[\s\S]{0,600}?currentStock\s*:\s*([^,\n]+)/g)) {
          const value = m[1].trim();
          if (value !== "0") {
            offenders.push(`${path}: creates an item at ${value}, not through the ledger`);
          }
        }
      }
    };
    walk("src");

    assert.deepEqual(
      offenders, [],
      `every stock write must go through applyStockMutation:\n${offenders.join("\n")}`
    );
  });

  test("each refactored path still writes its own transaction type", async () => {
    // The refactor must be invisible at the call sites: same types, same
    // audit actions, same messages. Only the guarantee is new.
    const item = await ingredient("types", 100);
    for (const type of ["PURCHASE", "USAGE", "WASTE", "ADJUSTMENT", "RETURN"] as const) {
      const r = await db.$transaction((tx) =>
        applyStockMutation(tx, {
          inventoryItemId: item.id, type, quantity: type === "USAGE" || type === "WASTE" ? -1 : 1,
          cafeId: fx.cafeId, branchId: fx.branchId,
        })
      );
      const row = await db.inventoryTransaction.findUniqueOrThrow({
        where: { id: r.transactionId },
      });
      assert.equal(row.type, type);
    }
  });

  test("the movement route still satisfies STOCK-001 to the gram", async () => {
    const item = await ingredient("movement-http", "12.018");
    const r = await as(OWNER, `/api/inventory/${item.id}/movement`, {
      method: "POST",
      body: JSON.stringify({ type: "WASTE", quantity: 0.018, note: MARKER }),
    });
    assert.ok(r.status < 300, `movement failed: ${r.text}`);

    const txn = await db.inventoryTransaction.findFirstOrThrow({
      where: { inventoryItemId: item.id }, orderBy: { createdAt: "desc" },
    });
    assert.equal(Number(txn.quantity), -0.018, "18 g of waste is 18 g");
    assert.ok(txn.itemVersion > BigInt(0), "and it is numbered");
    assert.equal(await stockOf(item.id), 12);
  });

  test("the transfer route still moves the same quantity it takes", async () => {
    const other = await db.branch.findFirst({
      where: { cafeId: fx.cafeId, id: { not: fx.branchId }, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    assert.ok(other, "this cafe needs a second branch for a transfer");

    const source = await ingredient("transfer-http", "12.018");
    const r = await as(OWNER, "/api/inventory/transfer", {
      method: "POST",
      body: JSON.stringify({
        inventoryItemId: source.id, toBranchId: other.id, quantity: 0.018, note: MARKER,
      }),
    });
    assert.ok(r.status < 300, `transfer failed: ${r.text}`);

    const dest = await db.inventoryItem.findFirstOrThrow({
      where: { cafeId: fx.cafeId, branchId: other.id, name: source.name, unit: source.unit },
    });
    itemIds.push(dest.id);

    assert.equal(await stockOf(source.id), 12, "the source gave up exactly 18 g");
    assert.equal(Number(dest.currentStock), 0.018, "the destination received exactly 18 g");
  });

  test("a purchase-confirm receipt of 0.018 kg lands as 0.018, not 0.02", async () => {
    // THE R3.2 DEFECT. `round2(oldStock + qty)` on a Decimal(12,3) column
    // turned an 18 g receipt into 20 g — inventing 2 g of coffee that was
    // never delivered, in the baseline every count is measured against.
    const item = await ingredient("purchase-precision", 0);
    const supplier = await db.supplier.create({
      data: { cafeId: fx.cafeId, name: `${MARKER} supplier` },
    });
    const invoice = await db.purchaseInvoice.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, supplierId: supplier.id,
        invoiceNumber: `${MARKER}-1`, status: "DRAFT",
        subtotalAmount: 8.1, totalAmount: 8.1, remainingAmount: 8.1,
        items: {
          create: [{
            cafeId: fx.cafeId, branchId: fx.branchId, unit: "KG",
            inventoryItemId: item.id, quantity: 0.018, unitCost: 450, totalCost: 8.1,
          }],
        },
      },
    });

    try {
      const r = await as(OWNER, `/api/purchases/${invoice.id}/confirm`, { method: "POST" });
      assert.ok(r.status < 300, `confirm failed: ${r.text}`);

      assert.equal(
        await stockOf(item.id), 0.018,
        "an 18 g receipt is 18 g — round2 on a three-decimal column invented 2 g"
      );
    } finally {
      await db.purchaseInvoiceItem.deleteMany({ where: { purchaseInvoiceId: invoice.id } });
      await db.purchaseInvoice.deleteMany({ where: { id: invoice.id } });
      await db.supplier.deleteMany({ where: { id: supplier.id } });
    }
  });

  test("item creation with an opening balance writes item and ledger row in one transaction", async () => {
    const r = await as<{ item: { id: string } }>(OWNER, "/api/inventory", {
      method: "POST",
      body: JSON.stringify({
        name: `${MARKER} opening`, branchId: fx.branchId, unit: "KG",
        currentStock: 2.5, minimumStock: 0, costPerUnit: 100,
      }),
    });
    assert.ok(r.status < 300, `create failed: ${r.text}`);
    const id = r.body.item.id;
    itemIds.push(id);

    const rows = await db.inventoryTransaction.findMany({ where: { inventoryItemId: id } });
    assert.equal(rows.length, 1, "the opening balance is one ledger row");
    assert.equal(rows[0].itemVersion, BigInt(1), "written at version 1, not unnumbered");
    assert.equal(await versionOf(id), BigInt(1), "and the item counter agrees");
  });

  test("ledgerDeltaAbove sums only rows above the given version", async () => {
    const item = await ingredient("delta", 0);
    const versions: bigint[] = [];
    for (const q of [1, 2, 4]) {
      const r = await db.$transaction((tx) =>
        applyStockMutation(tx, {
          inventoryItemId: item.id, type: "ADJUSTMENT", quantity: q,
          cafeId: fx.cafeId, branchId: fx.branchId,
        })
      );
      versions.push(r.itemVersion);
    }

    const all = await ledgerDeltaAbove(db, item.id, BigInt(0));
    assert.equal(all.delta, 7);
    assert.equal(all.movementCount, 3);

    const above1 = await ledgerDeltaAbove(db, item.id, versions[0]);
    assert.equal(above1.delta, 6, "strictly above: the first movement is excluded");
    assert.equal(above1.movementCount, 2);

    const aboveLast = await ledgerDeltaAbove(db, item.id, versions[2]);
    assert.equal(aboveLast.delta, 0);
    assert.equal(aboveLast.movementCount, 0);
  });

  test("two different items mutate concurrently without blocking each other", async () => {
    // The lock is per item, so independent shelves do not contend. If this
    // ever deadlocks or serialises, the writer is locking too much.
    const a = await ingredient("concurrent-a", 100);
    const b = await ingredient("concurrent-b", 100);

    await Promise.all([a, b].map((item) =>
      db.$transaction((tx) =>
        applyStockMutation(tx, {
          inventoryItemId: item.id, type: "USAGE", quantity: -1,
          cafeId: fx.cafeId, branchId: fx.branchId,
        })
      )
    ));

    assert.equal(await stockOf(a.id), 99);
    assert.equal(await stockOf(b.id), 99);
  });

  test("lockItemForUpdate reads stock and version together", async () => {
    const item = await ingredient("lock-read", "5.5");
    const read = await db.$transaction((tx) => lockItemForUpdate(tx, item.id));
    assert.equal(read.currentStock, 5.5);
    assert.equal(read.ledgerVersion, await versionOf(item.id));
    assert.equal(read.unit, "KG");
    assert.equal(read.costPerUnit, 450);
  });
});
