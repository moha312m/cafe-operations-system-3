// POLICY-008 — the policy an order was ACCEPTED under governs it to the end.
//
// POLICY-006 proves each of the three modes behaves correctly. It proves it
// with the café's setting held still for the whole life of the order, which is
// the one condition the till cannot guarantee.
//
// The gap: an order's inventory lifecycle spans two moments, minutes or hours
// apart, and until now each read the café's policy FRESH.
//
//   creation   availability is judged, the customer is told yes, money may
//              already be collected
//   SERVED     ingredients are deducted under a row lock
//
// Between them the owner can open the settings screen. Every combination is a
// real defect and two of them are the serious ones:
//
//   accepted under OVERRIDE_ALL, then STRICT     the deduction refuses, so the
//                                                order cannot be handed over —
//                                                a drink that was sold, paid
//                                                for, and made now cannot be
//                                                given to the customer
//   accepted under STRICT, then OVERRIDE_ALL     the deduction waives a
//                                                shortage the till would never
//                                                have accepted, committing a
//                                                negative balance nobody
//                                                agreed to for this order
//
// The invariant this suite pins:
//
//   THE INVENTORY POLICY IN FORCE WHEN AN ORDER IS ACCEPTED GOVERNS THAT ORDER
//   FOR ITS ENTIRE INVENTORY LIFECYCLE. A settings change applies to NEW
//   orders only.
//
// Which is the same rule the order already applies to money: `taxRateSnapshot`
// and `serviceRateSnapshot` exist so a later settings edit never rewrites what
// a customer was charged. Enforcement policy is the same kind of fact, and it
// is snapshotted the same way — server-derived at creation, never client-sent.
//
// Driven over HTTP for creation and through the real deduction for SERVED,
// because the defect lives in the seam between the two and a helper-level
// test would sit on one side of it.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, COUNT_PASSWORD, type CountCafe } from "./helpers/count";
import { login } from "./helpers/http";
import { deductStockForOrder, StockError } from "@/lib/stock-deduction";
import type { InventoryEnforcementMode } from "@prisma/client";

let fx: CountCafe;
let categoryId: string;
/** A second café, for the isolation checks. */
let other: CountCafe;
let otherCategoryId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("POL008");
  categoryId = (
    await db.menuCategory.create({ data: { cafeId: fx.cafeId, name: `${fx.marker} drinks` } })
  ).id;

  other = await countCafe("POL008B");
  otherCategoryId = (
    await db.menuCategory.create({ data: { cafeId: other.cafeId, name: `${other.marker} drinks` } })
  ).id;
  // `countCafe` signs its own accounts in; this re-login is belt and braces
  // for the second café, whose owner is used from a different describe block.
  await login(other.owner.email, COUNT_PASSWORD);
});

after(() =>
  teardownTaggedCafe(
    [...(fx ? [fx.cafeId] : []), ...(other ? [other.cafeId] : [])],
    [],
    { disconnect: true }
  )
);

// ───────────────────────────── fixtures ──────────────────────────────

let seq = 0;
const uniq = (s: string) => `${s}-${(seq += 1)}`;

/** Set a café's persisted policy — the only way a mode is ever chosen. */
async function setMode(mode: InventoryEnforcementMode, cafeId = fx.cafeId) {
  await db.cafeSettings.upsert({
    where: { cafeId },
    create: { cafeId, inventoryEnforcementMode: mode },
    update: { inventoryEnforcementMode: mode },
  });
}

async function product(name: string, cafe = fx, category = categoryId) {
  return db.product.create({
    data: {
      cafeId: cafe.cafeId,
      categoryId: category,
      name: `${cafe.marker} ${uniq(name)}`,
      basePrice: "90.00",
    },
  });
}

async function ingredient(name: string, stock: number, cafe = fx) {
  return countItem(cafe, uniq(name), { stock, costPerUnit: 120 });
}

