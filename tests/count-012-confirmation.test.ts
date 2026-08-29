// COUNT-012 (T28) — close the count when every line has an answer.
//
// Confirmation is the moment a count stops being a work-in-progress and
// becomes evidence other things are allowed to act on: the rebase reads it,
// variance cases are opened from it, a handover can cite it. So it succeeds
// on exactly one condition — every line is in a terminal disposition — and
// it runs once however many times it is called.
//
// ONCE MATTERS HERE MORE THAN ANYWHERE. A confirmation that ran twice would
// open two variance cases for one shortage, and a shop would investigate the
// same missing 2 kg as two separate incidents. Idempotency is carried by the
// database rather than by a flag: the session's unique `idempotencyKey` and
// the `@unique` on `VarianceCase.stockCountLineId` mean two callers racing
// produce one winner and one collision, and the loser reads the winner's row
// instead of guessing.
//
// CONFIRMING DOES NOT MOVE STOCK. Spec §6 and the milestone's hard rule: the
// shelf is changed to match a count by an explicit, audited COUNT_REBASE
// (T23), after confirmation and never as part of it. A confirmation that
// quietly rebased would make "we confirmed the count" and "we moved the
// stock" the same act, and there would be no moment at which somebody could
// look at the numbers before the shelf moved.
//
// AND A MISSING COST IS NOT A ZERO ONE. A line whose theoretical consumption
// could not be verified gets a case with `financialImpact = NULL` and a
// stated reason — never 0, which would read as a shortage that cost nothing.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, stockReasonCode, type CountCafe } from "./helpers/count";
import { isTerminal } from "@/lib/count-disposition";

let fx: CountCafe;
let reasonCodeId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("COUNT012");
  reasonCodeId = (await stockReasonCode(fx.cafeId, "SPOILAGE", "تلف")).id;
  await db.toleranceRule.create({
    data: { cafeId: fx.cafeId, scope: "BRANCH", branchId: fx.branchId, quantityTolerance: "0.5" },
  });
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: { recountRequiredOutsideTolerance: false },
  });
});

after(() => teardownTaggedCafe(fx?.cafeId, [], { disconnect: true }));

let seq = 0;
async function item(stock: number) {
  seq += 1;
  return countItem(fx, `item ${seq}`, { stock, isCritical: true, costPerUnit: 450 });
}

/**
 * Clear the branch's counts.
 *
 * Variance cases go first: `VarianceCase.stockCountLineId` is a RESTRICT
 * foreign key, because a case must outlive nothing quietly — the evidence it
 * points at cannot vanish under it. That is the schema working as intended,
 * so the fixture unwinds in the order the constraints require.
 */
async function clearCounts() {
  await db.varianceCase.deleteMany({ where: { cafeId: fx.cafeId } });
  await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
}

/** A session over the given items, captured through the real capture API. */
async function session(specs: { itemId: string; counted: number }[]) {
  await clearCounts();
  const s = await db.stockCountSession.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, type: "CRITICAL",
      scopeDerivation: "CRITICAL_ONLY", status: "IN_PROGRESS",
      initiatedById: fx.manager.id,
      lines: { create: specs.map((sp) => ({ inventoryItemId: sp.itemId, unit: "KG" as const })) },
    },
    select: { id: true, lines: { select: { id: true, inventoryItemId: true } } },
  });
  for (const spec of specs) {
    const lineId = s.lines.find((l) => l.inventoryItemId === spec.itemId)!.id;
    const r = await as(fx.cashier.email, `/api/stock-counts/${s.id}/lines/${lineId}`, {
      method: "PATCH", body: JSON.stringify({ countedQuantity: spec.counted }),
    });
    assert.ok(r.status < 300, `fixture capture failed: ${r.text}`);
  }
  return { id: s.id, lineFor: (i: string) => s.lines.find((l) => l.inventoryItemId === i)!.id };
}

const submit = (email: string, id: string) =>
  as<{ status?: string; within?: number; outside?: number; error?: string }>(
    email, `/api/stock-counts/${id}/submit`, { method: "POST", body: "{}" }
  );

const confirm = (email: string, id: string, idempotencyKey: string) =>
  as<{
    status?: string; confirmedAt?: string; varianceCaseIds?: string[];
    alreadyConfirmed?: boolean; error?: string; lineIds?: string[];
  }>(email, `/api/stock-counts/${id}/confirm`, {
    method: "POST", body: JSON.stringify({ idempotencyKey }),
  });

const acceptVariance = (email: string, id: string, lineId: string) =>
  as(email, `/api/stock-counts/${id}/lines/${lineId}/accept-variance`, {
    method: "POST", body: JSON.stringify({ reasonCodeId }),
  });

