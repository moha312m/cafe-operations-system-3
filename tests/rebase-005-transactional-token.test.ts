// REBASE-005 — the rebase can join a transaction it did not open, and carry
// the token that lets it through the freeze.
//
// SH-20 accepts a handover in ONE transaction: settle, rebase, boundary, lock,
// variance, custody, shift close, completion, freeze release. The rebase in
// the middle of that list is the one step that, at `83d7da4`, could not
// participate. `rebaseFromCount` opens its own transaction per line, so a
// later failure in the acceptance would leave a rebased shelf behind a rolled
// back acceptance — the exact half-state SH-20 exists to make impossible.
//
// It also could not run at all: acceptance holds the inventory freeze it is
// about to release, and `applyStockMutation` refuses any movement on a frozen
// branch whose token it does not recognise. Releasing the freeze first to make
// the rebase pass is forbidden — that would open the shelf to sales in the
// middle of the acceptance, which is what the freeze exists to prevent.
//
// So this suite pins two properties of a new entry point, and nothing else:
//
//   * it writes through the CALLER's transaction, so the caller's rollback is
//     total and no inner transaction escapes it;
//   * it forwards a freeze token to the real writer, so the handover that owns
//     the freeze may move stock through it and nobody else may.
//
// Arithmetic is deliberately NOT re-tested here. REBASE-002/003/004 own the
// cursor, the replay, the rounding and the resumption semantics, and the last
// assertion below proves the two entry points agree rather than restating what
// they already prove.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { db, tag, teardownTaggedCafe } from "./helpers/db";
import { applyStockMutation } from "@/lib/ledger";
import { rebaseFromCount, rebaseFromCountInTransaction } from "@/lib/stock-rebase";
import { acquireInventoryFreeze, releaseInventoryFreeze } from "@/lib/inventory-freeze";

const MARKER = tag("REBASE005");

let cafeId: string;
let branchId: string;
let userId: string;
let staffId: string;
let outgoingShiftId: string;
let freezeHandoverId: string;
let otherHandoverId: string;

/**
 * A second client, so "did anything survive the caller's rollback?" is asked
 * over a connection that was never inside that transaction. Reading through
 * the shared client would answer the same question most of the time and would
 * not be proof: the thing being ruled out is an inner transaction that
 * COMMITTED independently, and only an outside observer can see one.
 */
const observer = new PrismaClient();

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

  const shift = async (n: number) =>
    (await db.shift.create({
      data: {
        cafeId, branchId, cashierId: staffId, shiftNumber: n,
        openingCashAmount: 0, expectedCashAmount: 0,
      },
    })).id;
  outgoingShiftId = await shift(950001);
  const otherShiftId = await shift(950002);

  // Only one live handover may exist per branch, so the second one — which
  // exists purely to supply a token that is somebody else's — is a finished
  // handover rather than a competing live one.
  const handover = async (shiftId: string, status: "OUTGOING_SUBMITTED" | "COMPLETED") =>
    (await db.handoverSession.create({
      data: {
        cafeId, branchId, outgoingShiftId: shiftId, outgoingUserId: staffId, status,
        ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
      },
    })).id;
  freezeHandoverId = await handover(outgoingShiftId, "OUTGOING_SUBMITTED");
  otherHandoverId = await handover(otherShiftId, "COMPLETED");
});

after(() =>
  teardownTaggedCafe(cafeId, [() => observer.$disconnect()], { disconnect: true })
);

let seq = 0;

/** An item this test owns outright, with a known opening balance. */
async function makeItem(opening: string) {
  seq += 1;
  return db.inventoryItem.create({
    data: {
      cafeId, branchId, name: `${MARKER} item ${seq}`, unit: "KG",
      costPerUnit: 450, currentStock: opening,
    },
  });
}

/** A movement through the real writer, so it takes a real ledger version. */
async function move(inventoryItemId: string, quantity: number) {
  return db.$transaction((tx) =>
    applyStockMutation(tx, {
      inventoryItemId, type: "USAGE", quantity, cafeId, branchId, createdById: staffId,
    })
  );
}

