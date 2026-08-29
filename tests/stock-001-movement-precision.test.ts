// STOCK-001 — a manual stock movement must not round the shelf.
//
// Invariant: quantities and stock balances are held to three decimals, the
// precision the schema was deliberately widened to. The `stock_precision`
// migration states the reason outright — "18g of coffee = 0.018 kg" — and
// recipe deduction already writes at that precision via round3.
//
// The manual movement and transfer routes rounded to two decimals instead,
// so every hand-entered movement did two separate wrongs:
//
//   • the ledger row was rewritten (18 g of waste posted as 20 g), and
//   • the whole balance was re-rounded, inventing or destroying stock in a
//     third decimal the movement never touched.
//
// Both corrupt theoretical stock, which is the number every physical-count
// variance is measured against — a variance read off a rounded shelf is not
// evidence of anything.
//
// These run against the real API: the defect is in what the route persists.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, fixture, type Fixture } from "./helpers/db";
import { requireServer, login, as } from "./helpers/http";

after(async () => { await db.$disconnect(); });

const OWNER = "owner@demo.com";
const MARKER = "PH1-STOCK001";

before(async () => {
  await requireServer();
  await login(OWNER, "owner1234");
});

/**
 * An ingredient this test owns outright, opened at a gram-level balance.
 *
 * 12.018 kg is deliberately not a two-decimal number: it is what a shelf
 * looks like after recipe deduction has taken 18 g off it, and it is exactly
 * the state a two-decimal round trip cannot represent.
 */
async function ingredient(fx: Fixture, name: string, stock: string) {
  return db.inventoryItem.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      name: `${MARKER} ${name}`, unit: "KG", costPerUnit: 450,
      currentStock: stock,
    },
  });
}

async function drop(...ids: string[]) {
  if (ids.length === 0) return;
  await db.inventoryTransaction.deleteMany({ where: { inventoryItemId: { in: ids } } });
  await db.inventoryItem.deleteMany({ where: { id: { in: ids } } });
}

describe("STOCK-001 movement precision", () => {
  test("a gram-level waste posts the quantity that was actually entered", async () => {
    const fx = await fixture();
    const item = await ingredient(fx, "beans-waste", "12.018");
    try {
      const r = await as(`${OWNER}`, `/api/inventory/${item.id}/movement`, {
        method: "POST",
        body: JSON.stringify({ type: "WASTE", quantity: 0.018, note: MARKER }),
      });
      assert.ok(r.status < 300, `movement failed: ${r.text}`);

      const txn = await db.inventoryTransaction.findFirstOrThrow({
        where: { inventoryItemId: item.id },
        orderBy: { createdAt: "desc" },
      });
      assert.equal(
        Number(txn.quantity), -0.018,
        "18 g of waste must be recorded as 18 g, not rounded to 20 g"
      );

      const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      assert.equal(
        Number(after.currentStock), 12,
        "12.018 kg less 0.018 kg is 12 kg exactly"
      );
    } finally {
      await drop(item.id);
    }
  });

  test("a whole-unit purchase leaves the third decimal it never touched alone", async () => {
    const fx = await fixture();
    const item = await ingredient(fx, "beans-purchase", "12.018");
    try {
      const r = await as(`${OWNER}`, `/api/inventory/${item.id}/movement`, {
        method: "POST",
        body: JSON.stringify({ type: "PURCHASE", quantity: 1, unitCost: 450, note: MARKER }),
      });
      assert.ok(r.status < 300, `movement failed: ${r.text}`);

      const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      assert.equal(
        Number(after.currentStock), 13.018,
        "adding 1 kg to 12.018 kg must not invent 2 g of stock"
      );
    } finally {
      await drop(item.id);
    }
  });

  test("a transfer moves the same quantity it takes, to the gram", async () => {
    const fx = await fixture();
    const other = await db.branch.findFirst({
      where: { cafeId: fx.cafeId, id: { not: fx.branchId }, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    assert.ok(other, "this cafe needs a second branch for a transfer");

    const source = await ingredient(fx, "beans-transfer", "12.018");
    let destId: string | undefined;
    try {
      const r = await as(`${OWNER}`, `/api/inventory/transfer`, {
        method: "POST",
        body: JSON.stringify({
          inventoryItemId: source.id, toBranchId: other.id, quantity: 0.018, note: MARKER,
        }),
      });
      assert.ok(r.status < 300, `transfer failed: ${r.text}`);

      const dest = await db.inventoryItem.findFirstOrThrow({
        where: { cafeId: fx.cafeId, branchId: other.id, name: source.name, unit: source.unit },
      });
      destId = dest.id;

      const left = await db.inventoryItem.findUniqueOrThrow({ where: { id: source.id } });
      assert.equal(Number(left.currentStock), 12, "the source gave up exactly 18 g");
      assert.equal(Number(dest.currentStock), 0.018, "the destination received exactly 18 g");
    } finally {
      await drop(source.id, ...(destId ? [destId] : []));
    }
  });
});
