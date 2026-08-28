// REBASE-001 — a ledger movement that means the shelf was counted.
//
// An earlier revision declared confirmed counts to be the operational
// baseline and then never wrote them anywhere. `currentStock` kept the
// pre-count figure, the next count rediscovered the same variance, and the
// handover baseline was fiction — three shifts of people signing for a number
// nobody had corrected.
//
// So a rebase is a real ledger movement with a type of its own. `ADJUSTMENT`
// is deliberately not reused: spec §7 says a count records EVIDENCE and an
// adjustment records a CORRECTION, and a manager who tweaks a figure and a
// team who physically recounted a shelf must be distinguishable in reporting
// forever after. Reusing ADJUSTMENT would merge them at the moment of
// writing, and no later query could take them apart.
//
// `signedDelta` returns a COUNT_REBASE quantity unchanged, unlike every other
// arm. A rebase is signed by the caller because a count can find more on the
// shelf than expected as easily as less, and forcing a sign here would make
// one of those two cases unrepresentable.
//
// `@@unique([sessionId, inventoryItemId])` is the idempotency mechanism, in
// the database rather than in a flag: one confirmed count rebases one item
// exactly once, and a retry collides instead of double-applying.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { TXN_LABEL, TXN_AUDIT_ACTION, signedDelta } from "@/lib/inventory";

const MARKER = tag("REBASE001");
let cafeId: string;
let branchId: string;
let userId: string;
let sessionId: string;
let itemId: string;
let otherItemId: string;
let lineId: string;
let otherLineId: string;

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

  userId = (await db.user.create({
    data: {
      email: `${MARKER}@example.invalid`, name: MARKER,
      passwordHash: "no-login-path", role: "BRANCH_MANAGER", cafeId, branchId,
    },
  })).id;

  const item = async (name: string) =>
    (await db.inventoryItem.create({
      data: {
        cafeId, branchId, name: `${MARKER} ${name}`, unit: "KG",
        costPerUnit: 450, currentStock: "12.000",
      },
    })).id;
  itemId = await item("beans");
  otherItemId = await item("cocoa");

  sessionId = (await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: userId, status: "CONFIRMED", confirmedAt: new Date(),
    },
  })).id;

  const line = async (inventoryItemId: string) =>
    (await db.stockCountLine.create({
      data: {
        sessionId, inventoryItemId, unit: "KG",
        expectedQuantity: "12.000", countedQuantity: "11.500",
        effectiveCountedQuantity: "11.500", varianceQuantity: "-0.500",
        itemVersion: BigInt(0), disposition: "VARIANCE_CONFIRMED",
      },
    })).id;
  lineId = await line(itemId);
  otherLineId = await line(otherItemId);
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

const clearRebases = async () => {
  await db.stockCountRebase.deleteMany({ where: { sessionId } });
  await db.inventoryTransaction.deleteMany({ where: { cafeId } });
};

/** A ledger row to hang a rebase record off. */
async function ledgerRow(inventoryItemId: string, quantity: string, version: number) {
  return db.inventoryTransaction.create({
    data: {
      cafeId, branchId, inventoryItemId, type: "COUNT_REBASE",
      quantity, itemVersion: BigInt(version), createdById: userId,
    },
  });
}