/**
 * A confirmed count, capturing each line's count point the way the real
 * capture does: the item's ledger version at the moment of counting.
 */
async function confirmedCount(
  entries: { itemId: string; counted: string }[]
): Promise<string> {
  const lines = [];
  for (const entry of entries) {
    const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: entry.itemId } });
    lines.push({
      inventoryItemId: entry.itemId, unit: "KG" as const,
      expectedQuantity: String(item.currentStock),
      countedQuantity: entry.counted,
      effectiveCountedQuantity: entry.counted,
      itemVersion: item.ledgerVersion,
      countedAt: new Date(),
      disposition: "VARIANCE_CONFIRMED" as const,
    });
  }
  const session = await db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "FULL", scopeDerivation: "ALL_ELIGIBLE",
      initiatedById: userId, status: "CONFIRMED", confirmedAt: new Date(),
      lines: { create: lines },
    },
  });
  return session.id;
}

/** Hold the freeze `freezeHandoverId` owns, for the duration of one body. */
async function underFreeze<T>(body: () => Promise<T>): Promise<T> {
  await db.$transaction((tx) =>
    acquireInventoryFreeze(tx, {
      cafeId, branchId, handoverId: freezeHandoverId, startedById: userId,
    })
  );
  try {
    return await body();
  } finally {
    await db.$transaction((tx) =>
      releaseInventoryFreeze(tx, { handoverId: freezeHandoverId, actorId: userId })
    );
    await db.inventoryFreeze.deleteMany({ where: { handoverId: freezeHandoverId } });
  }
}

const stockOf = async (id: string) =>
  Number((await db.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock);

const versionOf = async (id: string) =>
  (await db.inventoryItem.findUniqueOrThrow({ where: { id } })).ledgerVersion;

const ledgerRows = (inventoryItemId: string) =>
  observer.inventoryTransaction.count({
    where: { inventoryItemId, type: "COUNT_REBASE" },
  });

const auditRows = (entityId: string) =>
  observer.auditLog.count({ where: { cafeId, action: "STOCK_REBASED", entityId } });

const rebaseRows = (sessionId: string) =>
  observer.stockCountRebase.count({ where: { sessionId } });

/** The error a frozen branch raises, however Prisma re-wraps it on the way out. */
function isFrozen(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "InventoryFrozenError" || /frozen/i.test(error.message))
  );
}

