// COUNT-015 — the first count survives being disagreed with.
//
// A recount is a SECOND observation, not a revision of the first. The shop
// counted 8, somebody counted again and got 10; both of those things happened
// and an investigation into a repeated shortage needs to see both. So the two
// observations live in two rows, each complete on its own:
//
//   StockCountLine     the first count: quantity, expected, cursor, basis,
//                      time, counter. Written at capture and never again.
//   StockCountRecount  each later count: its own quantity, expected, cursor,
//                      variance, time, counter.
//
// THE DEFECT THIS SUITE CLOSES. The first implementation of `recordRecount`
// wrote the recount's count point over the line's — expectedQuantity,
// itemVersion, expectedBasis, countedAt and counterId all replaced — leaving
// the original first-count cursor recoverable only from the `ITEM_COUNTED`
// audit row. That row is written by the best-effort `audit()`, which swallows
// its own failures by design. So the durable copy of the original count point
// was a row the system does not promise to have written. Test 3 deletes the
// audit trail outright and requires the accountability tables to answer
// anyway.
//
// AND THE PAIR MUST MATCH. Whatever quantity the business acts on, the
// cursor it is measured against has to belong to the SAME observation.
// Pairing a recount's quantity with the first count's cursor would replay
// every movement between them a second time; pairing the first quantity with
// the recount's cursor would drop them. `resolveEffectiveCountEvidence` is
// the one place that decides, and it returns both halves together so they
// cannot be taken apart by a caller.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, stockReasonCode, type CountCafe } from "./helpers/count";
import { applyStockMutation } from "@/lib/ledger";
import { submitCountSession } from "@/lib/stock-count";
import { resolveEffectiveCountEvidence } from "@/lib/count-evidence";

let fx: CountCafe;
let reasonCodeId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("COUNT015");
  reasonCodeId = (await stockReasonCode(fx.cafeId, "MISCOUNT", "خطأ في العد")).id;
  await db.toleranceRule.create({
    data: { cafeId: fx.cafeId, scope: "BRANCH", branchId: fx.branchId, quantityTolerance: "0.5" },
  });
});

after(() => teardownTaggedCafe(fx?.cafeId, [], { disconnect: true }));

let seq = 0;

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