describe("COUNT-012 count confirmation", () => {
  test("submitting with an unlooked-at shelf is refused and leaves the count open", async () => {
    const counted = await item(10);
    const missed = await item(10);
    await clearCounts();
    const s = await db.stockCountSession.create({
      data: {
        cafeId: fx.cafeId, branchId: fx.branchId, type: "CRITICAL",
        scopeDerivation: "CRITICAL_ONLY", status: "IN_PROGRESS",
        initiatedById: fx.manager.id,
        lines: {
          create: [
            { inventoryItemId: counted.id, unit: "KG", expectedQuantity: "10",
              countedQuantity: "10", effectiveCountedQuantity: "10",
              varianceQuantity: "0", disposition: "COUNTED" },
            { inventoryItemId: missed.id, unit: "KG" },
          ],
        },
      },
      select: { id: true },
    });

    const r = await submit(fx.manager.email, s.id);
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${r.text}`);
    assert.match(r.body.error ?? "", /لسه ما اتعدتش/);
    const still = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(still.status, "IN_PROGRESS");
  });

  test("after submission the counter is shown the target — that is the reveal", async () => {
    const it = await item(10);
    const s = await session([{ itemId: it.id, counted: 9.8 }]);
    const before = await as(fx.cashier.email, `/api/stock-counts/${s.id}`);
    assert.ok(!/expectedQuantity/.test(before.text), "blind until submitted");

    const r = await submit(fx.manager.email, s.id);
    assert.ok(r.status < 300, r.text);

    const after = await as<{ session: { lines: Record<string, unknown>[] } }>(
      fx.cashier.email, `/api/stock-counts/${s.id}`
    );
    const line = after.body.session.lines[0];
    assert.equal(Number(line.expectedQuantity), 10);
    assert.equal(Number(line.varianceQuantity), -0.2);
  });

  test("submission records how far the theoretical figure can be trusted, and what it cost", async () => {
    const it = await item(10);
    const s = await session([{ itemId: it.id, counted: 8 }]);
    await submit(fx.manager.email, s.id);

    const line = await db.stockCountLine.findUniqueOrThrow({ where: { id: s.lineFor(it.id) } });
    assert.ok(line.confidenceWindowFrom, "the window the judgement covers is recorded");
    assert.equal(
      line.confidence, "UNVERIFIABLE",
      "nothing was sold in the window, so there is no consumption to verify against"
    );
    assert.equal(
      line.costImpact, null,
      "and an unverifiable figure is not priced — NULL, never 0"
    );
    assert.equal(line.costImpactAvailable, false);
    assert.ok(line.costUnavailableReason, "with a reason, so unknown stays legible");
  });

  test("confirmation is refused while any line is unsettled, and names them", async () => {
    const it = await item(10);
    const s = await session([{ itemId: it.id, counted: 8 }]);
    await submit(fx.manager.email, s.id);
    const lineId = s.lineFor(it.id);
    assert.equal((await db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } })).disposition,
      "OUTSIDE_TOLERANCE");

    const r = await confirm(fx.manager.email, s.id, `${fx.marker}-unsettled`);
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${r.text}`);
    assert.ok(
      r.text.includes(lineId),
      "a refusal that does not say which line is unsettled leaves nobody able to act on it"
    );
    const still = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.notEqual(still.status, "CONFIRMED");
  });

  test("a session whose only outside line was accepted confirms, and opens one case for it", async () => {
    const short = await item(10);
    const fine = await item(10);
    const s = await session([{ itemId: short.id, counted: 8 }, { itemId: fine.id, counted: 10 }]);
    await submit(fx.manager.email, s.id);

    const shortLine = s.lineFor(short.id);
    const accepted = await acceptVariance(fx.manager.email, s.id, shortLine);
    assert.ok(accepted.status < 300, accepted.text);

    const r = await confirm(fx.manager.email, s.id, `${fx.marker}-accepted`);
    assert.ok(r.status < 300, `expected the count to close: ${r.text}`);
    assert.equal(r.body.status, "CONFIRMED");
    assert.equal(r.body.alreadyConfirmed, false);
    assert.equal(r.body.varianceCaseIds!.length, 1, "one accepted shortage, one case");

    const stored = await db.stockCountSession.findUniqueOrThrow({
      where: { id: s.id }, include: { lines: true },
    });
    assert.equal(stored.status, "CONFIRMED");
    assert.ok(stored.confirmedAt);
    assert.equal(stored.confirmedById, fx.manager.id);
    assert.ok(stored.lines.every((l) => isTerminal(l.disposition)));

    const cases = await db.varianceCase.findMany({ where: { cafeId: fx.cafeId } });
    assert.equal(cases.length, 1, "and no case for the line that was fine");
    assert.equal(cases[0].stockCountLineId, shortLine);
    assert.equal(cases[0].type, "STOCK");
    assert.equal(Number(cases[0].quantityVariance), -2);
  });

  test("an unverifiable line's case is priced at NULL with a stated reason, never at zero", async () => {
    const short = await item(10);
    const s = await session([{ itemId: short.id, counted: 8 }]);
    await submit(fx.manager.email, s.id);
    await acceptVariance(fx.manager.email, s.id, s.lineFor(short.id));
    const r = await confirm(fx.manager.email, s.id, `${fx.marker}-unpriced`);
    assert.ok(r.status < 300, r.text);

    const c = await db.varianceCase.findFirstOrThrow({
      where: { stockCountLineId: s.lineFor(short.id) },
    });
    assert.equal(c.financialImpact, null, "a missing cost is not a shortage that cost nothing");
    assert.equal(c.financialImpactAvailable, false);
    assert.ok(c.financialImpactUnavailableReason);
    assert.equal(
      c.blocking, false,
      "and unknown is not presumed large — an unpriced case never blocks"
    );
  });

  test("confirming again with the same key changes nothing and says so", async () => {
    const short = await item(10);
    const s = await session([{ itemId: short.id, counted: 8 }]);
    await submit(fx.manager.email, s.id);
    await acceptVariance(fx.manager.email, s.id, s.lineFor(short.id));
    const key = `${fx.marker}-idem`;

    const first = await confirm(fx.manager.email, s.id, key);
    assert.ok(first.status < 300, first.text);
    const casesAfterFirst = await db.varianceCase.count({ where: { cafeId: fx.cafeId } });

    const second = await confirm(fx.manager.email, s.id, key);
    assert.ok(second.status < 300, `a retry must not fail: ${second.text}`);
    assert.equal(second.body.alreadyConfirmed, true);
    assert.deepEqual(second.body.varianceCaseIds, first.body.varianceCaseIds);
    assert.equal(
      await db.varianceCase.count({ where: { cafeId: fx.cafeId } }),
      casesAfterFirst,
      "one shortage must never be investigated as two incidents"
    );
  });

  test("two confirmations racing leave exactly one confirmed count and one case", async () => {
    const short = await item(10);
    const s = await session([{ itemId: short.id, counted: 8 }]);
    await submit(fx.manager.email, s.id);
    await acceptVariance(fx.manager.email, s.id, s.lineFor(short.id));

    const [a, b] = await Promise.all([
      confirm(fx.manager.email, s.id, `${fx.marker}-race-a`),
      confirm(fx.owner.email, s.id, `${fx.marker}-race-b`),
    ]);
    assert.ok(a.status < 300 || b.status < 300, `one must succeed: ${a.text} / ${b.text}`);

    const stored = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(stored.status, "CONFIRMED");
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: s.lineFor(short.id) } }),
      1,
      "the unique on the source column is what makes a race an answer, not a twin"
    );
  });

  test("confirming moves no stock and writes no ledger row", async () => {
    const it = await item(10);
    const s = await session([{ itemId: it.id, counted: 8 }]);
    await submit(fx.manager.email, s.id);
    await acceptVariance(fx.manager.email, s.id, s.lineFor(it.id));
    const before = await db.inventoryItem.findUniqueOrThrow({ where: { id: it.id } });

    const r = await confirm(fx.manager.email, s.id, `${fx.marker}-nostock`);
    assert.ok(r.status < 300, r.text);

    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: it.id } });
    assert.equal(
      Number(after.currentStock), Number(before.currentStock),
      "the shelf moves only through an explicit, audited COUNT_REBASE"
    );
    assert.equal(after.ledgerVersion, before.ledgerVersion);
    assert.equal(
      await db.inventoryTransaction.count({
        where: { inventoryItemId: it.id, type: "COUNT_REBASE" },
      }),
      0,
      "no rebase happens early"
    );
    assert.equal(
      await db.stockCountRebase.count({ where: { sessionId: s.id } }), 0
    );
  });

  test("a cashier cannot confirm a count", async () => {
    const it = await item(10);
    const s = await session([{ itemId: it.id, counted: 10 }]);
    await submit(fx.cashier.email, s.id);
    const r = await confirm(fx.cashier.email, s.id, `${fx.marker}-denied`);
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
    assert.notEqual(
      (await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } })).status,
      "CONFIRMED"
    );
  });

  test("a caller without stock_count.submit cannot submit", async () => {
    const it = await item(10);
    const s = await session([{ itemId: it.id, counted: 10 }]);
    const r = await submit(fx.waiter.email, s.id);
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
  });

  test("a COUNT_CONFIRMED audit row names the session and who signed it", async () => {
    const it = await item(10);
    const s = await session([{ itemId: it.id, counted: 10 }]);
    await submit(fx.manager.email, s.id);
    await confirm(fx.manager.email, s.id, `${fx.marker}-audited`);

    const row = await db.auditLog.findFirst({
      where: { cafeId: fx.cafeId, action: "COUNT_CONFIRMED", entityId: s.id },
    });
    assert.ok(row, "a count nobody can see was confirmed is a count nobody can rely on");
    assert.equal(row!.userId, fx.manager.id);
  });
});
