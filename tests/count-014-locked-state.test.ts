// COUNT-014 (T30) — a count somebody has accepted is a count that is closed.
//
// A state that means nothing is worse than no state at all, because readers
// infer meaning from the name. `LOCKED` sat in the enum through the whole
// schema phase without one, so this task gives it exactly one entry point and
// exactly one consequence:
//
//   ENTRY. A CONFIRMED session becomes LOCKED when an accepted handover has
//   rebased stock from it and transferred custody. `lockedByHandoverId` names
//   that handover, so the reason a count is closed is always readable from
//   the count itself rather than inferred from dates.
//
//   CONSEQUENCE. Correcting a locked count is still possible — a mistake
//   found after a handover is still a mistake — but it is flagged
//   `postCustodyTransfer`. Changing a figure the incoming custodian has
//   already accepted is a different act from correcting a draft, and somebody
//   reviewing it later needs to be able to tell which they are looking at.
//
// The last test is the one that keeps this fixed rather than answered once:
// it enumerates `StockCountStatus` from the database and requires every value
// either to be the entry state or to have an inbound edge in the session
// transition map. A future status added with no way in fails here.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, stockReasonCode, type CountCafe } from "./helpers/count";
import {
  COUNT_SESSION_ENTRY_STATUS,
  COUNT_SESSION_TRANSITIONS,
  isCountLocked,
  lockCountSession,
} from "@/lib/stock-count";
import type { StockCountStatus } from "@prisma/client";

let fx: CountCafe;
let reasonCodeId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("COUNT014");
  reasonCodeId = (await stockReasonCode(fx.cafeId, "MISCOUNT", "خطأ في العد")).id;
});

after(() => teardownTaggedCafe(fx?.cafeId, [], { disconnect: true }));

let seq = 0;

/**
 * A handover for the count to be locked BY.
 *
 * Previous ones are cleared first: a branch may have only one live handover,
 * the same way it may have only one live count. `lockedByHandoverId` is
 * SET NULL on delete, so removing a spent fixture leaves the count intact —
 * which is the schema saying a count outlives the handover that froze it.
 */
async function handover() {
  await db.handoverSession.deleteMany({ where: { cafeId: fx.cafeId } });
  seq += 1;
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id,
      shiftNumber: 9000 + seq, openingCashAmount: 0, expectedCashAmount: 0,
    },
  });
  return db.handoverSession.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      outgoingShiftId: shift.id, outgoingUserId: fx.cashier.id,
    },
    select: { id: true },
  });
}

