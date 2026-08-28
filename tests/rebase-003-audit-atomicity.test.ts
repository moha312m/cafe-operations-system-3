// REBASE-003 — no committed rebase without its audit record.
//
// T23 first wrote the audit row AFTER the stock transaction committed, on the
// usual reasoning: `audit` is fire-and-forget, and a logging failure must not
// destroy a real action. That reasoning is right for almost everything in
// this system and wrong for this one operation.
//
// A COUNT_REBASE is not an action with a note attached. It moves a shelf on
// the authority of a physical count, and the audit row is where the whole
// arithmetic lives — the count point, the figure acted on, what moved during
// the count, the balance before, the balance after, and who did it. A rebase
// that committed with its audit row missing is not a successful write with a
// gap in the log; it is stock that changed for reasons nobody can
// reconstruct, on a shelf somebody will later be held answerable for.
//
// So the three evidence layers commit together: the StockCountRebase record,
// the COUNT_REBASE ledger movement, and the audit row. `auditInTransaction`
// throws where `audit` swallows, and it takes the caller's transaction client
// so there is no second transaction that could succeed or fail on its own.
//
// The failure test does not simulate. It installs a Postgres trigger that
// raises on the audit INSERT for one specific item, so the failure happens
// exactly where it must: after the session was validated, after the replay
// was computed, after the stock mutation ran — and before commit.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { applyStockMutation } from "@/lib/ledger";
import { REBASE_AUDIT_ACTION, rebaseFromCount } from "@/lib/stock-rebase";
import { TXN_AUDIT_ACTION } from "@/lib/inventory";

const MARKER = tag("REBASE003");
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

async function makeItem(opening: string) {
  seq += 1;
  return db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} item ${seq}`, unit: "KG",
      costPerUnit: 450, currentStock: opening,
    },
  });
}

/** A confirmed count over one or more items, capturing each count point. */
async function confirmedCount(entries: { itemId: string; counted: string }[]) {
  const items = await db.inventoryItem.findMany({
    where: { id: { in: entries.map((e) => e.itemId) } },
  });
  const versionOf = (id: string) =>
    items.find((i) => i.id === id)?.ledgerVersion ?? BigInt(0);

  const session = await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: userId, status: "CONFIRMED", confirmedAt: new Date(),
      lines: {
        create: entries.map((e) => ({
          inventoryItemId: e.itemId, unit: "KG" as const,
          countedQuantity: e.counted,
          effectiveCountedQuantity: e.counted,
          itemVersion: versionOf(e.itemId),
          countedAt: new Date(),
          disposition: "VARIANCE_CONFIRMED" as const,
        })),
      },
    },
    include: { lines: true },
  });
  return { sessionId: session.id, lines: session.lines };
}

/**
 * Make the audit INSERT for one item fail, at the database, mid-transaction.
 *
 * A trigger rather than a stub: the point is to prove the ATOMICITY BOUNDARY,
 * and a stub that threw before the transaction opened would prove only that
 * an exception propagates. This fires during the same transaction as the
 * stock mutation, which is the only place the question is interesting.
 */
async function blockAuditFor(inventoryItemId: string) {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ph1_block_rebase_audit() RETURNS trigger AS $fn$
    BEGIN
      IF NEW."action" = '${REBASE_AUDIT_ACTION}'
         AND NEW."details"->>'inventoryItemId' = '${inventoryItemId}' THEN
        RAISE EXCEPTION 'rebase audit insert blocked by REBASE-003';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  // One command per call: Postgres refuses multiple statements in a prepared
  // statement, which is what `$executeRawUnsafe` sends.
  await db.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ph1_block_rebase_audit_trg ON "AuditLog"`
  );
  await db.$executeRawUnsafe(`
    CREATE TRIGGER ph1_block_rebase_audit_trg
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION ph1_block_rebase_audit()
  `);
}

async function unblockAudit() {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ph1_block_rebase_audit_trg ON "AuditLog"`);
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ph1_block_rebase_audit()`);
}