/** A session of one item, counted once through the real capture API. */
async function counted(opts: { stock: number; count: number }) {
  await db.varianceCase.deleteMany({ where: { cafeId: fx.cafeId } });
  await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
  seq += 1;
  const it = await countItem(fx, `item ${seq}`, { stock: opts.stock, isCritical: true });
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
  const r = await as(fx.cashier.email, `/api/stock-counts/${s.id}/lines/${lineId}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity: opts.count }),
  });
  assert.ok(r.status < 300, `fixture capture failed: ${r.text}`);
  return { sessionId: s.id, lineId, itemId: it.id };
}

const lineRow = (lineId: string) =>
  db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });

const recount = (sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ disposition?: string; error?: string }>(
    fx.storekeeper.email,
    `/api/stock-counts/${sessionId}/lines/${lineId}/recount`,
    { method: "POST", body: JSON.stringify({ countedQuantity }) }
  );

const propose = (sessionId: string, lineId: string, newCountedQuantity: number) =>
  as<{ correctionId?: string; error?: string }>(
    fx.manager.email,
    `/api/stock-counts/${sessionId}/lines/${lineId}/correction`,
    { method: "POST", body: JSON.stringify({ newCountedQuantity, reasonCodeId }) }
  );

const approve = (correctionId: string) =>
  as<{ effectiveCountedQuantity?: number; error?: string }>(
    fx.owner.email, `/api/corrections/${correctionId}/approve`, { method: "POST", body: "{}" }
  );

/** Capture, submit so the line goes outside tolerance, then recount to resolve. */
async function resolvedByRecount(opts: { stock: number; first: number; second: number }) {
  const ctx = await counted({ stock: opts.stock, count: opts.first });
  const before = await lineRow(ctx.lineId);
  await submitCountSession({ sessionId: ctx.sessionId, submittedById: fx.manager.id });
  const r = await recount(ctx.sessionId, ctx.lineId, opts.second);
  assert.ok(r.status < 300, `recount failed: ${JSON.stringify(r.body)}`);
  return { ...ctx, before };
}

describe("COUNT-015 original count evidence is durable", () => {
  test("a resolving recount leaves every field of the first count alone", async () => {
    const it = await counted({ stock: 10, count: 8 });
    const before = await lineRow(it.lineId);
    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });

    // The shelf moves between the two counts, so the recount's count point is
    // genuinely different and an overwrite would be visible.
    await move(it.itemId, 2);
    const r = await recount(it.sessionId, it.lineId, 12);
    assert.ok(r.status < 300, `recount failed: ${JSON.stringify(r.body)}`);

    const after = await lineRow(it.lineId);
    assert.equal(Number(after.countedQuantity), Number(before.countedQuantity), "countedQuantity");
    assert.equal(Number(after.expectedQuantity), Number(before.expectedQuantity), "expectedQuantity");
    assert.equal(after.itemVersion, before.itemVersion, "itemVersion — the first count point");
    assert.equal(after.expectedBasis, before.expectedBasis, "expectedBasis");
    assert.equal(
      after.countedAt!.getTime(), before.countedAt!.getTime(),
      "countedAt — when the first count actually happened"
    );
    assert.equal(after.counterId, before.counterId, "counterId — who actually counted first");
    assert.equal(after.counterId, fx.cashier.id, "and it is still the cashier, not the recounter");
  });

  test("the recount is a complete observation of its own", async () => {
    const it = await counted({ stock: 10, count: 8 });
    const line = await lineRow(it.lineId);
    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });
    await move(it.itemId, 2);
    await recount(it.sessionId, it.lineId, 12);

    const rc = await db.stockCountRecount.findFirstOrThrow({
      where: { lineId: it.lineId }, orderBy: { attempt: "desc" },
    });
    assert.equal(Number(rc.countedQuantity), 12, "its own quantity");
    assert.equal(Number(rc.expectedQuantity), 12, "its own expectation");
    assert.equal(Number(rc.varianceQuantity), 0);
    assert.ok(rc.itemVersion > line.itemVersion!, "its own cursor, later than the first");
    assert.ok(rc.countedAt, "its own timestamp");
    assert.equal(rc.counterId, fx.storekeeper.id, "its own counter");
    assert.equal(rc.resolved, true);
  });

  test("the evidence survives without the audit trail", async () => {
    // The original count point used to be recoverable only from ITEM_COUNTED,
    // which `audit()` writes best-effort and swallows failures for. So this
    // test destroys the audit trail and requires the accountability tables to
    // answer anyway. Nothing below reads AuditLog except to prove it is gone.
    const it = await counted({ stock: 10, count: 8 });
    const original = await lineRow(it.lineId);

    await db.auditLog.deleteMany({ where: { cafeId: fx.cafeId } });
    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "ITEM_COUNTED" } }),
      0,
      "the audit row this evidence used to depend on is gone"
    );

    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });
    await move(it.itemId, 2);
    await recount(it.sessionId, it.lineId, 12);

    assert.equal(
      await db.auditLog.count({ where: { cafeId: fx.cafeId, action: "ITEM_COUNTED" } }),
      0,
      "and nothing has re-created it"
    );

    // Reconstruct both observations from accountability tables only.
    const line = await lineRow(it.lineId);
    assert.equal(Number(line.countedQuantity), 8, "the first quantity");
    assert.equal(line.itemVersion, original.itemVersion, "the first cursor");
    assert.equal(
      line.countedAt!.getTime(), original.countedAt!.getTime(), "the first timestamp"
    );
    assert.equal(line.counterId, fx.cashier.id, "who counted first");
    assert.equal(line.expectedBasis, "LOCKED_ITEM_VERSION", "the provenance of the first expectation");

    const rc = await db.stockCountRecount.findFirstOrThrow({ where: { lineId: it.lineId } });
    assert.equal(Number(rc.countedQuantity), 12, "the recount quantity");
    assert.ok(rc.itemVersion > line.itemVersion!, "the recount cursor");
    assert.ok(rc.countedAt, "the recount timestamp");
    assert.equal(rc.counterId, fx.storekeeper.id, "who recounted");
  });

  test("case A — no recount, no correction: the original quantity with the original cursor", async () => {
    const it = await counted({ stock: 10, count: 8 });
    const line = await lineRow(it.lineId);

    const ev = await resolveEffectiveCountEvidence(it.lineId);
    assert.equal(ev.source, "ORIGINAL_COUNT");
    assert.equal(ev.quantity, 8);
    assert.equal(ev.itemVersion, line.itemVersion);
    assert.equal(ev.expectedQuantity, 10);
    assert.equal(ev.varianceQuantity, -2);
    assert.equal(ev.countedAt!.getTime(), line.countedAt!.getTime());
    assert.equal(ev.counterId, fx.cashier.id);
  });

  test("case B — a resolving recount: the recount's quantity with the recount's cursor", async () => {
    const it = await counted({ stock: 10, count: 8 });
    const line = await lineRow(it.lineId);
    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });
    await move(it.itemId, 2);
    await recount(it.sessionId, it.lineId, 12);

    const rc = await db.stockCountRecount.findFirstOrThrow({ where: { lineId: it.lineId } });
    const ev = await resolveEffectiveCountEvidence(it.lineId);
    assert.equal(ev.source, "RECOUNT");
    assert.equal(ev.quantity, 12);
    assert.equal(ev.itemVersion, rc.itemVersion, "the cursor belongs to the same observation");
    assert.notEqual(ev.itemVersion, line.itemVersion, "and not to the one it superseded");
    assert.equal(ev.expectedQuantity, 12);
    assert.equal(ev.counterId, fx.storekeeper.id);
    assert.equal(ev.recountId, rc.id);
  });

  test("case C — an approved correction of the original: corrected quantity, original cursor", async () => {
    const it = await counted({ stock: 10, count: 15 });
    const line = await lineRow(it.lineId);
    const proposed = await propose(it.sessionId, it.lineId, 1.5);
    assert.ok(proposed.status < 300, proposed.text);
    const signed = await approve(proposed.body.correctionId!);
    assert.ok(signed.status < 300, signed.text);

    const ev = await resolveEffectiveCountEvidence(it.lineId);
    assert.equal(ev.source, "APPROVED_CORRECTION");
    assert.equal(ev.quantity, 1.5, "the corrected figure");
    assert.equal(
      ev.itemVersion, line.itemVersion,
      "a correction changes the number, not when it was observed — the cursor " +
        "is still the original count point"
    );
    assert.equal(ev.expectedQuantity, 10);
    assert.equal(ev.varianceQuantity, -8.5, "recomputed from the corrected figure");
    assert.equal(ev.correctionId, proposed.body.correctionId);

    // And the observation itself is untouched.
    assert.equal(Number((await lineRow(it.lineId)).countedQuantity), 15);
  });

  test("case D — correcting a line a recount already superseded is refused", async () => {
    // The correction row records WHICH figure it replaces (`oldCountedQuantity`)
    // but not WHICH observation, so a correction applied on top of a recount
    // would leave nothing able to say whether the corrected quantity belongs
    // to the first count point or the recount's. Rather than guess a cursor,
    // the product refuses and says so.
    const it = await resolvedByRecount({ stock: 10, first: 8, second: 10 });

    const refused = await propose(it.sessionId, it.lineId, 9);
    assert.equal(
      refused.status, 409,
      `expected a refusal, got ${refused.status}: ${refused.text}`
    );
    assert.match(refused.body.error ?? "", /إعادة عد|recount/i);
    assert.equal(
      await db.stockCountCorrection.count({ where: { lineId: it.lineId } }), 0,
      "and no correction row was left behind"
    );

    const ev = await resolveEffectiveCountEvidence(it.lineId);
    assert.equal(ev.source, "RECOUNT", "the recount is still the evidence in force");
    assert.equal(ev.quantity, 10);
  });

  test("effectiveCountedQuantity never drifts from the evidence in force", async () => {
    // The column stays as the denormalised operational figure every existing
    // consumer already reads. It is only trustworthy if it cannot disagree
    // with the resolver, so that is asserted across all three sources.
    const a = await counted({ stock: 10, count: 8 });
    const evA = await resolveEffectiveCountEvidence(a.lineId);
    assert.equal(Number((await lineRow(a.lineId)).effectiveCountedQuantity), evA.quantity);
    assert.equal(Number((await lineRow(a.lineId)).varianceQuantity), evA.varianceQuantity);

    const b = await resolvedByRecount({ stock: 10, first: 8, second: 10 });
    const evB = await resolveEffectiveCountEvidence(b.lineId);
    const lineB = await lineRow(b.lineId);
    assert.equal(Number(lineB.effectiveCountedQuantity), evB.quantity);
    assert.equal(Number(lineB.varianceQuantity), evB.varianceQuantity);
    assert.equal(evB.source, "RECOUNT");

    const c = await counted({ stock: 10, count: 15 });
    const proposed = await propose(c.sessionId, c.lineId, 1.5);
    await approve(proposed.body.correctionId!);
    const evC = await resolveEffectiveCountEvidence(c.lineId);
    const lineC = await lineRow(c.lineId);
    assert.equal(Number(lineC.effectiveCountedQuantity), evC.quantity);
    assert.equal(Number(lineC.varianceQuantity), evC.varianceQuantity);
  });

  test("an unresolved recount is still the evidence in force", async () => {
    // Attempts exhausted, variance accepted: the figure the business acts on
    // is the LAST physical observation, and its cursor comes with it.
    const it = await counted({ stock: 10, count: 8 });
    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });
    await recount(it.sessionId, it.lineId, 7);
    await recount(it.sessionId, it.lineId, 7.5);

    const last = await db.stockCountRecount.findFirstOrThrow({
      where: { lineId: it.lineId }, orderBy: { attempt: "desc" },
    });
    assert.equal(last.attempt, 2);
    assert.equal(last.resolved, false);

    const ev = await resolveEffectiveCountEvidence(it.lineId);
    assert.equal(ev.source, "RECOUNT");
    assert.equal(ev.quantity, 7.5, "the most recent count, not the first");
    assert.equal(ev.itemVersion, last.itemVersion);
  });

  test("a variance case opened at confirmation uses the evidence in force", async () => {
    const it = await counted({ stock: 10, count: 8 });
    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });
    await recount(it.sessionId, it.lineId, 7);
    await recount(it.sessionId, it.lineId, 7);

    const accepted = await as(
      fx.manager.email,
      `/api/stock-counts/${it.sessionId}/lines/${it.lineId}/accept-variance`,
      { method: "POST", body: JSON.stringify({ reasonCodeId }) }
    );
    assert.ok(accepted.status < 300, accepted.text);

    const confirmed = await as(fx.manager.email, `/api/stock-counts/${it.sessionId}/confirm`, {
      method: "POST", body: JSON.stringify({ idempotencyKey: `${fx.marker}-ev` }),
    });
    assert.ok(confirmed.status < 300, confirmed.text);

    const c = await db.varianceCase.findFirstOrThrow({ where: { stockCountLineId: it.lineId } });
    assert.equal(
      Number(c.quantityVariance), -3,
      "the recount found 7 against 10, so the gap under investigation is 3 — " +
        "not the 2 the discredited first count reported"
    );
  });
});
