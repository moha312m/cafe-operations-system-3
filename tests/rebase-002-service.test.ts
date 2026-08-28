// REBASE-002 — what was counted becomes what the shelf holds.
//
// The naive rebase is `currentStock = countedQuantity`, and it is wrong in a
// shop that stays open. A sale made while the count was in progress got a
// ledger version ABOVE the line's captured `itemVersion`, so it was excluded
// from that line's expected figure — correctly, because the counter never saw
// it on the shelf. But it did leave the shelf. Setting the balance to the
// counted figure would silently put that coffee back.
//
// So the rebase replays: the target is the effective counted figure plus the
// net of every movement above the line's count point. Each movement lands on
// exactly one side of that cursor — inside the physical baseline the counter
// observed, or in the replay — never both and never neither. The cursor is
// the item-local `itemVersion`, not a timestamp: two movements in the same
// millisecond have distinct versions, and wall-clock ordering does not.
//
// The whole thing goes through `applyStockMutation`, which means the rebase
// takes the item's lock, advances the version and writes its own ledger row
// under that lock, exactly like a sale. There is no second stock writer, and
// the COUNT_REBASE row's version being exactly one above the item's prior
// version is what proves it went through the door rather than around it.
//
// The count line is never rewritten. It is evidence; this is the separate,
// audited operational effect that evidence caused.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { applyStockMutation } from "@/lib/ledger";
import { rebaseFromCount } from "@/lib/stock-rebase";
import { openVarianceCase } from "@/lib/variance-case";

const MARKER = tag("REBASE002");
let cafeId: string;
let branchId: string;
let userId: string;
let staffId: string;

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: MARKER.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} main` }] },
    },
    include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;

  const mk = async (suffix: string, role: "CASHIER" | "BRANCH_MANAGER") =>
    (await db.user.create({
      data: {
        email: `${MARKER}-${suffix}@example.invalid`, name: `${MARKER}-${suffix}`,
        passwordHash: "no-login-path", role, cafeId, branchId,
      },
    })).id;
  userId = await mk("manager", "BRANCH_MANAGER");
  staffId = await mk("staff", "CASHIER");
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

let seq = 0;

/** An item this test owns outright, with a known opening balance. */
async function makeItem(opening: string, costPerUnit: number | null = 450) {
  seq += 1;
  return db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} item ${seq}`, unit: "KG",
      costPerUnit: costPerUnit ?? 0, currentStock: opening,
    },
  });
}

/** A movement through the real writer, so it takes a real ledger version. */
async function move(inventoryItemId: string, type: "USAGE" | "PURCHASE", quantity: number) {
  return db.$transaction((tx) =>
    applyStockMutation(tx, {
      inventoryItemId, type, quantity, cafeId, branchId, createdById: staffId,
    })
  );
}

/**
 * A confirmed count of one item, capturing the count point the way the real
 * capture does: the item's ledger version at the moment of counting.
 */
async function confirmedCount(args: {
  itemId: string;
  counted: string;
  effective?: string;
  disposition?: "VARIANCE_CONFIRMED" | "WITHIN_TOLERANCE" | "OUTSIDE_TOLERANCE" | "PENDING";
  status?: "CONFIRMED" | "SUBMITTED" | "DRAFT" | "IN_PROGRESS" | "RECOUNT_REQUIRED" | "LOCKED";
}) {
  const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: args.itemId } });
  const session = await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: userId,
      status: args.status ?? "CONFIRMED",
      confirmedAt: new Date(),
      lines: {
        create: [{
          inventoryItemId: args.itemId, unit: "KG",
          expectedQuantity: String(item.currentStock),
          countedQuantity: args.counted,
          effectiveCountedQuantity: args.effective ?? args.counted,
          itemVersion: item.ledgerVersion,
          countedAt: new Date(),
          disposition: args.disposition ?? "VARIANCE_CONFIRMED",
        }],
      },
    },
    include: { lines: true },
  });
  return { sessionId: session.id, lineId: session.lines[0].id };
}