describe("REBASE-005 transactional, token-carrying rebase", () => {
  test("an untokened rebase is refused while the branch is frozen, and writes nothing", async () => {
    const item = await makeItem("12.000");
    const sessionId = await confirmedCount([{ itemId: item.id, counted: "11.500" }]);

    await underFreeze(async () => {
      await assert.rejects(
        () =>
          db.$transaction((tx) =>
            rebaseFromCountInTransaction(tx, {
              sessionId, actorId: userId, idempotencyKey: `${MARKER}-untokened`,
            })
          ),
        isFrozen,
        "a rebase with no token is just another writer, and the freeze refuses it"
      );
    });

    assert.equal(await stockOf(item.id), 12, "the shelf did not move");
    assert.equal(await rebaseRows(sessionId), 0, "no rebase record");
    assert.equal(await ledgerRows(item.id), 0, "no ledger movement");
    assert.equal(await auditRows(item.id), 0, "and nothing audited");
  });

  test("the handover that owns the freeze rebases through it, and the freeze stays held", async () => {
    const item = await makeItem("12.000");
    const sessionId = await confirmedCount([{ itemId: item.id, counted: "11.500" }]);

    await underFreeze(async () => {
      const result = await db.$transaction((tx) =>
        rebaseFromCountInTransaction(tx, {
          sessionId, actorId: userId, idempotencyKey: `${MARKER}-tokened`,
          freezeToken: freezeHandoverId,
        })
      );
      assert.equal(result.itemsRebased, 1);

      // The whole point: the shelf moved and the door is still shut. SH-20
      // releases the freeze later, in the same transaction, at step 15.
      const freeze = await db.inventoryFreeze.findUniqueOrThrow({
        where: { handoverId: freezeHandoverId },
      });
      assert.equal(freeze.releasedAt, null, "the rebase did not release the freeze");
    });

    assert.equal(await stockOf(item.id), 11.5);
    assert.equal(await rebaseRows(sessionId), 1);
    assert.equal(await ledgerRows(item.id), 1);
  });

  test("another handover's token is refused, and writes nothing", async () => {
    const item = await makeItem("12.000");
    const sessionId = await confirmedCount([{ itemId: item.id, counted: "11.500" }]);

    await underFreeze(async () => {
      await assert.rejects(
        () =>
          db.$transaction((tx) =>
            rebaseFromCountInTransaction(tx, {
              sessionId, actorId: userId, idempotencyKey: `${MARKER}-wrong`,
              freezeToken: otherHandoverId,
            })
          ),
        isFrozen,
        "a token is authority for ONE handover, not a way past the freeze"
      );
    });

    assert.equal(await stockOf(item.id), 12);
    assert.equal(await rebaseRows(sessionId), 0);
    assert.equal(await ledgerRows(item.id), 0);
  });

  test("with no freeze at all, a token neither helps nor hinders", async () => {
    const untokenedItem = await makeItem("12.000");
    const tokenedItem = await makeItem("20.000");
    const untokened = await confirmedCount([{ itemId: untokenedItem.id, counted: "11.500" }]);
    const tokened = await confirmedCount([{ itemId: tokenedItem.id, counted: "19.000" }]);

    await db.$transaction((tx) =>
      rebaseFromCountInTransaction(tx, {
        sessionId: untokened, actorId: userId, idempotencyKey: `${MARKER}-free-untokened`,
      })
    );
    await db.$transaction((tx) =>
      rebaseFromCountInTransaction(tx, {
        sessionId: tokened, actorId: userId, idempotencyKey: `${MARKER}-free-tokened`,
        freezeToken: freezeHandoverId,
      })
    );

    assert.equal(await stockOf(untokenedItem.id), 11.5);
    assert.equal(await stockOf(tokenedItem.id), 19);
  });

  test("the caller's rollback reverses every layer the rebase wrote", async () => {
    const first = await makeItem("12.000");
    const second = await makeItem("20.000");
    const sessionId = await confirmedCount([
      { itemId: first.id, counted: "11.500" },
      { itemId: second.id, counted: "19.000" },
    ]);
    const versionsBefore = [await versionOf(first.id), await versionOf(second.id)];

    await assert.rejects(
      () =>
        db.$transaction(async (tx) => {
          const result = await rebaseFromCountInTransaction(tx, {
            sessionId, actorId: userId, idempotencyKey: `${MARKER}-rollback`,
          });
          assert.equal(result.itemsRebased, 2, "both lines were applied before the failure");
          throw new Error("REBASE-005 forced acceptance failure");
        }),
      /REBASE-005 forced acceptance failure/
    );

    // Asked over a connection that was never inside that transaction, so a
    // nested transaction that had committed on its own would be visible here.
    assert.equal(await rebaseRows(sessionId), 0, "no rebase record survived");
    assert.equal(await ledgerRows(first.id), 0, "no ledger movement survived");
    assert.equal(await ledgerRows(second.id), 0);
    assert.equal(await auditRows(first.id), 0, "no audit row survived");
    assert.equal(await auditRows(second.id), 0);
    assert.equal(await stockOf(first.id), 12, "the shelf is where it was");
    assert.equal(await stockOf(second.id), 20);
    assert.equal(await versionOf(first.id), versionsBefore[0], "and so is the version");
    assert.equal(await versionOf(second.id), versionsBefore[1]);
  });

  test("a rollback after a tokened rebase under an active freeze is equally total", async () => {
    const item = await makeItem("12.000");
    const sessionId = await confirmedCount([{ itemId: item.id, counted: "11.500" }]);

    await underFreeze(async () => {
      await assert.rejects(
        () =>
          db.$transaction(async (tx) => {
            await rebaseFromCountInTransaction(tx, {
              sessionId, actorId: userId, idempotencyKey: `${MARKER}-frozen-rollback`,
              freezeToken: freezeHandoverId,
            });
            throw new Error("REBASE-005 forced acceptance failure");
          }),
        /REBASE-005 forced acceptance failure/
      );
    });

    assert.equal(await rebaseRows(sessionId), 0);
    assert.equal(await ledgerRows(item.id), 0);
    assert.equal(await stockOf(item.id), 12);
  });

  test("a second call on the same transaction finds its own uncommitted work", async () => {
    const item = await makeItem("12.000");
    const sessionId = await confirmedCount([{ itemId: item.id, counted: "11.500" }]);

    const [first, second] = await db.$transaction(async (tx) => {
      const one = await rebaseFromCountInTransaction(tx, {
        sessionId, actorId: userId, idempotencyKey: `${MARKER}-retry`,
      });
      const two = await rebaseFromCountInTransaction(tx, {
        sessionId, actorId: userId, idempotencyKey: `${MARKER}-retry`,
      });
      return [one, two];
    });

    assert.equal(first.itemsRebased, 1);
    assert.equal(first.alreadyRebased, false);
    assert.equal(second.itemsRebased, 0, "the second pass applied nothing");
    assert.equal(second.alreadyRebased, true, "and said the work was already there");

    assert.equal(await stockOf(item.id), 11.5, "one delta, not two");
    assert.equal(await rebaseRows(sessionId), 1);
    assert.equal(await ledgerRows(item.id), 1);
  });

  test("the transactional path and the wrapper produce identical arithmetic", async () => {
    // Two clones with identical histories, one through each entry point. This
    // is the whole compatibility claim: T1 changed who owns the transaction
    // and nothing about what the rebase computes.
    const throughWrapper = await makeItem("12.000");
    const throughTransaction = await makeItem("12.000");
    const wrapperSession = await confirmedCount([
      { itemId: throughWrapper.id, counted: "11.500" },
    ]);
    const transactionSession = await confirmedCount([
      { itemId: throughTransaction.id, counted: "11.500" },
    ]);

    // A movement above each line's cursor, so the replay is non-trivial.
    await move(throughWrapper.id, -0.25);
    await move(throughTransaction.id, -0.25);

    const wrapperResult = await rebaseFromCount({
      sessionId: wrapperSession, actorId: userId, idempotencyKey: `${MARKER}-parity-w`,
    });
    const transactionResult = await db.$transaction((tx) =>
      rebaseFromCountInTransaction(tx, {
        sessionId: transactionSession, actorId: userId, idempotencyKey: `${MARKER}-parity-t`,
      })
    );

    assert.deepEqual(
      { ...transactionResult.lines[0], inventoryItemId: undefined },
      { ...wrapperResult.lines[0], inventoryItemId: undefined },
      "same stockBefore, same replayedDelta, same stockAfter"
    );
    assert.equal(transactionResult.itemsRebased, wrapperResult.itemsRebased);
    assert.equal(transactionResult.itemsSkipped, wrapperResult.itemsSkipped);

    const wrapperRow = await db.stockCountRebase.findFirstOrThrow({
      where: { sessionId: wrapperSession },
    });
    const transactionRow = await db.stockCountRebase.findFirstOrThrow({
      where: { sessionId: transactionSession },
    });
    assert.equal(transactionRow.rebaseItemVersion, wrapperRow.rebaseItemVersion);
    assert.equal(
      Number(transactionRow.replayedDelta), Number(wrapperRow.replayedDelta)
    );
    assert.equal(Number(transactionRow.stockAfter), Number(wrapperRow.stockAfter));
    assert.equal(
      transactionRow.replayedMovementCount, wrapperRow.replayedMovementCount
    );
    assert.equal(await stockOf(throughTransaction.id), await stockOf(throughWrapper.id));
  });
});
