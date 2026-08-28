// COUNT-011 (T27) — a real shortage can be confirmed, not merely re-argued.
//
// An earlier revision refused confirmation while any line was unresolved and
// offered no transition by which a genuine outside-tolerance variance could
// ever BECOME resolved. A shop with a real 2 kg shortage could never close
// its count, and the only way out was to falsify the figure. The escape is
// `VARIANCE_CONFIRMED`: an explicit terminal disposition meaning "this
// difference is real and somebody with authority said so".
//
// The runtime machine implemented here is `DISPOSITION_TRANSITIONS` (T13),
// not a second copy of it. That map is the accepted one and this suite holds
// the runtime to it, including where it differs from an earlier draft:
//
//   • a line outside tolerance goes COUNTED → OUTSIDE_TOLERANCE first, and
//     only then to RECOUNT_REQUIRED if the owner requires a recount. There is
//     no COUNTED → RECOUNT_REQUIRED edge, so the reason a recount was asked
//     for is always recorded as a state the line actually passed through.
//
//   • exhausting the attempts does NOT auto-confirm the variance. The line
//     stays RECOUNT_REQUIRED with nothing left to try, and the only exit is
//     an authorised acceptance. Auto-confirming would let a counter reach
//     "confirmed shortage" — a figure that can carry somebody's name — by
//     doing nothing but counting badly twice.
//
// Recounting and signing off are different powers, held by different people.
// The store keeper may recount; only `stock_count.confirm` may accept a
// variance, so the person who counted cannot wave their own through.
//
// And a recount re-captures at its OWN count point. Reusing the first
// capture would reintroduce exactly the staleness the lock/version contract
// exists to prevent.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, stockReasonCode, type CountCafe } from "./helpers/count";
import { applyStockMutation } from "@/lib/ledger";
import { submitCountSession } from "@/lib/stock-count";
import { classifyRecounter } from "@/lib/recount";
import { canTransition, isTerminal } from "@/lib/count-disposition";

let fx: CountCafe;
let reasonCodeId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("COUNT011");
  reasonCodeId = (await stockReasonCode(fx.cafeId, "SPOILAGE", "تلف")).id;
  // A bound the assertions can aim at: without a rule, tolerance is
  // exact-match and "within tolerance" would only ever mean zero.
  await db.toleranceRule.create({
    data: { cafeId: fx.cafeId, scope: "BRANCH", branchId: fx.branchId, quantityTolerance: "0.5" },
  });
});

after(() => teardownTaggedCafe(fx?.cafeId, [], { disconnect: true }));

let seq = 0;
async function item(stock: number) {
  seq += 1;
  return countItem(fx, `item ${seq}`, { stock, isCritical: true });
}

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

/** A session over the given items, with each already counted at `counted`. */
async function countedSession(specs: { itemId: string; counted: number }[]) {
  await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
  const s = await db.stockCountSession.create({
    data: {
      cafeId: fx.cafeId,
      branchId: fx.branchId,
      type: "CRITICAL",
      scopeDerivation: "CRITICAL_ONLY",
      status: "IN_PROGRESS",
      initiatedById: fx.manager.id,
      lines: { create: specs.map((sp) => ({ inventoryItemId: sp.itemId, unit: "KG" as const })) },
    },
    select: { id: true, lines: { select: { id: true, inventoryItemId: true } } },
  });

  for (const spec of specs) {
    const lineId = s.lines.find((l) => l.inventoryItemId === spec.itemId)!.id;
    const r = await as(fx.cashier.email, `/api/stock-counts/${s.id}/lines/${lineId}`, {
      method: "PATCH",
      body: JSON.stringify({ countedQuantity: spec.counted }),
    });
    assert.ok(r.status < 300, `fixture capture failed: ${r.text}`);
  }

  return { id: s.id, lineFor: (i: string) => s.lines.find((l) => l.inventoryItemId === i)!.id };
}

const lineRow = (lineId: string) =>
  db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });

const recount = (email: string, sessionId: string, lineId: string, body: unknown) =>
  as<{ attempt?: number; kind?: string; disposition?: string; attemptsRemaining?: number; error?: string }>(
    email,
    `/api/stock-counts/${sessionId}/lines/${lineId}/recount`,
    { method: "POST", body: JSON.stringify(body) }
  );

const acceptVariance = (email: string, sessionId: string, lineId: string, body: unknown) =>
  as<{ disposition?: string; error?: string }>(
    email,
    `/api/stock-counts/${sessionId}/lines/${lineId}/accept-variance`,
    { method: "POST", body: JSON.stringify(body) }
  );

