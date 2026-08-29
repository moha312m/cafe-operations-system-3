// COUNT-010 (T26) — recording a count fixes a ledger version, and stays
// deterministic while the shop keeps trading.
//
// A count is a comparison between a shelf and a theoretical balance, and the
// comparison only means something if the balance has a cursor. Capture takes
// the item's row lock (T7 `captureCountPoint`, on the identical lock every
// stock mutation takes) and reads `currentStock` and `ledgerVersion` under
// it. So at the captured version, everything at or below is committed AND
// reflected in the balance, and nothing above has been assigned. There is no
// window in which a movement is numbered-but-invisible.
//
// The consequence this suite exists to pin: a sale posted while the counter
// walks the floor is neither an error nor silently absorbed. It lands on
// exactly ONE side of the cursor — inside the balance the counter observed,
// or above it and replayed by the rebase (T23). Never both, never neither.
// Test 5 asserts that over twenty real interleavings rather than reasoning
// about it once.
//
// What capture does NOT do:
//
//   • move stock. Entering a count writes evidence; changing the shelf to
//     match is a separate, audited act (COUNT_REBASE) that happens after
//     confirmation and never here.
//   • take a figure from the client other than the physical observation. The
//     expected quantity, the version and the confidence are the server's
//     conclusions, and a request that names them is refused rather than
//     obeyed.
//
// And a physical zero is a real count. `countedQuantity = 0` means the shelf
// was empty and somebody looked; `null` means nobody has looked yet. Losing
// that distinction turns an uncounted line into a total loss.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { applyStockMutation } from "@/lib/ledger";

let fx: CountCafe;
let other: CountCafe;

before(async () => {
  await requireServer();
  fx = await countCafe("COUNT010");
  other = await countCafe("COUNT010X");
});

after(() =>
  teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], {
    disconnect: true,
  })
);

let seq = 0;

/** An item this suite owns, opened at a known balance. */
async function item(stock: number) {
  seq += 1;
  return countItem(fx, `item ${seq}`, { stock, isCritical: true });
}

/** A movement through the real writer, so it takes a real ledger version. */
function move(inventoryItemId: string, quantity: number) {
  return db.$transaction((tx) =>
    applyStockMutation(tx, {
      inventoryItemId,
      type: quantity < 0 ? "USAGE" : "PURCHASE",
      quantity,
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      createdById: fx.cashier.id,
    })
  );
}

/**
 * A session covering exactly the given items.
 *
 * Built directly rather than through the start API: T24 already proves how
 * scope is derived, and this suite needs a session over items it controls
 * one at a time.
 */
async function sessionOver(
  itemIds: string[],
  opts: { status?: "DRAFT" | "IN_PROGRESS" | "SUBMITTED" | "CONFIRMED" | "LOCKED" } = {}
) {
  await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
  const s = await db.stockCountSession.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      type: "CRITICAL",
      scopeDerivation: "CRITICAL_ONLY",
      status: opts.status ?? "DRAFT",
      mode: "BLIND",
      initiatedById: fx.manager.id,
      lines: { create: itemIds.map((id) => ({ inventoryItemId: id, unit: "KG" as const })) },
    },
    select: { id: true, lines: { select: { id: true, inventoryItemId: true } } },
  });
  return { id: s.id, lineFor: (itemId: string) => s.lines.find((l) => l.inventoryItemId === itemId)!.id };
}

type CaptureBody = { line?: Record<string, unknown>; error?: string };

const capture = (
  email: string,
  sessionId: string,
  lineId: string,
  body: Record<string, unknown>
) =>
  as<CaptureBody>(email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

const lineRow = (lineId: string) =>
  db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });

