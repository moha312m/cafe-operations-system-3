// COUNT-013 (T29) — correct the working figure, preserve what was written down.
//
// Somebody miscounts, or writes 15 where they meant 1.5. The count has to be
// correctable, and the correction must not destroy the thing it corrects.
//
// So a count line carries two numbers that must never collapse into one:
//
//   countedQuantity           what was observed. Evidence. Written once at
//                             capture and never again.
//   effectiveCountedQuantity  what the business acts on. Equals the
//                             observation until an APPROVED correction
//                             supersedes it.
//
// Overwriting `countedQuantity` would erase the record that a mistake was
// made — which is exactly what an investigation into a repeated shortage
// needs to see. Test 4 asserts the preservation by reading the column as raw
// text before and after, so a Decimal that merely FORMATS the same cannot
// pass for one that was not written.
//
// A correction is also not a thing one person does alone. It needs a reason
// code from the café's own vocabulary, and a second signature: the author
// cannot approve their own, whatever keys they hold. The correction row that
// records both is the audit trail, and it survives the approval rather than
// being consumed by it.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, stockReasonCode, type CountCafe } from "./helpers/count";

let fx: CountCafe;
let other: CountCafe;
let reasonCodeId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("COUNT013");
  other = await countCafe("COUNT013X");
  reasonCodeId = (await stockReasonCode(fx.cafeId, "MISCOUNT", "خطأ في العد")).id;
});

after(() =>
  teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], {
    disconnect: true,
  })
);

let seq = 0;