async function recipeFor(
  productId: string,
  lines: { itemId: string; qty: string; unit?: "KG" | "ML" }[],
  cafe = fx
) {
  return db.recipe.create({
    data: {
      cafeId: cafe.cafeId,
      productId,
      notApplicable: false,
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

type OrderResult = {
  status: number;
  body: {
    error?: string;
    warnings?: string[];
    inventoryPolicy?: string;
    order?: { id: string; orderNumber: number };
  };
  text: string;
};

/** Place an order the way the POS does. `extra` is how a spoof is attempted. */
async function order(
  productId: string,
  opts: { quantity?: number; cafe?: CountCafe; extra?: Record<string, unknown> } = {}
): Promise<OrderResult> {
  const cafe = opts.cafe ?? fx;
  return as(cafe.owner.email, "/api/orders", {
    method: "POST",
    body: JSON.stringify({
      branchId: cafe.branchId,
      type: "TAKEAWAY",
      collectionMode: "PENDING",
      items: [{ productId, quantity: opts.quantity ?? 1, addOnIds: [] }],
      ...(opts.extra ?? {}),
    }),
  });
}

const stockOf = async (id: string) =>
  (await db.inventoryItem.findUniqueOrThrow({ where: { id }, select: { currentStock: true } }))
    .currentStock.toString();

/**
 * Move a branch balance behind the order's back.
 *
 * This is what actually happens between creation and SERVED — another order,
 * a wastage entry, a correction — and it is written directly here because the
 * fixture is establishing a starting condition rather than exercising the
 * ledger's writer, exactly as `countItem` does for an opening balance.
 */
const setStock = (id: string, stock: number) =>
  db.inventoryItem.update({ where: { id }, data: { currentStock: String(stock) } });

/** Drive the real SERVED-time deduction. */
const serve = (orderId: string, cafe = fx) =>
  db.$transaction((tx) => deductStockForOrder(tx, orderId, cafe.owner.id));

/** The mode the order itself carries — the field this suite is about. */
async function persistedMode(orderId: string): Promise<string | null | undefined> {
  const rows = await db.$queryRawUnsafe<{ mode: string | null }[]>(
    `SELECT "inventoryEnforcementMode" AS mode FROM "Order" WHERE "id" = $1`,
    orderId
  );
  return rows[0]?.mode;
}

const overrideAudit = (orderId: string) =>
  db.auditLog.findFirst({
    where: { action: "ORDER_INVENTORY_POLICY_OVERRIDE", entityId: orderId },
    orderBy: { createdAt: "desc" },
  });

// ─────────────── 1 · accepted STRICT stays STRICT at SERVED ──────────

describe("POLICY-008 an order accepted under STRICT is still STRICT at SERVED", () => {
  test("a later switch to OVERRIDE_ALL does not waive this order's shortage", async () => {
    await setMode("STRICT");
    const ice = await ingredient("strict ice", 5);
    const p = await product("strict shake");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.220" }]);

    // Accepted honestly: the branch had the stock when the customer asked.
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);

    // The shelf empties behind it, and only THEN does the owner relax policy.
    await setStock(ice.id, 0.1);
    await setMode("OVERRIDE_ALL");

    // The order was taken under a promise to refuse what the branch cannot
    // make. A settings change made after the fact must not retroactively
    // grant it a waiver it never had.
    await assert.rejects(
      () => serve(r.body.order!.id),
      (e: unknown) => e instanceof StockError,
      "a STRICT order must still refuse a shortage after the café relaxes"
    );
    assert.equal(await stockOf(ice.id), "0.1", "a refused deduction moves nothing");
  });
});

// ──────── 2 · accepted OVERRIDE_ALL stays OVERRIDE_ALL at SERVED ─────

describe("POLICY-008 an order accepted under OVERRIDE_ALL is still OVERRIDE_ALL at SERVED", () => {
  test("a later switch to STRICT does not strand a sold, paid order", async () => {
    await setMode("OVERRIDE_ALL");
    const ice = await ingredient("override ice", 0.1);
    const p = await product("override shake");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.160" }]);

    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    assert.ok(r.body.warnings?.length, "the shortage was waived, so it was warned about");

    // The owner tightens policy while the drink is being made.
    await setMode("STRICT");

    // The customer has already been told yes. Refusing here would leave a
    // made, sold order that cannot be handed over.
    await serve(r.body.order!.id);
    assert.equal(await stockOf(ice.id), "-0.06", "0.100 − 0.160, exactly the shortfall");
  });
});

// ─── 3 · accepted ALLOW_NEGATIVE_STOCK still deducts negative at SERVED ──

describe("POLICY-008 an ALLOW_NEGATIVE_STOCK order still commits its negative balance", () => {
  test("a later switch to STRICT does not block the deduction", async () => {
    await setMode("ALLOW_NEGATIVE_STOCK");
    const ice = await ingredient("neg ice", 0.1);
    const p = await product("neg shake");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.160" }]);

    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);

    await setMode("STRICT");

    await serve(r.body.order!.id);
    assert.equal(await stockOf(ice.id), "-0.06");
  });
});

// ──────────────── 4 · new orders follow the NEW policy ───────────────

describe("POLICY-008 a settings change governs orders taken after it", () => {
  test("tightening to STRICT blocks the next order, and only the next one", async () => {
    await setMode("OVERRIDE_ALL");
    const ice = await ingredient("switch ice", 0.1);
    const p = await product("switch shake");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.160" }]);

    const before = await order(p.id);
    assert.equal(before.status, 201, before.text);
    assert.equal(await persistedMode(before.body.order!.id), "OVERRIDE_ALL");

    await setMode("STRICT");

    // The same cart, the same shelf, a different answer — which is the whole
    // point of the setting.
    const after = await order(p.id);
    assert.equal(after.status, 409, `a new order must obey the new policy: ${after.text}`);

    // And an order the new policy DOES allow carries the new mode.
    const plenty = await ingredient("switch plenty", 5);
    const q = await product("switch fine");
    await recipeFor(q.id, [{ itemId: plenty.id, qty: "0.100" }]);
    const fine = await order(q.id);
    assert.equal(fine.status, 201, fine.text);
    assert.equal(await persistedMode(fine.body.order!.id), "STRICT");
  });
});

// ──────────────── 5 · the client cannot choose the mode ──────────────

describe("POLICY-008 the mode is server-derived and cannot be spoofed", () => {
  test("a request body asking for OVERRIDE_ALL is ignored, not honoured", async () => {
    await setMode("STRICT");
    const ice = await ingredient("spoof ice", 0.1);
    const p = await product("spoof shake");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.220" }]);

    // Every spelling a caller might reach for. None of them is a way in:
    // enforcement is a business setting the owner configures, never something
    // a till can ask to relax.
    const r = await order(p.id, {
      extra: {
        inventoryEnforcementMode: "OVERRIDE_ALL",
        enforcementMode: "OVERRIDE_ALL",
        mode: "OVERRIDE_ALL",
        inventoryPolicy: "OVERRIDE_ALL",
      },
    });
    assert.equal(r.status, 409, `the café's policy decides, not the caller: ${r.text}`);
  });

  test("a spoof field on an ALLOWED order does not reach the stored mode", async () => {
    await setMode("STRICT");
    const plenty = await ingredient("spoof plenty", 5);
    const p = await product("spoof fine");
    await recipeFor(p.id, [{ itemId: plenty.id, qty: "0.100" }]);

    const r = await order(p.id, {
      extra: { inventoryEnforcementMode: "OVERRIDE_ALL", mode: "OVERRIDE_ALL" },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(
      await persistedMode(r.body.order!.id),
      "STRICT",
      "the stored mode comes from the café, never from the request body"
    );
  });
});

// ────────── 6 · the stored mode IS the mode creation decided on ───────

describe("POLICY-008 the stored mode matches the policy used at creation", () => {
  for (const mode of ["STRICT", "ALLOW_NEGATIVE_STOCK", "OVERRIDE_ALL"] as const) {
    test(`an order taken under ${mode} stores ${mode}`, async () => {
      await setMode(mode);
      const plenty = await ingredient(`match ${mode}`, 5);
      const p = await product(`match ${mode}`);
      await recipeFor(p.id, [{ itemId: plenty.id, qty: "0.100" }]);

      const r = await order(p.id);
      assert.equal(r.status, 201, r.text);
      assert.equal(await persistedMode(r.body.order!.id), mode);
    });
  }

  test("the stored mode survives the café changing afterwards", async () => {
    await setMode("OVERRIDE_ALL");
    const plenty = await ingredient("survive", 5);
    const p = await product("survive");
    await recipeFor(p.id, [{ itemId: plenty.id, qty: "0.100" }]);
    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);

    await setMode("STRICT");
    assert.equal(
      await persistedMode(r.body.order!.id),
      "OVERRIDE_ALL",
      "a settings edit must never rewrite an order that already exists"
    );
  });
});

// ────────── 7 · the override audit reports the ORDER's mode ───────────

describe("POLICY-008 the override audit is written against the order's own mode", () => {
  test("the audited mode equals the stored mode, then and later", async () => {
    await setMode("OVERRIDE_ALL");
    const ice = await ingredient("audit ice", 0.1);
    const p = await product("audit shake");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.160" }]);

    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    const orderId = r.body.order!.id;

    const row = await overrideAudit(orderId);
    assert.ok(row, "a waived sale must be recorded");
    const details = row!.details as { mode?: string } | null;
    assert.equal(details?.mode, "OVERRIDE_ALL");
    assert.equal(
      details?.mode,
      await persistedMode(orderId),
      "the audit must report the mode the order actually carries"
    );

    // The record is evidence about a past decision, so the café moving on
    // must not change what it says.
    await setMode("STRICT");
    const again = await overrideAudit(orderId);
    assert.equal((again!.details as { mode?: string } | null)?.mode, "OVERRIDE_ALL");
    assert.equal(await persistedMode(orderId), "OVERRIDE_ALL");
  });
});

// ─────────────────── 8 · SERVED remains idempotent ───────────────────

describe("POLICY-008 serving twice still deducts once", () => {
  test("the second attempt is refused as already-deducted, not re-run", async () => {
    await setMode("ALLOW_NEGATIVE_STOCK");
    const ice = await ingredient("idem ice", 0.1);
    const p = await product("idem shake");
    await recipeFor(p.id, [{ itemId: ice.id, qty: "0.160" }]);

    const r = await order(p.id);
    assert.equal(r.status, 201, r.text);
    const orderId = r.body.order!.id;

    // The café tightens; the snapshot is what lets the first serve succeed.
    await setMode("STRICT");
    await serve(orderId);
    assert.equal(await stockOf(ice.id), "-0.06");

    // The route sets stockDeductedAt after a successful deduction; do the same
    // here, since this suite calls the service directly.
    await db.order.update({ where: { id: orderId }, data: { stockDeductedAt: new Date() } });

    await assert.rejects(
      () => serve(orderId),
      (e: unknown) => e instanceof StockError && /من قبل/.test((e as Error).message),
      "a repeated SERVED must be refused for being repeated, not for policy"
    );
    assert.equal(await stockOf(ice.id), "-0.06", "the balance moved exactly once");
  });
});

// ──────── 9 · history is never invented into OVERRIDE_ALL ────────────

describe("POLICY-008 historical orders are never backfilled to OVERRIDE_ALL", () => {
  /** The additive migration that introduces the column. */
  function snapshotMigrationSql(): string {
    const dir = "prisma/migrations";
    const name = readdirSync(dir).find((d) => /order.*(policy|enforcement)|policy.*snapshot/i.test(d));
    assert.ok(name, "a NEW additive migration must introduce Order.inventoryEnforcementMode");
    return readFileSync(`${dir}/${name}/migration.sql`, "utf8");
  }

  test("the migration never assigns OVERRIDE_ALL to an existing order", () => {
    const sql = snapshotMigrationSql();
    assert.ok(
      !/OVERRIDE_ALL/.test(sql.replace(/--.*$/gm, "")),
      "OVERRIDE_ALL waives recipe completeness; no past order ever agreed to that"
    );
  });

  test("the migration is additive — it drops nothing", () => {
    const sql = snapshotMigrationSql().replace(/--.*$/gm, "");
    assert.ok(!/DROP\s+TABLE/i.test(sql), "no table may be dropped");
    assert.ok(!/DROP\s+COLUMN/i.test(sql), "no column may be dropped — allowNegativeStock stays");
    assert.ok(!/DROP\s+TYPE/i.test(sql), "the enum is reused, not replaced");
  });

  test("the column's own default is the safe end of the range", async () => {
    // A row inserted by a path that forgets the field fails CLOSED. Whatever
    // else goes wrong, nothing is silently granted an override.
    const rows = await db.$queryRawUnsafe<{ d: string | null; n: string }[]>(
      `SELECT column_default AS d, is_nullable AS n
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Order'
          AND column_name = 'inventoryEnforcementMode'`
    );
    assert.equal(rows.length, 1, "the Order table must carry the snapshot column");
    assert.equal(rows[0].n, "NO", "every order must answer the question");
    assert.match(rows[0].d ?? "", /STRICT/, "and default to the strict reading");
  });

  test("an order row written without the field lands on STRICT, not the café's mode", async () => {
    // The historical case, reproduced: a row that never expressed a policy.
    // The café is on OVERRIDE_ALL, so anything that resolved the value from
    // the café's CURRENT setting — a backfill, a nullable column read through
    // a fallback — would hand this row an override nobody agreed to for it.
    await setMode("OVERRIDE_ALL");
    const id = `pol008-legacy-${process.pid}-${(seq += 1)}`;
    const number = 900000 + seq;
    await db.$executeRawUnsafe(
      `INSERT INTO "Order" ("id", "cafeId", "branchId", "orderNumber",
                            "subtotal", "total", "updatedAt")
       VALUES ($1, $2, $3, $4, 0, 0, now())`,
      id, fx.cafeId, fx.branchId, number
    );
    assert.equal(await persistedMode(id), "STRICT");
    await db.$executeRawUnsafe(`DELETE FROM "Order" WHERE "id" = $1`, id);
  });
});

// ───────────────── 10 · cross-café isolation holds ───────────────────

describe("POLICY-008 one café's policy never reaches another café's orders", () => {
  test("two cafés on different modes snapshot their own, and stay independent", async () => {
    await setMode("OVERRIDE_ALL", fx.cafeId);
    await setMode("STRICT", other.cafeId);

    // Café A: a shortage, waived by A's own policy.
    const aIce = await ingredient("iso a ice", 0.1);
    const aProd = await product("iso a shake");
    await recipeFor(aProd.id, [{ itemId: aIce.id, qty: "0.160" }]);
    const a = await order(aProd.id);
    assert.equal(a.status, 201, a.text);
    assert.equal(await persistedMode(a.body.order!.id), "OVERRIDE_ALL");

    // Café B: the identical shortage, refused by B's own policy.
    const bIce = await ingredient("iso b ice", 0.1, other);
    const bProd = await product("iso b shake", other, otherCategoryId);
    await recipeFor(bProd.id, [{ itemId: bIce.id, qty: "0.160" }], other);
    const bBlocked = await order(bProd.id, { cafe: other });
    assert.equal(bBlocked.status, 409, `B is STRICT and must refuse: ${bBlocked.text}`);

    // B takes an order it CAN make, and stores its own mode.
    const bPlenty = await ingredient("iso b plenty", 5, other);
    const bFine = await product("iso b fine", other, otherCategoryId);
    await recipeFor(bFine.id, [{ itemId: bPlenty.id, qty: "0.100" }], other);
    const b = await order(bFine.id, { cafe: other });
    assert.equal(b.status, 201, b.text);
    assert.equal(await persistedMode(b.body.order!.id), "STRICT");

    // Now flip BOTH, the wrong way round, and serve each.
    await setMode("STRICT", fx.cafeId);
    await setMode("OVERRIDE_ALL", other.cafeId);

    // A keeps its waiver despite A now being STRICT…
    await serve(a.body.order!.id);
    assert.equal(await stockOf(aIce.id), "-0.06");

    // …and B keeps its strictness despite B now being OVERRIDE_ALL.
    await setStock(bPlenty.id, 0.01);
    await assert.rejects(
      () => serve(b.body.order!.id, other),
      (e: unknown) => e instanceof StockError,
      "B's order was accepted under STRICT and stays STRICT"
    );
    assert.equal(await stockOf(bPlenty.id), "0.01", "a refused deduction moves nothing");
  });
});