/** A confirmed count of one item, captured through the real capture API. */
async function confirmedCount(counted = 8) {
  await db.varianceCase.deleteMany({ where: { cafeId: fx.cafeId } });
  await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
  seq += 1;
  const it = await countItem(fx, `item ${seq}`, { stock: 10, isCritical: true });
  const s = await db.stockCountSession.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, type: "CRITICAL",
      scopeDerivation: "CRITICAL_ONLY", status: "IN_PROGRESS",
      initiatedById: fx.manager.id,
      lines: { create: [{ inventoryItemId: it.id, unit: "KG" }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  });
  const lineId = s.lines[0].id;
  const captured = await as(fx.cashier.email, `/api/stock-counts/${s.id}/lines/${lineId}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity: counted }),
  });
  assert.ok(captured.status < 300, `fixture capture failed: ${captured.text}`);

  await db.stockCountLine.update({
    where: { id: lineId }, data: { disposition: "WITHIN_TOLERANCE" },
  });
  await db.stockCountSession.update({
    where: { id: s.id },
    data: { status: "CONFIRMED", confirmedAt: new Date(), confirmedById: fx.manager.id },
  });
  return { sessionId: s.id, lineId, itemId: it.id };
}

describe("COUNT-014 the LOCKED state", () => {
  test("locking a confirmed count records which handover closed it", async () => {
    const { sessionId } = await confirmedCount();
    const h = await handover();

    const result = await db.$transaction((tx) =>
      lockCountSession(tx, { sessionId, handoverId: h.id, actorId: fx.manager.id })
    );
    assert.equal(result.status, "LOCKED");
    assert.ok(result.lockedAt);

    const stored = await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(stored.status, "LOCKED");
    assert.ok(stored.lockedAt);
    assert.equal(
      stored.lockedByHandoverId, h.id,
      "the reason a count is closed reads off the count, not off the dates"
    );
  });

  test("locking writes its audit row inside the same transaction", async () => {
    // The lock happens inside the handover-accept transaction, so a record of
    // it that could commit independently would be a statement about a custody
    // transfer that may not have happened.
    const { sessionId } = await confirmedCount();
    const h = await handover();
    await db.$transaction((tx) =>
      lockCountSession(tx, { sessionId, handoverId: h.id, actorId: fx.manager.id })
    );

    const row = await db.auditLog.findFirst({
      where: { cafeId: fx.cafeId, action: "COUNT_LOCKED", entityId: sessionId },
    });
    assert.ok(row);
    assert.equal((row!.details as Record<string, unknown>).handoverId, h.id);

    // And a lock that rolls back leaves neither the state nor the record.
    const second = await confirmedCount();
    const h2 = await handover();
    await assert.rejects(() =>
      db.$transaction(async (tx) => {
        await lockCountSession(tx, {
          sessionId: second.sessionId, handoverId: h2.id, actorId: fx.manager.id,
        });
        throw new Error("the handover failed after the lock");
      })
    );
    const rolledBack = await db.stockCountSession.findUniqueOrThrow({
      where: { id: second.sessionId },
    });
    assert.equal(rolledBack.status, "CONFIRMED", "the lock rolled back with its transaction");
    assert.equal(
      await db.auditLog.count({
        where: { cafeId: fx.cafeId, action: "COUNT_LOCKED", entityId: second.sessionId },
      }),
      0,
      "and so did the record of it"
    );
  });

  test("a count nobody confirmed cannot be locked", async () => {
    const { sessionId } = await confirmedCount();
    await db.stockCountSession.update({
      where: { id: sessionId }, data: { status: "SUBMITTED", confirmedAt: null },
    });
    const h = await handover();

    await assert.rejects(
      () => db.$transaction((tx) =>
        lockCountSession(tx, { sessionId, handoverId: h.id, actorId: fx.manager.id })
      ),
      /CONFIRMED|مأكد|أكد/,
      "only a count somebody signed can become the baseline a handover accepts"
    );
    assert.equal(
      (await db.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } })).status,
      "SUBMITTED"
    );
  });

  test("a new count cannot be recorded against a locked session", async () => {
    const { sessionId, lineId } = await confirmedCount();
    const h = await handover();
    await db.$transaction((tx) =>
      lockCountSession(tx, { sessionId, handoverId: h.id, actorId: fx.manager.id })
    );

    const r = await as(fx.cashier.email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
      method: "PATCH", body: JSON.stringify({ countedQuantity: 99 }),
    });
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${r.text}`);
    assert.equal(
      Number((await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } })).countedQuantity),
      8
    );
  });

  test("correcting a locked count still works, and is flagged as post-transfer", async () => {
    const { sessionId, lineId } = await confirmedCount();
    const h = await handover();
    await db.$transaction((tx) =>
      lockCountSession(tx, { sessionId, handoverId: h.id, actorId: fx.manager.id })
    );

    const proposed = await as<{ correctionId?: string }>(
      fx.manager.email,
      `/api/stock-counts/${sessionId}/lines/${lineId}/correction`,
      { method: "POST", body: JSON.stringify({ newCountedQuantity: 9, reasonCodeId }) }
    );
    assert.ok(
      proposed.status < 300,
      `a mistake found after a handover is still a mistake: ${proposed.text}`
    );

    const stored = await db.stockCountCorrection.findUniqueOrThrow({
      where: { id: proposed.body.correctionId! },
    });
    assert.equal(
      stored.postCustodyTransfer, true,
      "changing a figure another party already accepted is a different act"
    );

    const audited = await db.auditLog.findFirst({
      where: { cafeId: fx.cafeId, action: "CORRECTION_CREATED", entityId: stored.id },
    });
    assert.equal((audited!.details as Record<string, unknown>).postCustodyTransfer, true);

    // And it still needs the second signature — locking changes the flag, not
    // the approval requirement.
    const own = await as(fx.manager.email, `/api/corrections/${stored.id}/approve`, {
      method: "POST", body: "{}",
    });
    assert.equal(own.status, 403);

    const signed = await as<{ effectiveCountedQuantity?: number }>(
      fx.owner.email, `/api/corrections/${stored.id}/approve`, { method: "POST", body: "{}" }
    );
    assert.ok(signed.status < 300, signed.text);
    assert.equal(signed.body.effectiveCountedQuantity, 9);

    const line = await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });
    assert.equal(Number(line.countedQuantity), 8, "and the evidence is still the evidence");
    assert.equal(Number(line.effectiveCountedQuantity), 9);
  });

  test("a correction before any lock is not flagged", async () => {
    // The non-vacuity partner to the test above: if the flag were always
    // true, it would say nothing.
    const { sessionId, lineId } = await confirmedCount();
    const proposed = await as<{ correctionId?: string }>(
      fx.manager.email,
      `/api/stock-counts/${sessionId}/lines/${lineId}/correction`,
      { method: "POST", body: JSON.stringify({ newCountedQuantity: 9, reasonCodeId }) }
    );
    assert.ok(proposed.status < 300, proposed.text);
    const stored = await db.stockCountCorrection.findUniqueOrThrow({
      where: { id: proposed.body.correctionId! },
    });
    assert.equal(stored.postCustodyTransfer, false);
  });

  test("isCountLocked is true for LOCKED and for nothing else", async () => {
    const statuses: StockCountStatus[] = [
      "DRAFT", "IN_PROGRESS", "SUBMITTED", "RECOUNT_REQUIRED", "CONFIRMED", "LOCKED",
    ];
    for (const status of statuses) {
      assert.equal(
        isCountLocked({ status }), status === "LOCKED",
        `isCountLocked disagreed about ${status}`
      );
    }
  });

  test("every session status is reachable — the entry state, or something leads to it", async () => {
    // Enumerated from the database rather than from a hand-written list, so a
    // status added by a later migration cannot slip in with no way into it.
    const values = await db.$queryRaw<{ label: StockCountStatus }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'StockCountStatus' ORDER BY e.enumsortorder
    `;
    const inbound = new Set<string>();
    for (const targets of Object.values(COUNT_SESSION_TRANSITIONS)) {
      for (const t of targets) inbound.add(t);
    }

    for (const { label } of values) {
      assert.ok(
        label === COUNT_SESSION_ENTRY_STATUS || inbound.has(label),
        `${label} is a state nothing can ever enter`
      );
      assert.ok(
        label in COUNT_SESSION_TRANSITIONS,
        `${label} exists in the database but not in the transition map`
      );
    }

    assert.deepEqual(
      COUNT_SESSION_TRANSITIONS.LOCKED, [],
      "LOCKED is where a count stops — reopening it would let an accepted " +
        "record be quietly rewritten"
    );
  });
});