const stockOf = async (id: string) =>
  Number((await db.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock);
const versionOf = async (id: string) =>
  (await db.inventoryItem.findUniqueOrThrow({ where: { id } })).ledgerVersion;
const ledgerRows = (inventoryItemId: string) =>
  db.inventoryTransaction.count({ where: { inventoryItemId, type: "COUNT_REBASE" } });
const auditRows = (inventoryItemId: string) =>
  db.auditLog.count({ where: { cafeId, action: REBASE_AUDIT_ACTION, entityId: inventoryItemId } });

describe("REBASE-003 no committed rebase without its audit record", () => {
  test("there is one canonical audit action for a rebase", async () => {
    // Two names for one event is two half-answers to "show me every rebase".
    assert.equal(REBASE_AUDIT_ACTION, "STOCK_REBASED", "the name Revision 3 gives it");
    assert.equal(
      TXN_AUDIT_ACTION.COUNT_REBASE, REBASE_AUDIT_ACTION,
      "the transaction-type map carries the same string, not an alias"
    );
    assert.notEqual(
      TXN_AUDIT_ACTION.COUNT_REBASE, TXN_AUDIT_ACTION.ADJUSTMENT,
      "and still not a manager's tweak"
    );
  });

  test("one rebase commits all three evidence layers, with matching ids", async () => {
    const item = await makeItem("12.000");
    await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: item.id, type: "USAGE", quantity: -0.5,
        cafeId, branchId, createdById: staffId,
      })
    );
    const { sessionId, lines } = await confirmedCount([
      { itemId: item.id, counted: "11.000" },
    ]);
    await db.$transaction((tx) =>
      applyStockMutation(tx, {
        inventoryItemId: item.id, type: "USAGE", quantity: -0.25,
        cafeId, branchId, createdById: staffId,
      })
    );

    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-ok` });

    const rebases = await db.stockCountRebase.findMany({ where: { sessionId } });
    const txns = await db.inventoryTransaction.findMany({
      where: { inventoryItemId: item.id, type: "COUNT_REBASE" },
    });
    const audits = await db.auditLog.findMany({
      where: { cafeId, action: REBASE_AUDIT_ACTION, entityId: item.id },
    });

    assert.equal(rebases.length, 1, "one StockCountRebase row");
    assert.equal(txns.length, 1, "one COUNT_REBASE ledger row");
    assert.equal(audits.length, 1, "one audit row");

    // The three layers name the same operation.
    assert.equal(rebases[0].ledgerTransactionId, txns[0].id);
    const d = audits[0].details as Record<string, unknown>;
    assert.equal(d.ledgerTransactionId, txns[0].id, "the audit names the ledger row");
    assert.equal(d.sessionId, sessionId);
    assert.equal(d.lineId, lines[0].id);
    assert.equal(d.inventoryItemId, item.id);
    assert.equal(d.branchId, branchId);
    assert.equal(audits[0].userId, userId, "and who did it");

    // …and the whole arithmetic is there.
    assert.equal(d.originalCountedQuantity, 11);
    assert.equal(d.effectiveCountedQuantity, 11);
    assert.equal(d.stockBefore, 11.25);
    assert.equal(d.replayedDelta, -0.25);
    assert.equal(d.replayedMovementCount, 1);
    assert.equal(d.stockAfter, 10.75);
    assert.equal(d.appliedDelta, -0.5);
    assert.equal(d.rebaseItemVersion, Number(txns[0].itemVersion));
  });

  test("a failing audit insert rolls back the stock write with it", async () => {
    const item = await makeItem("12.000");
    const before = {
      stock: await stockOf(item.id),
      version: await versionOf(item.id),
      ledger: await ledgerRows(item.id),
      rebases: await db.stockCountRebase.count({ where: { inventoryItemId: item.id } }),
      audits: await auditRows(item.id),
    };
    const { sessionId } = await confirmedCount([{ itemId: item.id, counted: "11.500" }]);

    await blockAuditFor(item.id);
    try {
      await assert.rejects(
        () => rebaseFromCount({
          sessionId, actorId: userId, idempotencyKey: `${MARKER}-blocked`,
        }),
        /blocked by REBASE-003/,
        "the audit insert must fail, or this test proves nothing"
      );
    } finally {
      await unblockAudit();
    }

    assert.equal(await stockOf(item.id), before.stock, "currentStock unchanged");
    assert.equal(await versionOf(item.id), before.version, "ledgerVersion unchanged");
    assert.equal(await ledgerRows(item.id), before.ledger, "no COUNT_REBASE row");
    assert.equal(
      await db.stockCountRebase.count({ where: { inventoryItemId: item.id } }),
      before.rebases, "no StockCountRebase row"
    );
    assert.equal(await auditRows(item.id), before.audits, "and no audit row");
    assert.equal(before.ledger, 0, "…from a starting point that was genuinely empty");
  });

  test("after the block is lifted, the same rebase applies cleanly", async () => {
    // The rollback left nothing behind, so a retry is a first attempt rather
    // than a resume — which is the difference between rolling back and
    // half-committing.
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount([{ itemId: item.id, counted: "11.500" }]);

    await blockAuditFor(item.id);
    try {
      await assert.rejects(() => rebaseFromCount({
        sessionId, actorId: userId, idempotencyKey: `${MARKER}-recover`,
      }));
    } finally {
      await unblockAudit();
    }

    const result = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-recover`,
    });
    assert.equal(result.itemsRebased, 1, "it applied, rather than reporting prior work");
    assert.equal(result.alreadyRebased, false);
    assert.equal(await stockOf(item.id), 11.5);
    assert.equal(await ledgerRows(item.id), 1);
    assert.equal(await auditRows(item.id), 1);
  });

  test("a retry writes no second audit row", async () => {
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount([{ itemId: item.id, counted: "11.500" }]);
    const key = `${MARKER}-retry`;

    await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: key });
    const second = await rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: key });

    assert.equal(second.alreadyRebased, true);
    assert.equal(second.itemsRebased, 0);
    assert.equal(await db.stockCountRebase.count({ where: { sessionId } }), 1);
    assert.equal(await ledgerRows(item.id), 1);
    assert.equal(
      await auditRows(item.id), 1,
      "the audit layer must not be the one component that duplicates"
    );
  });

  test("three concurrent retries produce exactly one of each", async () => {
    const item = await makeItem("12.000");
    const { sessionId } = await confirmedCount([{ itemId: item.id, counted: "11.500" }]);

    await Promise.allSettled([
      rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-c1` }),
      rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-c2` }),
      rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-c3` }),
    ]);

    assert.equal(await db.stockCountRebase.count({ where: { sessionId } }), 1, "one rebase");
    assert.equal(await ledgerRows(item.id), 1, "one ledger effect");
    assert.equal(await auditRows(item.id), 1, "one audit record");
    assert.equal(await stockOf(item.id), 11.5);
  });

  // ── multi-item semantics: one transaction PER ITEM (Revision 3) ─────
  test("a failure on one item leaves the items already done intact", async () => {
    // Revision 3 scopes the transaction to the item, not the session: "Per
    // item, in one transaction holding that item's lock." So a session is a
    // sequence of atomic per-item rebases with session-level idempotent
    // resume, and this test pins what that buys and what it costs.
    const first = await makeItem("12.000");
    const second = await makeItem("20.000");
    const { sessionId } = await confirmedCount([
      { itemId: first.id, counted: "11.500" },
      { itemId: second.id, counted: "19.000" },
    ]);

    await blockAuditFor(second.id);
    try {
      await assert.rejects(
        () => rebaseFromCount({ sessionId, actorId: userId, idempotencyKey: `${MARKER}-multi` }),
        /blocked by REBASE-003/
      );
    } finally {
      await unblockAudit();
    }

    // Item 1 committed, whole and consistent across all three layers.
    assert.equal(await stockOf(first.id), 11.5, "the item already done stands");
    assert.equal(await ledgerRows(first.id), 1);
    assert.equal(await auditRows(first.id), 1);

    // Item 2 is completely unapplied — no layer half-landed.
    assert.equal(await stockOf(second.id), 20, "the failing item did not move");
    assert.equal(await ledgerRows(second.id), 0);
    assert.equal(await auditRows(second.id), 0);
    assert.equal(
      await db.stockCountRebase.count({ where: { sessionId, inventoryItemId: second.id } }), 0
    );
    assert.equal(await db.stockCountRebase.count({ where: { sessionId } }), 1, "one of two");
  });

  test("a resume finishes the rest without re-applying what was done", async () => {
    const first = await makeItem("12.000");
    const second = await makeItem("20.000");
    const { sessionId } = await confirmedCount([
      { itemId: first.id, counted: "11.500" },
      { itemId: second.id, counted: "19.000" },
    ]);

    await blockAuditFor(second.id);
    try {
      await assert.rejects(() => rebaseFromCount({
        sessionId, actorId: userId, idempotencyKey: `${MARKER}-resume`,
      }));
    } finally {
      await unblockAudit();
    }

    const resumed = await rebaseFromCount({
      sessionId, actorId: userId, idempotencyKey: `${MARKER}-resume`,
    });

    assert.equal(resumed.itemsRebased, 1, "only the one that had not been done");
    assert.equal(resumed.alreadyRebased, true, "and it says the rest was already there");
    assert.equal(await stockOf(second.id), 19, "the second item is now rebased");

    // The first item was not touched a second time.
    assert.equal(await stockOf(first.id), 11.5);
    assert.equal(await ledgerRows(first.id), 1, "still one ledger row for the first item");
    assert.equal(await auditRows(first.id), 1, "and still one audit row");
    assert.equal(await ledgerRows(second.id), 1);
    assert.equal(await auditRows(second.id), 1);
    assert.equal(await db.stockCountRebase.count({ where: { sessionId } }), 2, "two of two");
  });

  test("the blocking trigger is gone", async () => {
    // A test that installs a database trigger and leaves it behind would
    // poison every suite that runs afterwards.
    const rows = await db.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgname = 'ph1_block_rebase_audit_trg'
    `;
    assert.deepEqual(rows, [], "the trigger was dropped");
    const fns = await db.$queryRaw<{ proname: string }[]>`
      SELECT proname FROM pg_proc WHERE proname = 'ph1_block_rebase_audit'
    `;
    assert.deepEqual(fns, [], "and so was its function");
  });
});