const stockOf = async (id: string) =>
  Number((await db.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock);

const rebaseRows = (inventoryItemId: string) =>
  db.inventoryTransaction.count({ where: { inventoryItemId, type: "COUNT_REBASE" } });

describe("REBASE-002 stock rebase service", () => {
  test("a quiet item lands exactly on the counted figure", async () => {
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });

    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-quiet`,
    });

    assert.equal(result.itemsRebased, 1);
    assert.equal(result.itemsSkipped, 0);
    assert.equal(result.alreadyRebased, false);
    assert.equal(await stockOf(item.id), 11.5, "no movements, so the count stands as-is");
    assert.equal(result.lines[0].replayedDelta, 0);
  });

  test("a COUNT_REBASE ledger row records exactly the delta applied", async () => {
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });
    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-ledger` });

    const txns = await db.inventoryTransaction.findMany({
      where: { inventoryItemId: item.id, type: "COUNT_REBASE" },
    });
    assert.equal(txns.length, 1, "one rebase, one ledger row");
    assert.equal(
      Number(txns[0].quantity), -0.5,
      "the ledger row is stockAfter − stockBefore, not the counted figure"
    );
  });

  test("a sale posted after the count point is replayed onto the rebase", async () => {
    // The heart of it. The counter saw 11.500 on the shelf; 0.250 left
    // afterwards. Setting the balance to 11.500 would put that coffee back.
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });

    await move(item.id, "USAGE", -0.25);
    assert.equal(await stockOf(item.id), 11.75, "the sale landed on the pre-count balance");

    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-replay`,
    });

    assert.equal(
      await stockOf(item.id), 11.25,
      "counted 11.500 minus the 0.250 that left after the count"
    );
    assert.equal(result.lines[0].replayedDelta, -0.25);

    const rebase = await db.stockCountRebase.findFirstOrThrow({ where: { sessionId } });
    assert.equal(rebase.replayedMovementCount, 1, "and it says how many it replayed");
    assert.equal(Number(rebase.countedQuantity), 11.5);
    assert.equal(Number(rebase.stockBefore), 11.75);
    assert.equal(Number(rebase.stockAfter), 11.25);
  });

  test("a receipt posted after the count point is replayed too", async () => {
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });

    await move(item.id, "PURCHASE", 3);
    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-receipt`,
    });

    assert.equal(await stockOf(item.id), 14.5, "counted 11.500 plus the 3 that arrived");
    assert.equal(result.lines[0].replayedDelta, 3);
  });

  test("a movement made BEFORE the count point is not replayed", async () => {
    // It is already inside what the counter observed. Replaying it would
    // count the same coffee twice — once on the shelf, once in the ledger.
    const item = await makeItem("12.000");
    await move(item.id, "USAGE", -2);          // before the count
    assert.equal(await stockOf(item.id), 10);

    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "10.000" });
    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-before`,
    });

    assert.equal(result.lines[0].replayedDelta, 0, "nothing above the cursor");
    assert.equal(
      await stockOf(item.id), 10,
      "the pre-count sale is inside the counted figure, not added to it"
    );
  });

  test("movements on both sides of the cursor are each counted once", async () => {
    // The boundary in one test: one movement below, one above, and a balance
    // that is only correct if each was used exactly once.
    const item = await makeItem("20.000");
    await move(item.id, "USAGE", -5);           // below → inside the count
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "15.000" });
    await move(item.id, "USAGE", -2);           // above → replayed
    await move(item.id, "PURCHASE", 1);         // above → replayed

    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-boundary`,
    });

    assert.equal(result.lines[0].replayedDelta, -1, "−2 + 1, and the −5 excluded");
    assert.equal(await stockOf(item.id), 14, "15.000 counted − 2 + 1");

    const rebase = await db.stockCountRebase.findFirstOrThrow({ where: { sessionId } });
    assert.equal(
      rebase.replayedMovementCount, 2,
      "exactly the two above the cursor, and neither of them twice"
    );
  });

  test("a movement landing between the count and the rebase is still replayed", async () => {
    // The concurrent case, as close as a test can get deterministically: the
    // POS keeps selling right up to the moment of the rebase. The cursor,
    // not the clock, decides — so a movement that arrives late is still
    // above the captured version and is still caught.
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });

    await move(item.id, "USAGE", -0.1);
    await move(item.id, "USAGE", -0.2);
    await move(item.id, "USAGE", -0.3);

    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-late`,
    });

    assert.equal(result.lines[0].replayedDelta, -0.6);
    assert.equal(await stockOf(item.id), 10.9, "11.500 − 0.600");
    const rebase = await db.stockCountRebase.findFirstOrThrow({ where: { sessionId } });
    assert.equal(rebase.replayedMovementCount, 3);
  });

  test("the rebase uses effectiveCountedQuantity, not the original count", async () => {
    // An approved correction supersedes the original observation. The
    // original stays exactly where it was — it is evidence of what was first
    // seen, and rewriting it to match the corrected figure would destroy the
    // very thing the correction exists to record.
    const item = await makeItem("12.000");
    const { sessionId, lineId } = await confirmedCount({
      itemId: item.id, counted: "9.500", effective: "11.500",
    });

    const before = await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-effective` });

    assert.equal(
      await stockOf(item.id), 11.5,
      "the approved correction is what the shelf becomes, not the 9.500 first written"
    );

    const after = await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    assert.equal(
      String(after.countedQuantity), String(before.countedQuantity),
      "the original evidence is untouched"
    );
    assert.equal(Number(after.countedQuantity), 9.5, "and still says what was first counted");
    assert.equal(Number(after.effectiveCountedQuantity), 11.5);

    const rebase = await db.stockCountRebase.findFirstOrThrow({ where: { sessionId } });
    assert.equal(Number(rebase.countedQuantity), 11.5, "the figure acted on is recorded as such");
  });

  test("a retry with the same key is a no-op, not a second adjustment", async () => {
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });
    const key = `${MARKER}-retry`;

    const first = await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: key });
    const stockAfterFirst = await stockOf(item.id);

    const second = await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: key });

    assert.equal(first.alreadyRebased, false);
    assert.equal(second.alreadyRebased, true, "the retry recognised the completed work");
    assert.equal(second.itemsRebased, 0, "and applied nothing");
    assert.equal(await stockOf(item.id), stockAfterFirst, "the balance did not move again");
    assert.equal(await rebaseRows(item.id), 1, "and no second ledger row was written");
    assert.equal(await db.stockCountRebase.count({ where: { sessionId } }), 1);
  });

  test("concurrent retries do not double-apply", async () => {
    // Two callers racing. The unique on (sessionId, inventoryItemId) is what
    // makes this safe rather than merely unlikely: one wins, the other
    // collides and reports the existing work instead of adding a delta.
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });

    const results = await Promise.allSettled([
      rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-c1` }),
      rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-c2` }),
      rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-c3` }),
    ]);

    const applied = results.filter(
      (r) => r.status === "fulfilled" && r.value.itemsRebased > 0
    ).length;
    assert.equal(applied, 1, "exactly one of the three actually rebased");
    assert.equal(await rebaseRows(item.id), 1, "one ledger row, whatever the race did");
    assert.equal(await db.stockCountRebase.count({ where: { sessionId } }), 1);
    assert.equal(await stockOf(item.id), 11.5, "and the balance landed where one rebase puts it");
  });

  test("a non-CONFIRMED session cannot rebase", async () => {
    // One status at a time, and removed afterwards: T12 permits exactly one
    // ACTIVE session per branch, and these four statuses are precisely the
    // ones its partial unique index covers. Opening them together would fail
    // for a reason that has nothing to do with what this test is about.
    for (const status of ["DRAFT", "IN_PROGRESS", "SUBMITTED", "RECOUNT_REQUIRED"] as const) {
      const item = await makeItem("12.000");
      const { sessionId } = await confirmedCount({
        itemId: item.id, counted: "11.500", status,
      });
      await assert.rejects(
        () => rebaseFromCount({
          sessionId, actorId: userId, idempotencyKey: `${MARKER}-${status}`,
        }),
        (e: { status?: number }) => e.status === 400,
        `a ${status} count is not a trusted baseline`
      );
      assert.equal(await stockOf(item.id), 12, "and the shelf figure is untouched");
      assert.equal(await rebaseRows(item.id), 0);

      await db.stockCountLine.deleteMany({ where: { sessionId } });
      await db.stockCountSession.delete({ where: { id: sessionId } });
    }
  });

  test("a non-terminal line is skipped and counted, never guessed at", async () => {
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({
      itemId: item.id, counted: "11.500", disposition: "OUTSIDE_TOLERANCE",
    });

    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-skip`,
    });
    assert.equal(result.itemsRebased, 0);
    assert.equal(result.itemsSkipped, 1, "counted, so nobody has to notice it silently");
    assert.equal(await stockOf(item.id), 12, "an unsettled line moves no stock");
    assert.equal(await rebaseRows(item.id), 0);
  });

  test("the rebase goes through the guarded writer, not around it", async () => {
    // The COUNT_REBASE row's version being exactly one above the item's
    // prior version is the proof: only `applyStockMutation` advances it.
    const item = await makeItem("12.000");
    const before = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });

    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-writer` });

    const txn = await db.inventoryTransaction.findFirstOrThrow({
      where: { inventoryItemId: item.id, type: "COUNT_REBASE" },
    });
    assert.equal(
      txn.itemVersion, before.ledgerVersion + BigInt(1),
      "exactly one above, so it took the lock and advanced the cursor"
    );

    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(after.ledgerVersion, txn.itemVersion, "and the item agrees with its ledger");

    const rebase = await db.stockCountRebase.findFirstOrThrow({ where: { sessionId } });
    assert.equal(rebase.rebaseItemVersion, txn.itemVersion);
    assert.equal(rebase.ledgerTransactionId, txn.id);
  });

  test("versions stay dense and monotonic across a rebase", async () => {
    const item = await makeItem("12.000");
    await move(item.id, "USAGE", -1);
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.000" });
    await move(item.id, "USAGE", -0.5);
    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-dense` });

    const versions = (
      await db.inventoryTransaction.findMany({
        where: { inventoryItemId: item.id },
        orderBy: { itemVersion: "asc" },
        select: { itemVersion: true },
      })
    ).map((t) => Number(t.itemVersion));

    assert.deepEqual(versions, [1, 2, 3], "no gaps, no repeats, rebase included");
  });

  test("after a rebase, a fresh count of the untouched item finds no variance", async () => {
    // The proof the baseline actually moved rather than being recorded
    // somewhere nobody reads. This is the failure the whole task exists to
    // fix: the next count used to rediscover the same shortage.
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });
    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-fresh` });

    const now = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    const expected = Number(now.currentStock);
    const counted = 11.5;
    assert.equal(
      expected - counted, 0,
      "a recount of the same shelf now expects exactly what is on it"
    );
  });

  test("three decimals survive the whole path", async () => {
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "12.018" });
    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-precision` });

    assert.equal(await stockOf(item.id), 12.018, "18 g of coffee is not 20 g");
    const txn = await db.inventoryTransaction.findFirstOrThrow({
      where: { inventoryItemId: item.id, type: "COUNT_REBASE" },
    });
    assert.equal(Number(txn.quantity), 0.018, "and the delta keeps its milligrams");

    const rebase = await db.stockCountRebase.findFirstOrThrow({ where: { sessionId } });
    assert.equal(Number(rebase.stockAfter), 12.018);
  });

  test("a missing cost does not block the quantity baseline", async () => {
    // Quantity and money are separate questions. A shop with an unpriced
    // ingredient still knows how much of it is on the shelf, and refusing to
    // record that because the money is unknown would make missing cost data
    // an operational outage.
    const item = await makeItem("12.000", 0);
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });

    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-nocost`,
    });
    assert.equal(result.itemsRebased, 1, "the quantity baseline moved anyway");
    assert.equal(await stockOf(item.id), 11.5);

    const txn = await db.inventoryTransaction.findFirstOrThrow({
      where: { inventoryItemId: item.id, type: "COUNT_REBASE" },
    });
    assert.equal(txn.totalCost, null, "and the money stays unknown");
    assert.notEqual(Number(txn.totalCost ?? NaN), 0, "rather than becoming zero");
  });

  test("an audit row records the whole arithmetic", async () => {
    const item = await makeItem("12.000");
    const { sessionId, lineId } = await confirmedCount({ itemId: item.id, counted: "11.500" });
    await move(item.id, "USAGE", -0.25);
    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-audit` });

    const rows = await db.auditLog.findMany({
      where: { cafeId, action: "STOCK_REBASED", entityId: item.id },
    });
    assert.equal(rows.length, 1, "one item, one audit row");
    const d = rows[0].details as Record<string, unknown>;
    assert.equal(d.sessionId, sessionId);
    assert.equal(d.lineId, lineId);
    assert.equal(d.branchId, branchId);
    assert.equal(d.originalCountedQuantity, 11.5, "what was first counted");
    assert.equal(d.effectiveCountedQuantity, 11.5, "what was acted on");
    assert.equal(d.stockBefore, 11.75, "what the shelf held");
    assert.equal(d.replayedDelta, -0.25, "what moved during the count");
    assert.equal(d.replayedMovementCount, 1);
    assert.equal(d.stockAfter, 11.25, "and where it landed");
    assert.equal(d.appliedDelta, -0.5);
    assert.equal(rows[0].userId, userId, "and who did it");
  });

  test("a failure leaves neither a rebase record nor a stock effect", async () => {
    // Atomicity, proven by making the write fail after validation. Either
    // both the evidence and the effect land, or neither does — a rebase row
    // with no movement, or a movement with no rebase row, would each be a
    // permanent lie about what happened to the shelf.
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount({ itemId: item.id, counted: "11.500" });

    // A ledger row already occupying the version the rebase will try to take
    // makes the mutation fail on the (item, version) unique index, after the
    // service has validated and computed.
    const current = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    await db.inventoryTransaction.create({
      data: {
        cafeId, branchId, inventoryItemId: item.id, type: "ADJUSTMENT",
        quantity: "0.000", itemVersion: current.ledgerVersion + BigInt(1),
        createdById: staffId,
      },
    });

    await assert.rejects(
      () => rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-fail` })
    );

    assert.equal(
      await db.stockCountRebase.count({ where: { sessionId } }), 0,
      "no rebase evidence for an effect that never happened"
    );
    assert.equal(await rebaseRows(item.id), 0, "and no COUNT_REBASE ledger row");
    assert.equal(
      await stockOf(item.id), 12,
      "the balance is exactly where it was before the attempt"
    );
  });

  test("a previous variance case stays on the previous custody period", async () => {
    // Rebasing moves the OPERATIONAL baseline forward. It does not move
    // responsibility forward with it: the shortage happened under whoever
    // held the room then, and the incoming custodian inherits a clean shelf,
    // not somebody else's case.
    const item = await makeItem("12.000");
    const previousCustody = await db.custodyPeriod.create({
      data: {
        cafeId, branchId, scope: "STOCK", status: "TRANSFERRED", endedAt: new Date(),
        participants: { create: [{ userId: staffId, role: "PRIMARY" }] },
      },
    });
    const incomingCustody = await db.custodyPeriod.create({
      data: {
        cafeId, branchId, scope: "STOCK",
        participants: { create: [{ userId, role: "PRIMARY" }] },
      },
    });

    const { sessionId, lineId } = await confirmedCount({ itemId: item.id, counted: "11.500" });
    const { caseId } = await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId, branchId, type: "STOCK", custodyPeriodId: previousCustody.id,
        openedById: userId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5,
        financialImpact: { available: false, reason: "MISSING_COST" },
      })
    );

    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-custody` });

    const after = await db.varianceCase.findUniqueOrThrow({ where: { id: caseId } });
    assert.equal(
      after.custodyPeriodId, previousCustody.id,
      "the case still names who held the room when the shortage happened"
    );
    assert.notEqual(after.custodyPeriodId, incomingCustody.id);
    assert.equal(after.status, "OPEN", "and the rebase did not resolve it either");
    assert.equal(
      after.assignedResponsibilityUserId, null,
      "nobody was made responsible by a shelf being corrected"
    );
    assert.equal(await stockOf(item.id), 11.5, "while the baseline moved on regardless");
  });

  test("an open variance case does not gate the rebase", async () => {
    // A case records investigation. It is not a lock on the shelf, and a
    // count whose variance is still being looked at is still the best
    // available figure for what is physically there.
    const item = await makeItem("12.000");
    const { sessionId, lineId } = await confirmedCount({ itemId: item.id, counted: "11.500" });
    await db.$transaction((tx) =>
      openVarianceCase(tx, {
        cafeId, branchId, type: "STOCK", openedById: userId,
        source: { kind: "STOCK_LINE", stockCountLineId: lineId },
        quantityVariance: -0.5,
        financialImpact: { available: true, value: 225 },
      })
    );

    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-open-case`,
    });
    assert.equal(result.itemsRebased, 1, "an OPEN case is not a blocker");
    assert.equal(await stockOf(item.id), 11.5);
  });

  test("a session from another café is refused", async () => {
    const otherCafe = await db.cafe.create({
      data: {
        name: `${MARKER}-other cafe`, slug: `${MARKER.toLowerCase()}-other`,
        settings: { create: {} },
        branches: { create: [{ name: `${MARKER}-other main` }] },
      },
      include: { branches: true },
    });
    try {
      const otherUser = await db.user.create({
        data: {
          email: `${MARKER}-other@example.invalid`, name: `${MARKER}-other`,
          passwordHash: "no-login-path", role: "BRANCH_MANAGER",
          cafeId: otherCafe.id, branchId: otherCafe.branches[0].id,
        },
      });
      const otherItem = await db.inventoryItem.create({
        data: {
          cafeId: otherCafe.id, branchId: otherCafe.branches[0].id,
          name: `${MARKER}-other beans`, unit: "KG", costPerUnit: 450, currentStock: "12.000",
        },
      });
      const session = await db.stockCountSession.create({
        data: {
          cafeId: otherCafe.id, branchId: otherCafe.branches[0].id,
          type: "FULL", scopeDerivation: "ALL_ELIGIBLE", initiatedById: otherUser.id,
          status: "CONFIRMED", confirmedAt: new Date(),
          lines: {
            create: [{
              inventoryItemId: otherItem.id, unit: "KG", countedQuantity: "11.500",
              effectiveCountedQuantity: "11.500", itemVersion: BigInt(0),
              disposition: "VARIANCE_CONFIRMED",
            }],
          },
        },
      });

      await assert.rejects(
        () => rebaseFromCount({
          sessionId: session.id, actorId: userId, idempotencyKey: `${MARKER}-crosscafe`,
        }),
        (e: { status?: number }) => e.status === 400 || e.status === 403,
        "an actor from one café cannot rebase another's shelf"
      );
      assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({
        where: { id: otherItem.id },
      })).currentStock), 12, "and nothing moved");
    } finally {
      await db.stockCountLine.deleteMany({ where: { session: { cafeId: otherCafe.id } } });
      await db.stockCountSession.deleteMany({ where: { cafeId: otherCafe.id } });
      await db.inventoryItem.deleteMany({ where: { cafeId: otherCafe.id } });
      await db.user.deleteMany({ where: { cafeId: otherCafe.id } });
      await db.cafe.deleteMany({ where: { id: otherCafe.id } });
    }
  });
});