describe("COUNT-010 atomic count line capture", () => {
  test("capture stores the target, the version and the basis it was taken under", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const lineId = s.lineFor(it.id);

    const r = await capture(fx.cashier.email, s.id, lineId, { countedQuantity: 11.5 });
    assert.ok(r.status < 300, `capture failed: ${r.text}`);

    const stored = await lineRow(lineId);
    assert.equal(Number(stored.expectedQuantity), 12);
    assert.equal(Number(stored.countedQuantity), 11.5);
    assert.equal(
      Number(stored.effectiveCountedQuantity),
      11.5,
      "the working figure equals the observation until a correction supersedes it"
    );
    assert.equal(Number(stored.varianceQuantity), -0.5);
    assert.equal(stored.disposition, "COUNTED");
    assert.equal(stored.counterId, fx.cashier.id);
    assert.ok(stored.countedAt, "the moment of counting is recorded");
    assert.equal(stored.itemVersion, it.ledgerVersion, "captured at the item's version");
    assert.equal(
      stored.expectedBasis,
      "LOCKED_ITEM_VERSION",
      "a count read months later must state its own basis"
    );
  });

  test("the session moves from DRAFT to IN_PROGRESS on the first capture", async () => {
    const it = await item(5);
    const s = await sessionOver([it.id]);
    const before = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(before.status, "DRAFT");

    await capture(fx.cashier.email, s.id, s.lineFor(it.id), { countedQuantity: 5 });

    const after = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(after.status, "IN_PROGRESS");
    assert.ok(after.startedAt, "counting has begun, and the session says when");
    assert.equal(after.firstCounterId, fx.cashier.id);
  });

  test("eighteen grams stays eighteen grams", async () => {
    // Stock is Decimal(12,3) because 18 g of coffee is 0.018 kg. Rounding the
    // variance to two places would report 20 g missing and put the difference
    // in somebody's file.
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const lineId = s.lineFor(it.id);

    await capture(fx.cashier.email, s.id, lineId, { countedQuantity: 11.982 });
    const stored = await lineRow(lineId);
    assert.equal(Number(stored.varianceQuantity), -0.018);
    assert.notEqual(Number(stored.varianceQuantity), -0.02);
  });

  test("a physical zero is a count, and is not the same as an uncounted line", async () => {
    const counted = await item(4);
    const untouched = await item(4);
    const s = await sessionOver([counted.id, untouched.id]);

    const r = await capture(fx.cashier.email, s.id, s.lineFor(counted.id), {
      countedQuantity: 0,
    });
    assert.ok(r.status < 300, `an empty shelf is a real observation: ${r.text}`);

    const zero = await lineRow(s.lineFor(counted.id));
    assert.equal(Number(zero.countedQuantity), 0);
    assert.equal(zero.disposition, "COUNTED");
    assert.equal(Number(zero.varianceQuantity), -4, "everything that was expected is gone");

    const missing = await lineRow(s.lineFor(untouched.id));
    assert.equal(missing.countedQuantity, null, "nobody has looked at this shelf");
    assert.equal(missing.disposition, "PENDING");
  });

  test("re-capturing updates in place, and the version follows the shelf", async () => {
    // Two captures of one line, minutes apart, with a movement between them.
    // The movement is ABOVE the first capture's version and AT-OR-BELOW the
    // second's — one cursor, one side each.
    const it = await item(20);
    const s = await sessionOver([it.id]);
    const lineId = s.lineFor(it.id);

    await capture(fx.cashier.email, s.id, lineId, { countedQuantity: 20 });
    const first = await lineRow(lineId);

    const movement = await move(it.id, 2);

    await capture(fx.cashier.email, s.id, lineId, { countedQuantity: 22 });
    const second = await lineRow(lineId);

    assert.ok(
      second.itemVersion! > first.itemVersion!,
      "the second capture happened later on the item's own clock"
    );
    assert.ok(
      movement.itemVersion > first.itemVersion! && movement.itemVersion <= second.itemVersion!,
      "the movement sits above the first count point and at-or-below the second"
    );
    assert.equal(Number(first.expectedQuantity), 20);
    assert.equal(Number(second.expectedQuantity), 22, "and the later target includes it");

    assert.equal(
      await db.stockCountLine.count({ where: { sessionId: s.id, inventoryItemId: it.id } }),
      1,
      "re-recording revises the line rather than adding a second one"
    );
  });

  test("a movement racing a capture lands on exactly one side of the cursor", async () => {
    // Twenty real interleavings. Either the movement is at-or-below the
    // captured version and reflected in the target, or above it and absent
    // from the target. A torn result — numbered below but missing from the
    // balance — would be silently lost stock, read later as somebody's
    // shortage.
    const items = [];
    for (let i = 0; i < 20; i += 1) items.push(await item(100));
    const s = await sessionOver(items.map((i) => i.id));

    for (const it of items) {
      const lineId = s.lineFor(it.id);
      const [, movement] = await Promise.all([
        capture(fx.cashier.email, s.id, lineId, { countedQuantity: 100 }),
        move(it.id, 1),
      ]);
      const stored = await lineRow(lineId);
      const expected = Number(stored.expectedQuantity);

      if (movement.itemVersion <= stored.itemVersion!) {
        assert.equal(
          expected, 101,
          `movement v${movement.itemVersion} is at-or-below the count point ` +
            `v${stored.itemVersion} but is missing from the target`
        );
      } else {
        assert.equal(
          expected, 100,
          `movement v${movement.itemVersion} is above the count point ` +
            `v${stored.itemVersion} but was absorbed into the target`
        );
      }
    }
  });

  test("capturing does not move the shelf", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const versionBefore = it.ledgerVersion;

    await capture(fx.cashier.email, s.id, s.lineFor(it.id), { countedQuantity: 3 });

    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: it.id } });
    assert.equal(
      Number(after.currentStock), 12,
      "entering a count records evidence; changing the shelf is a separate, audited act"
    );
    assert.equal(after.ledgerVersion, versionBefore, "and it writes no ledger row");
    assert.equal(
      await db.inventoryTransaction.count({ where: { inventoryItemId: it.id } }), 0
    );
  });

  test("the counter's own response still carries no target", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const r = await capture(fx.cashier.email, s.id, s.lineFor(it.id), {
      countedQuantity: 11,
    });
    assert.ok(r.status < 300, r.text);
    assert.ok(
      !/expectedQuantity|varianceQuantity/.test(r.text),
      "capture must not hand back the target it just computed"
    );
    assert.equal(Number(r.body.line!.countedQuantity), 11, "the observation comes back");
  });

  test("a request naming the server's own conclusions is refused", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const lineId = s.lineFor(it.id);

    for (const smuggled of [
      { expectedQuantity: 3 },
      { itemVersion: 99 },
      { confidence: "VERIFIED" },
      { disposition: "WITHIN_TOLERANCE" },
      { effectiveCountedQuantity: 99 },
      { varianceQuantity: 0 },
    ]) {
      const r = await capture(fx.cashier.email, s.id, lineId, {
        countedQuantity: 11,
        ...smuggled,
      });
      assert.equal(
        r.status, 400,
        `${Object.keys(smuggled)[0]} must be refused, not obeyed: ${r.text}`
      );
    }

    const stored = await lineRow(lineId);
    assert.equal(stored.countedQuantity, null, "and none of them recorded a count");
    assert.equal(stored.disposition, "PENDING");
  });

  test("capturing on a confirmed session is refused and changes nothing", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const lineId = s.lineFor(it.id);
    await capture(fx.cashier.email, s.id, lineId, { countedQuantity: 11.5 });
    await db.stockCountSession.update({
      where: { id: s.id },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
    });

    const r = await capture(fx.cashier.email, s.id, lineId, { countedQuantity: 12 });
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${r.text}`);

    const stored = await lineRow(lineId);
    assert.equal(
      Number(stored.countedQuantity), 11.5,
      "a confirmed count is evidence and does not get walked towards the target"
    );
  });

  test("capturing on a locked session is refused", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id], { status: "LOCKED" });
    const r = await capture(fx.cashier.email, s.id, s.lineFor(it.id), {
      countedQuantity: 12,
    });
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${r.text}`);
  });

  test("an ITEM_COUNTED audit row names the line, the item and the version", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const lineId = s.lineFor(it.id);
    await capture(fx.cashier.email, s.id, lineId, { countedQuantity: 11.5 });

    const row = await db.auditLog.findFirst({
      where: { cafeId: fx.cafeId, action: "ITEM_COUNTED", entityId: lineId },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(row, "a capture that left no record is a figure nobody can place");
    const details = row!.details as Record<string, unknown>;
    assert.equal(details.inventoryItemId, it.id);
    assert.equal(details.sessionId, s.id);
    assert.equal(String(details.itemVersion), String(it.ledgerVersion));
    assert.equal(row!.userId, fx.cashier.id);
  });

  test("a line belonging to another session is not reachable through this one", async () => {
    const a = await item(1);
    const b = await item(1);
    const first = await sessionOver([a.id]);
    const strayLineId = first.lineFor(a.id);
    const second = await sessionOver([b.id]);

    const r = await capture(fx.cashier.email, second.id, strayLineId, {
      countedQuantity: 1,
    });
    assert.equal(r.status, 404, `expected 404, got ${r.status}: ${r.text}`);
  });

  test("a caller without stock_count.submit cannot record a count", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const r = await capture(fx.waiter.email, s.id, s.lineFor(it.id), {
      countedQuantity: 11,
    });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
    assert.equal((await lineRow(s.lineFor(it.id))).countedQuantity, null);
  });

  test("another café cannot record a count on this one's line", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const lineId = s.lineFor(it.id);
    const r = await capture(other.owner.email, s.id, lineId, { countedQuantity: 11 });
    assert.equal(r.status, 404, `expected 404, got ${r.status}: ${r.text}`);
    assert.equal((await lineRow(lineId)).countedQuantity, null);
  });

  test("a branch-pinned caller cannot record a count at another branch", async () => {
    await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
    const elsewhere = await countItem(fx, "annex item", {
      branchId: fx.otherBranchId,
      stock: 3,
    });
    const s = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.otherBranchId,
        type: "FULL",
        scopeDerivation: "ALL_ELIGIBLE",
        initiatedById: fx.owner.id,
        lines: { create: [{ inventoryItemId: elsewhere.id, unit: "KG" }] },
      },
      select: { id: true, lines: { select: { id: true } } },
    });

    const r = await capture(fx.cashier.email, s.id, s.lines[0].id, { countedQuantity: 3 });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
  });

  test("a negative physical count is refused", async () => {
    const it = await item(12);
    const s = await sessionOver([it.id]);
    const r = await capture(fx.cashier.email, s.id, s.lineFor(it.id), {
      countedQuantity: -1,
    });
    assert.equal(r.status, 400, `a shelf cannot hold less than nothing: ${r.text}`);
  });
});