describe("REBASE-001 rebase schema and the COUNT_REBASE ledger type", () => {
  test("a COUNT_REBASE transaction persists", async () => {
    await clearRebases();
    const txn = await ledgerRow(itemId, "-0.500", 1);
    assert.equal(txn.type, "COUNT_REBASE");
    assert.equal(Number(txn.quantity), -0.5);
    assert.equal(txn.itemVersion, BigInt(1), "and carries its own ledger version");
  });

  test("signedDelta leaves a rebase quantity exactly as the caller signed it", async () => {
    // Unlike every other arm. A count can find MORE on the shelf than
    // expected as easily as less, so forcing a sign would make one of those
    // two cases unrepresentable.
    assert.equal(signedDelta("COUNT_REBASE", -0.5), -0.5, "a shortage stays negative");
    assert.equal(signedDelta("COUNT_REBASE", 0.5), 0.5, "and a surplus stays positive");
    assert.equal(signedDelta("COUNT_REBASE", 0), 0);
    assert.equal(
      signedDelta("COUNT_REBASE", 12.018), 12.018,
      "and three decimals survive the pass-through"
    );
  });

  test("every transaction type has a label and an audit action", async () => {
    // A missing entry is not a compile error on a Record whose key type just
    // grew — it is an `undefined` that reaches a screen or an audit row.
    const values = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'InventoryTransactionType' ORDER BY e.enumsortorder
    `;
    for (const { label } of values) {
      const key = label as keyof typeof TXN_LABEL;
      assert.ok(TXN_LABEL[key], `TXN_LABEL has no entry for ${label}`);
      assert.ok(TXN_AUDIT_ACTION[key], `TXN_AUDIT_ACTION has no entry for ${label}`);
    }
    assert.equal(
      TXN_AUDIT_ACTION.COUNT_REBASE !== TXN_AUDIT_ACTION.ADJUSTMENT, true,
      "a physical recount must not audit as a manager's tweak"
    );
  });

  test("the enum still holds all seven original values, plus the new one", async () => {
    // Additive means additive. An ALTER TYPE that lost a value would break
    // every historical row that used it.
    const values = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'InventoryTransactionType' ORDER BY e.enumsortorder
    `;
    const labels = values.map((v) => v.label);
    for (const original of [
      "PURCHASE", "USAGE", "WASTE", "ADJUSTMENT", "TRANSFER_IN", "TRANSFER_OUT", "RETURN",
    ]) {
      assert.ok(labels.includes(original), `${original} went missing`);
    }
    assert.ok(labels.includes("COUNT_REBASE"));
    assert.equal(labels.length, 8);
  });

  test("a rebase record persists with the whole arithmetic it performed", async () => {
    // Every figure that produced the new balance is kept, so the rebase can
    // be re-derived later rather than taken on trust.
    await clearRebases();
    const txn = await ledgerRow(itemId, "-0.750", 1);
    const r = await db.stockCountRebase.create({
      data: {
        sessionId, lineId, inventoryItemId: itemId,
        countedQuantity: "11.500", stockBefore: "12.000",
        replayedDelta: "-0.250", replayedMovementCount: 1,
        stockAfter: "11.250", rebaseItemVersion: BigInt(1),
        ledgerTransactionId: txn.id, rebasedById: userId,
      },
      include: { session: true, line: true, inventoryItem: true, ledgerTransaction: true, rebasedBy: true },
    });

    assert.equal(Number(r.countedQuantity), 11.5, "the figure acted on");
    assert.equal(Number(r.stockBefore), 12, "what the shelf said beforehand");
    assert.equal(Number(r.replayedDelta), -0.25, "what moved during the count");
    assert.equal(r.replayedMovementCount, 1);
    assert.equal(Number(r.stockAfter), 11.25, "and where it landed");
    assert.equal(r.session.id, sessionId, "resolved through relations, not loose ids");
    assert.equal(r.line.id, lineId);
    assert.equal(r.inventoryItem.id, itemId);
    assert.equal(r.ledgerTransaction.type, "COUNT_REBASE");
    assert.equal(r.rebasedBy.id, userId, "and it names who did it");
  });

  test("(sessionId, inventoryItemId) rejects a duplicate rebase", async () => {
    // The idempotency mechanism, in the database rather than in a flag: one
    // confirmed count rebases one item exactly once, and a retry collides
    // instead of double-applying to a balance.
    await clearRebases();
    const first = await ledgerRow(itemId, "-0.500", 1);
    await db.stockCountRebase.create({
      data: {
        sessionId, lineId, inventoryItemId: itemId,
        countedQuantity: "11.500", stockBefore: "12.000",
        replayedDelta: "0.000", replayedMovementCount: 0,
        stockAfter: "11.500", rebaseItemVersion: BigInt(1),
        ledgerTransactionId: first.id, rebasedById: userId,
      },
    });

    const second = await ledgerRow(itemId, "-0.500", 2);
    await assert.rejects(
      () => db.stockCountRebase.create({
        data: {
          sessionId, lineId, inventoryItemId: itemId,
          countedQuantity: "11.500", stockBefore: "11.500",
          replayedDelta: "0.000", replayedMovementCount: 0,
          stockAfter: "11.500", rebaseItemVersion: BigInt(2),
          ledgerTransactionId: second.id, rebasedById: userId,
        },
      }),
      (e: { code?: string }) => e.code === "P2002",
      "one count, one item, one rebase"
    );

    // A different item in the same session is a different rebase.
    const third = await ledgerRow(otherItemId, "-0.500", 1);
    const other = await db.stockCountRebase.create({
      data: {
        sessionId, lineId: otherLineId, inventoryItemId: otherItemId,
        countedQuantity: "11.500", stockBefore: "12.000",
        replayedDelta: "0.000", replayedMovementCount: 0,
        stockAfter: "11.500", rebaseItemVersion: BigInt(1),
        ledgerTransactionId: third.id, rebasedById: userId,
      },
    });
    assert.equal(other.inventoryItemId, otherItemId);
  });

  test("lineId and ledgerTransactionId are each unique", async () => {
    await clearRebases();
    const txn = await ledgerRow(itemId, "-0.500", 1);
    await db.stockCountRebase.create({
      data: {
        sessionId, lineId, inventoryItemId: itemId,
        countedQuantity: "11.500", stockBefore: "12.000",
        replayedDelta: "0.000", replayedMovementCount: 0,
        stockAfter: "11.500", rebaseItemVersion: BigInt(1),
        ledgerTransactionId: txn.id, rebasedById: userId,
      },
    });

    // One ledger row is the effect of one rebase — sharing it would make the
    // effect ambiguous.
    const another = await ledgerRow(otherItemId, "-0.500", 1);
    await assert.rejects(
      () => db.stockCountRebase.create({
        data: {
          sessionId, lineId: otherLineId, inventoryItemId: otherItemId,
          countedQuantity: "11.500", stockBefore: "12.000",
          replayedDelta: "0.000", replayedMovementCount: 0,
          stockAfter: "11.500", rebaseItemVersion: BigInt(1),
          ledgerTransactionId: txn.id, rebasedById: userId,
        },
      }),
      (e: { code?: string }) => e.code === "P2002",
      "two rebases cannot claim one ledger row"
    );
    assert.ok(another.id);
  });

  test("Restrict blocks deleting the ledger row or item a rebase points at", async () => {
    // The rebase's whole value is that it explains a movement. Deleting the
    // movement while keeping the explanation would leave a record of an
    // effect that is no longer visible anywhere.
    await clearRebases();
    const txn = await ledgerRow(itemId, "-0.500", 1);
    await db.stockCountRebase.create({
      data: {
        sessionId, lineId, inventoryItemId: itemId,
        countedQuantity: "11.500", stockBefore: "12.000",
        replayedDelta: "0.000", replayedMovementCount: 0,
        stockAfter: "11.500", rebaseItemVersion: BigInt(1),
        ledgerTransactionId: txn.id, rebasedById: userId,
      },
    });

    await assert.rejects(
      () => db.inventoryTransaction.delete({ where: { id: txn.id } }),
      /Foreign key|constraint|P2003/i,
      "the ledger row a rebase explains must outlive the explanation"
    );
    await assert.rejects(
      () => db.inventoryItem.delete({ where: { id: itemId } }),
      /Foreign key|constraint|P2003/i,
      "and so must the item"
    );
  });

  test("every relation is a real foreign key with the intended delete rule", async () => {
    const rules = await db.$queryRaw<{ column_name: string; foreign_table: string; delete_rule: string }[]>`
      SELECT kcu.column_name, ccu.table_name AS foreign_table, rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = current_schema()
         AND tc.table_name = 'StockCountRebase'
    `;
    const of = (column: string) => rules.find((r) => r.column_name === column);

    // Cascade where the rebase is owned by the count it came from — deleting
    // the count means the rebase record has nothing left to explain.
    assert.equal(of("sessionId")?.foreign_table, "StockCountSession");
    assert.equal(of("sessionId")?.delete_rule, "CASCADE");
    assert.equal(of("lineId")?.foreign_table, "StockCountLine");
    assert.equal(of("lineId")?.delete_rule, "CASCADE");

    // Restrict where the rebase points OUT at something that must survive it.
    assert.equal(of("inventoryItemId")?.foreign_table, "InventoryItem");
    assert.equal(of("inventoryItemId")?.delete_rule, "RESTRICT");
    assert.equal(of("ledgerTransactionId")?.foreign_table, "InventoryTransaction");
    assert.equal(of("ledgerTransactionId")?.delete_rule, "RESTRICT");
    assert.equal(of("rebasedById")?.foreign_table, "User");
    assert.equal(
      of("rebasedById")?.delete_rule, "RESTRICT",
      "somebody rebased the shelf, and that cannot become nobody"
    );
  });

  test("the back-relations that were deferred until this table existed are here", async () => {
    await clearRebases();
    const txn = await ledgerRow(itemId, "-0.500", 1);
    await db.stockCountRebase.create({
      data: {
        sessionId, lineId, inventoryItemId: itemId,
        countedQuantity: "11.500", stockBefore: "12.000",
        replayedDelta: "0.000", replayedMovementCount: 0,
        stockAfter: "11.500", rebaseItemVersion: BigInt(1),
        ledgerTransactionId: txn.id, rebasedById: userId,
      },
    });

    const session = await db.stockCountSession.findUniqueOrThrow({
      where: { id: sessionId }, include: { rebases: true },
    });
    assert.equal(session.rebases.length, 1, "the session reaches what it rebased");

    const line = await db.stockCountLine.findUniqueOrThrow({
      where: { id: lineId }, include: { rebase: true },
    });
    assert.equal(line.rebase?.inventoryItemId, itemId, "and the line reaches its own");
  });

  test("three decimals survive the round trip", async () => {
    await clearRebases();
    const txn = await ledgerRow(itemId, "0.018", 1);
    const r = await db.stockCountRebase.create({
      data: {
        sessionId, lineId, inventoryItemId: itemId,
        countedQuantity: "12.018", stockBefore: "12.000",
        replayedDelta: "0.000", replayedMovementCount: 0,
        stockAfter: "12.018", rebaseItemVersion: BigInt(1),
        ledgerTransactionId: txn.id, rebasedById: userId,
      },
    });
    assert.equal(Number(r.countedQuantity), 12.018, "18 g of coffee is not 20 g");
    assert.equal(Number(r.stockAfter), 12.018);
    assert.equal(Number(txn.quantity), 0.018);
  });
});