async function setRecountPolicy(data: {
  recountRequiredOutsideTolerance?: boolean;
  recountMaxAttempts?: number;
  allowSelfRecount?: boolean;
}) {
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data });
}

describe("COUNT-011 recount engine and terminal dispositions", () => {
  test("a line inside tolerance is settled at submission and leads nowhere", async () => {
    await setRecountPolicy({ recountRequiredOutsideTolerance: true, recountMaxAttempts: 2 });
    const it = await item(10);
    const s = await countedSession([{ itemId: it.id, counted: 9.8 }]);

    const result = await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
    assert.equal(result.status, "SUBMITTED");
    assert.equal(result.within, 1);
    assert.equal(result.outside, 0);

    const line = await lineRow(s.lineFor(it.id));
    assert.equal(line.disposition, "WITHIN_TOLERANCE");
    assert.ok(isTerminal(line.disposition), "and the count no longer waits on it");
  });

  test("a line outside tolerance passes through OUTSIDE_TOLERANCE on its way to a recount", async () => {
    // Not a direct COUNTED → RECOUNT_REQUIRED jump: the reason a recount was
    // demanded is a state the line actually occupied.
    await setRecountPolicy({ recountRequiredOutsideTolerance: true, recountMaxAttempts: 2 });
    const it = await item(10);
    const s = await countedSession([{ itemId: it.id, counted: 8 }]);

    assert.ok(
      canTransition("COUNTED", "OUTSIDE_TOLERANCE") &&
        canTransition("OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED") &&
        !canTransition("COUNTED", "RECOUNT_REQUIRED"),
      "the accepted map routes a recount through OUTSIDE_TOLERANCE"
    );

    const result = await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
    assert.equal(result.status, "RECOUNT_REQUIRED");
    assert.equal(result.outside, 1);
    assert.equal((await lineRow(s.lineFor(it.id))).disposition, "RECOUNT_REQUIRED");
  });

  test("with recounts switched off, an outside line simply stands as OUTSIDE_TOLERANCE", async () => {
    await setRecountPolicy({ recountRequiredOutsideTolerance: false });
    try {
      const it = await item(10);
      const s = await countedSession([{ itemId: it.id, counted: 8 }]);
      const result = await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
      assert.equal(result.status, "SUBMITTED");
      assert.equal((await lineRow(s.lineFor(it.id))).disposition, "OUTSIDE_TOLERANCE");
    } finally {
      await setRecountPolicy({ recountRequiredOutsideTolerance: true });
    }
  });

  test("submission refuses while any shelf is still unlooked-at", async () => {
    const counted = await item(10);
    const missed = await item(10);
    await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
    const s = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, type: "CRITICAL",
        scopeDerivation: "CRITICAL_ONLY", status: "IN_PROGRESS",
        initiatedById: fx.manager.id,
        lines: {
          create: [
            { inventoryItemId: counted.id, unit: "KG", countedQuantity: "10",
              effectiveCountedQuantity: "10", expectedQuantity: "10",
              varianceQuantity: "0", disposition: "COUNTED" },
            { inventoryItemId: missed.id, unit: "KG" },
          ],
        },
      },
      select: { id: true },
    });

    await assert.rejects(
      () => submitCountSession({ sessionId: s.id, submittedById: fx.manager.id }),
      /لسه ما اتعدتش/,
      "an uncounted line must never read as a zero count"
    );
    const still = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(still.status, "IN_PROGRESS", "and the session stays open");
  });

  test("a different person recounting is INDEPENDENT; the same person is SELF_RECOUNT", async () => {
    assert.deepEqual(
      classifyRecounter({ originalCounterId: "a", recounterId: "b", allowSelfRecount: true }),
      { allowed: true, kind: "INDEPENDENT", fallbackReason: null }
    );
    const self = classifyRecounter({
      originalCounterId: "a", recounterId: "a", allowSelfRecount: true,
    });
    assert.equal(self.allowed, true);
    assert.equal(self.kind, "SELF_RECOUNT");
    assert.ok(
      self.fallbackReason,
      "a self-recount is a fallback, and must say why it was allowed at all"
    );

    const refused = classifyRecounter({
      originalCounterId: "a", recounterId: "a", allowSelfRecount: false,
    });
    assert.equal(refused.allowed, false, "the owner may require an independent recount");
  });

  test("a self-recount is recorded as one, and leaves an audit row saying so", async () => {
    await setRecountPolicy({ allowSelfRecount: true, recountMaxAttempts: 2 });
    const it = await item(10);
    const s = await countedSession([{ itemId: it.id, counted: 8 }]);
    await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
    const lineId = s.lineFor(it.id);

    // The cashier counted; the cashier holds no recount key, so the store
    // keeper is the one who can recount — making an INDEPENDENT recount the
    // easy path and a self-recount the deliberate one.
    const r = await recount(fx.storekeeper.email, s.id, lineId, { countedQuantity: 8 });
    assert.ok(r.status < 300, r.text);
    assert.equal(r.body.kind, "INDEPENDENT");

    const stored = await db.stockCountRecount.findFirstOrThrow({
      where: { lineId }, orderBy: { attempt: "desc" },
    });
    assert.equal(stored.kind, "INDEPENDENT");
    assert.equal(stored.counterId, fx.storekeeper.id);

    // Now the store keeper recounts their own recount.
    const again = await recount(fx.storekeeper.email, s.id, lineId, { countedQuantity: 8 });
    assert.ok(again.status < 300, again.text);
    assert.equal(again.body.kind, "SELF_RECOUNT");

    const audited = await db.auditLog.findFirst({
      where: { cafeId: fx.cafeId, action: "STOCK_COUNT_SELF_RECOUNT", entityId: lineId },
    });
    assert.ok(audited, "somebody checking their own work is worth writing down");
  });

  test("a recount that lands inside tolerance resolves the line", async () => {
    await setRecountPolicy({ recountMaxAttempts: 2, allowSelfRecount: true });
    const it = await item(10);
    const s = await countedSession([{ itemId: it.id, counted: 8 }]);
    await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
    const lineId = s.lineFor(it.id);

    const r = await recount(fx.storekeeper.email, s.id, lineId, { countedQuantity: 10 });
    assert.ok(r.status < 300, r.text);
    assert.equal(r.body.disposition, "RESOLVED_WITHIN_TOLERANCE");

    const line = await lineRow(lineId);
    assert.equal(line.disposition, "RESOLVED_WITHIN_TOLERANCE");
    assert.ok(isTerminal(line.disposition));
    assert.equal(
      Number(line.countedQuantity), 8,
      "the first observation is evidence and is never rewritten by a later one"
    );
    assert.equal(
      Number(line.effectiveCountedQuantity), 10,
      "but the resolving recount is what the business acts on"
    );
    assert.equal(Number(line.varianceQuantity), 0, "and the gap it closed");
    assert.equal(
      Number(line.expectedQuantity), 10,
      "the effective figure and its count point describe the same instant"
    );
  });

  test("attempts run out, and an exhausted line is not auto-blamed", async () => {
    // Exhaustion leaves the line RECOUNT_REQUIRED with nothing left to try.
    // It is NOT moved to VARIANCE_CONFIRMED automatically: that disposition
    // is a real accepted shortage that can carry somebody's name, and it must
    // come from a signature rather than from counting badly twice.
    await setRecountPolicy({ recountMaxAttempts: 2, allowSelfRecount: true });
    const it = await item(10);
    const s = await countedSession([{ itemId: it.id, counted: 8 }]);
    await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
    const lineId = s.lineFor(it.id);

    const first = await recount(fx.storekeeper.email, s.id, lineId, { countedQuantity: 8 });
    assert.equal(first.body.attempt, 1);
    assert.equal(first.body.attemptsRemaining, 1);
    assert.equal(first.body.disposition, "RECOUNT_REQUIRED");

    const second = await recount(fx.storekeeper.email, s.id, lineId, { countedQuantity: 8 });
    assert.equal(second.body.attempt, 2);
    assert.equal(second.body.attemptsRemaining, 0);
    assert.equal(second.body.disposition, "RECOUNT_REQUIRED");

    const third = await recount(fx.storekeeper.email, s.id, lineId, { countedQuantity: 8 });
    assert.equal(third.status, 409, `no attempts remain: ${third.text}`);

    const line = await lineRow(lineId);
    assert.equal(line.disposition, "RECOUNT_REQUIRED");
    assert.ok(
      !isTerminal(line.disposition),
      "still open — but the exit exists, and it needs a signature"
    );
    assert.ok(
      canTransition(line.disposition, "VARIANCE_CONFIRMED"),
      "and the map agrees that exit is legal from here"
    );
  });

  test("accepting the variance closes the line, and needs a reason and a signature", async () => {
    await setRecountPolicy({ recountRequiredOutsideTolerance: false });
    try {
      const it = await item(10);
      const s = await countedSession([{ itemId: it.id, counted: 8 }]);
      await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
      const lineId = s.lineFor(it.id);
      assert.equal((await lineRow(lineId)).disposition, "OUTSIDE_TOLERANCE");

      const noReason = await acceptVariance(fx.manager.email, s.id, lineId, {});
      assert.equal(noReason.status, 400, `a difference accepted for no stated reason: ${noReason.text}`);

      // The store keeper holds stock_count.recount but not confirm.
      const unsigned = await acceptVariance(fx.storekeeper.email, s.id, lineId, { reasonCodeId });
      assert.equal(
        unsigned.status, 403,
        "the person who counted cannot wave their own variance through"
      );
      assert.equal((await lineRow(lineId)).disposition, "OUTSIDE_TOLERANCE");

      const signed = await acceptVariance(fx.manager.email, s.id, lineId, {
        reasonCodeId, note: "تلف مؤكد",
      });
      assert.ok(signed.status < 300, signed.text);
      assert.equal(signed.body.disposition, "VARIANCE_CONFIRMED");

      const line = await lineRow(lineId);
      assert.equal(line.disposition, "VARIANCE_CONFIRMED");
      assert.ok(isTerminal(line.disposition), "a real shortage, settled");
      assert.equal(line.reasonCodeId, reasonCodeId);
      assert.equal(line.reasonNote, "تلف مؤكد");
      assert.equal(
        Number(line.countedQuantity), 8,
        "accepting a difference does not edit the evidence that found it"
      );
    } finally {
      await setRecountPolicy({ recountRequiredOutsideTolerance: true });
    }
  });

  test("a recount uses its own count point, not the first one", async () => {
    // The shelf moved between the two counts. Reusing the first capture would
    // measure the recount against a balance that no longer existed.
    await setRecountPolicy({ recountMaxAttempts: 3, allowSelfRecount: true });
    const it = await item(10);
    const s = await countedSession([{ itemId: it.id, counted: 8 }]);
    await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
    const lineId = s.lineFor(it.id);
    const first = await lineRow(lineId);

    const movement = await move(it.id, 5);

    const r = await recount(fx.storekeeper.email, s.id, lineId, { countedQuantity: 8 });
    assert.ok(r.status < 300, r.text);

    const stored = await db.stockCountRecount.findFirstOrThrow({
      where: { lineId }, orderBy: { attempt: "desc" },
    });
    assert.ok(
      stored.itemVersion > first.itemVersion!,
      "the recount took a later count point"
    );
    assert.ok(
      movement.itemVersion <= stored.itemVersion,
      "and the movement between them is at-or-below it"
    );
    assert.equal(Number(stored.expectedQuantity), 15, "measured against the shelf as it now is");
    assert.equal(Number(stored.varianceQuantity), -7);
  });

  test("a caller without stock_count.recount cannot recount", async () => {
    const it = await item(10);
    const s = await countedSession([{ itemId: it.id, counted: 8 }]);
    await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
    const r = await recount(fx.cashier.email, s.id, s.lineFor(it.id), { countedQuantity: 9 });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
  });

  test("a line nobody asked to recount cannot be recounted", async () => {
    const it = await item(10);
    const s = await countedSession([{ itemId: it.id, counted: 10 }]);
    await submitCountSession({ sessionId: s.id, submittedById: fx.manager.id });
    const lineId = s.lineFor(it.id);
    assert.equal((await lineRow(lineId)).disposition, "WITHIN_TOLERANCE");

    const r = await recount(fx.storekeeper.email, s.id, lineId, { countedQuantity: 3 });
    assert.equal(r.status, 409, `a settled line is not reopened by recounting it: ${r.text}`);
    assert.equal(Number((await lineRow(lineId)).countedQuantity), 10);
  });

  test("every runtime move the engine can make is one the accepted map allows", async () => {
    // The engine's own edges, stated and checked against T13 rather than
    // duplicated. A future edit that invents a shortcut fails here.
    const runtimeEdges: [string, string][] = [
      ["PENDING", "COUNTED"],
      ["COUNTED", "WITHIN_TOLERANCE"],
      ["COUNTED", "OUTSIDE_TOLERANCE"],
      ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"],
      ["OUTSIDE_TOLERANCE", "RESOLVED_WITHIN_TOLERANCE"],
      ["OUTSIDE_TOLERANCE", "VARIANCE_CONFIRMED"],
      ["RECOUNT_REQUIRED", "RESOLVED_WITHIN_TOLERANCE"],
      ["RECOUNT_REQUIRED", "VARIANCE_CONFIRMED"],
    ];
    for (const [from, to] of runtimeEdges) {
      assert.ok(
        canTransition(from as never, to as never),
        `the engine moves ${from} → ${to}, which the map does not allow`
      );
    }
  });
});