/** One captured line, ready to be argued about. */
async function capturedLine(opts: { stock: number; counted: number }) {
  seq += 1;
  await db.varianceCase.deleteMany({ where: { cafeId: fx.cafeId } });
  await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
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
  const captured = await as(fx.cashier.email, `/api/stock-counts/${s.id}/lines/${lineId}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity: opts.counted }),
  });
  assert.ok(captured.status < 300, `fixture capture failed: ${captured.text}`);
  return { sessionId: s.id, lineId, itemId: it.id };
}

/** The stored decimal exactly as Postgres holds it, not as JS renders it. */
async function rawCounted(lineId: string): Promise<string> {
  const rows = await db.$queryRaw<{ counted: string | null }[]>`
    SELECT "countedQuantity"::text AS counted FROM "StockCountLine" WHERE "id" = ${lineId}
  `;
  return rows[0]?.counted ?? "";
}

const propose = (email: string, sessionId: string, lineId: string, body: unknown) =>
  as<{ correctionId?: string; status?: string; error?: string }>(
    email, `/api/stock-counts/${sessionId}/lines/${lineId}/correction`,
    { method: "POST", body: JSON.stringify(body) }
  );

const approve = (email: string, correctionId: string) =>
  as<{
    correctionId?: string; effectiveCountedQuantity?: number;
    varianceQuantity?: number; error?: string;
  }>(email, `/api/corrections/${correctionId}/approve`, { method: "POST", body: "{}" });

const lineRow = (lineId: string) =>
  db.stockCountLine.findUniqueOrThrow({ where: { id: lineId } });

describe("COUNT-013 count corrections and the effective figure", () => {
  test("a correction without a stated reason is refused", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const r = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5,
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${r.text}`);
    assert.equal(await db.stockCountCorrection.count({ where: { lineId } }), 0);
  });

  test("a reason code from another café's vocabulary is refused", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const foreign = await stockReasonCode(other.cafeId, "MISCOUNT", "خطأ في العد");
    const r = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId: foreign.id,
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${r.text}`);
  });

  test("a valid correction waits for approval and changes nothing yet", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const before = await lineRow(lineId);

    const r = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId, note: "فاصلة عشرية",
    });
    assert.ok(r.status < 300, r.text);
    assert.equal(r.body.status, "PENDING_APPROVAL");

    const after = await lineRow(lineId);
    assert.equal(
      Number(after.effectiveCountedQuantity), Number(before.effectiveCountedQuantity),
      "a proposal is not a decision — the line must not move until somebody signs"
    );
    assert.equal(Number(after.varianceQuantity), Number(before.varianceQuantity));

    const stored = await db.stockCountCorrection.findUniqueOrThrow({
      where: { id: r.body.correctionId! },
    });
    assert.equal(Number(stored.oldCountedQuantity), 15, "the row records what it is replacing");
    assert.equal(Number(stored.newCountedQuantity), 1.5);
    assert.equal(stored.actorId, fx.manager.id);
    assert.equal(stored.postCustodyTransfer, false);
  });

  test("the author cannot approve their own correction", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const proposed = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    assert.ok(proposed.status < 300, proposed.text);

    // The manager holds stock_count.approve_correction. Holding the key is
    // not the same as being a second person.
    const own = await approve(fx.manager.email, proposed.body.correctionId!);
    assert.equal(own.status, 403, `expected 403, got ${own.status}: ${own.text}`);
    assert.equal(
      (await db.stockCountCorrection.findUniqueOrThrow({
        where: { id: proposed.body.correctionId! },
      })).status,
      "PENDING_APPROVAL"
    );
  });

  test("approval moves the working figure and leaves the evidence byte-identical", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const evidenceBefore = await rawCounted(lineId);

    const proposed = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    const signed = await approve(fx.owner.email, proposed.body.correctionId!);
    assert.ok(signed.status < 300, signed.text);
    assert.equal(signed.body.effectiveCountedQuantity, 1.5);

    assert.equal(
      await rawCounted(lineId), evidenceBefore,
      "the observation is what somebody actually wrote down, and a correction " +
        "of it is a second fact, not a replacement for the first"
    );
    const line = await lineRow(lineId);
    assert.equal(Number(line.effectiveCountedQuantity), 1.5);

    const stored = await db.stockCountCorrection.findUniqueOrThrow({
      where: { id: proposed.body.correctionId! },
    });
    assert.equal(stored.status, "APPROVED");
    assert.equal(stored.approvedById, fx.owner.id);
    assert.ok(stored.approvedAt);
  });

  test("the variance is recomputed from the effective figure, not the original", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    assert.equal(Number((await lineRow(lineId)).varianceQuantity), 5);

    const proposed = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 9.982, reasonCodeId,
    });
    const signed = await approve(fx.owner.email, proposed.body.correctionId!);
    assert.ok(signed.status < 300, signed.text);

    const line = await lineRow(lineId);
    assert.equal(
      Number(line.varianceQuantity), -0.018,
      "and to the gram: 18 g is not 20 g in the figure a shortage is judged from"
    );
    assert.equal(signed.body.varianceQuantity, -0.018);
  });

  test("a correction that was never approved leaves both figures untouched", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const proposed = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    const correctionId = proposed.body.correctionId!;
    await db.stockCountCorrection.update({
      where: { id: correctionId },
      data: { status: "REJECTED", rejectedReason: "العد الأصلي صح" },
    });

    const line = await lineRow(lineId);
    assert.equal(Number(line.countedQuantity), 15);
    assert.equal(Number(line.effectiveCountedQuantity), 15);
    assert.equal(Number(line.varianceQuantity), 5);

    const late = await approve(fx.owner.email, correctionId);
    assert.ok(late.status >= 400, `a rejected correction must not be approvable: ${late.text}`);
    assert.equal(Number((await lineRow(lineId)).effectiveCountedQuantity), 15);
  });

  test("approving twice is refused, and the figure does not move again", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const proposed = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    const first = await approve(fx.owner.email, proposed.body.correctionId!);
    assert.ok(first.status < 300, first.text);
    const second = await approve(fx.owner.email, proposed.body.correctionId!);
    assert.ok(second.status >= 400, `expected a refusal, got ${second.status}`);
    assert.equal(Number((await lineRow(lineId)).effectiveCountedQuantity), 1.5);
  });

  test("two corrections in sequence leave the latest as the effective figure", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const evidence = await rawCounted(lineId);

    const one = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    await approve(fx.owner.email, one.body.correctionId!);

    const two = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 9, reasonCodeId,
    });
    const stored = await db.stockCountCorrection.findUniqueOrThrow({
      where: { id: two.body.correctionId! },
    });
    assert.equal(
      Number(stored.oldCountedQuantity), 1.5,
      "the second correction supersedes the figure in force, not the original"
    );
    await approve(fx.owner.email, two.body.correctionId!);

    const line = await lineRow(lineId);
    assert.equal(Number(line.effectiveCountedQuantity), 9);
    assert.equal(Number(line.varianceQuantity), -1);
    assert.equal(await rawCounted(lineId), evidence, "and the observation still stands");
    assert.equal(
      await db.stockCountCorrection.count({ where: { lineId } }), 2,
      "both attempts remain readable — the trail is the point"
    );
  });

  test("both audit rows carry the old value and the new one", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const proposed = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    await approve(fx.owner.email, proposed.body.correctionId!);

    const created = await db.auditLog.findFirst({
      where: { cafeId: fx.cafeId, action: "CORRECTION_CREATED", entityId: proposed.body.correctionId! },
    });
    assert.ok(created, "a proposal nobody can trace is not a proposal");
    const cd = created!.details as Record<string, unknown>;
    assert.equal(Number(cd.oldCountedQuantity), 15);
    assert.equal(Number(cd.newCountedQuantity), 1.5);
    assert.equal(created!.userId, fx.manager.id);

    const approved = await db.auditLog.findFirst({
      where: { cafeId: fx.cafeId, action: "CORRECTION_APPROVED", entityId: proposed.body.correctionId! },
    });
    assert.ok(approved);
    const ad = approved!.details as Record<string, unknown>;
    assert.equal(Number(ad.oldCountedQuantity), 15);
    assert.equal(Number(ad.effectiveCountedQuantity), 1.5);
    assert.equal(approved!.userId, fx.owner.id);
  });

  test("a cashier can neither propose a correction nor approve one", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const denied = await propose(fx.cashier.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    assert.equal(denied.status, 403, `expected 403, got ${denied.status}: ${denied.text}`);

    const proposed = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    const refused = await approve(fx.cashier.email, proposed.body.correctionId!);
    assert.equal(refused.status, 403, `expected 403, got ${refused.status}: ${refused.text}`);
    assert.equal(Number((await lineRow(lineId)).effectiveCountedQuantity), 15);
  });

  test("another café can neither correct nor approve this café's line", async () => {
    const { sessionId, lineId } = await capturedLine({ stock: 10, counted: 15 });
    const foreignProposal = await propose(other.owner.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    assert.equal(foreignProposal.status, 404, `expected 404, got ${foreignProposal.status}`);

    const mine = await propose(fx.manager.email, sessionId, lineId, {
      newCountedQuantity: 1.5, reasonCodeId,
    });
    const foreignApproval = await approve(other.owner.email, mine.body.correctionId!);
    assert.equal(foreignApproval.status, 404, `expected 404, got ${foreignApproval.status}`);
    assert.equal(Number((await lineRow(lineId)).effectiveCountedQuantity), 15);
  });
});
