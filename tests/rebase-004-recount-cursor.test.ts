// REBASE-004 — the rebase replays from the cursor of the count it is acting on.
//
// The rebase target is:
//
//   effective physical quantity + every movement above THAT observation's cursor
//
// Both halves must come from the same observation. When a recount supersedes
// the first count, using the first count's cursor with the recount's quantity
// replays every movement between them a SECOND time — the recounter already
// saw them on the shelf. The shop ends up with stock it does not have, and the
// next count reports a shortage nobody caused.
//
// The timeline this suite walks:
//
//   open at 100
//   first count at version N       counter sees 100
//   movement +5                    version N+1
//   recount at version M           recounter sees 105, and says 105
//   movement +3                    version M+1
//   resolve, confirm, rebase
//
// Correct: 105 + 3 = 108.
// The defect: 105 + 5 + 3 = 113 — the +5 counted once on the shelf and once
// in the replay.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, stockReasonCode, type CountCafe } from "./helpers/count";
import { applyStockMutation } from "@/lib/ledger";
import { submitCountSession } from "@/lib/stock-count";
import { rebaseFromCount } from "@/lib/stock-rebase";

let fx: CountCafe;
let reasonCodeId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("REBASE004");
  reasonCodeId = (await stockReasonCode(fx.cafeId, "SPOILAGE", "تلف")).id;
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

const recount = (sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ disposition?: string; error?: string }>(
    fx.storekeeper.email,
    `/api/stock-counts/${sessionId}/lines/${lineId}/recount`,
    { method: "POST", body: JSON.stringify({ countedQuantity }) }
  );

const confirm = (sessionId: string, key: string) =>
  as(fx.manager.email, `/api/stock-counts/${sessionId}/confirm`, {
    method: "POST", body: JSON.stringify({ idempotencyKey: key }),
  });

const stockOf = async (id: string) =>
  Number((await db.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock);

describe("REBASE-004 the rebase uses the superseding count's cursor", () => {
  test("movements before the recount are not replayed onto it a second time", async () => {
    const it = await counted({ stock: 100, count: 100 });
    const firstLine = await db.stockCountLine.findUniqueOrThrow({ where: { id: it.lineId } });
    const N = firstLine.itemVersion!;

    // Push the line outside tolerance so a recount is legitimately demanded.
    await db.stockCountLine.update({
      where: { id: it.lineId },
      data: { countedQuantity: "95", effectiveCountedQuantity: "95", varianceQuantity: "-5" },
    });
    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });

    const between = await move(it.itemId, 5);
    assert.ok(between.itemVersion > N, "the +5 landed above the first count point");

    // The recounter walks the shelf and sees 105 — the +5 included.
    const r = await recount(it.sessionId, it.lineId, 105);
    assert.ok(r.status < 300, `recount failed: ${JSON.stringify(r.body)}`);
    const rc = await db.stockCountRecount.findFirstOrThrow({
      where: { lineId: it.lineId }, orderBy: { attempt: "desc" },
    });
    const M = rc.itemVersion;
    // At-or-below, not above: `itemVersion` means "everything up to here is
    // committed and reflected in the balance", so the movement the recounter
    // saw sits AT the recount cursor and is excluded from the replay.
    assert.ok(M >= between.itemVersion, "the recount point covers the movement it saw");
    assert.equal(rc.resolved, true);

    const after = await move(it.itemId, 3);
    assert.ok(after.itemVersion > M, "and the +3 landed above the recount point");

    const confirmed = await confirm(it.sessionId, `${fx.marker}-cursor`);
    assert.ok(confirmed.status < 300, confirmed.text);

    const result = await rebaseFromCount({
      sessionId: it.sessionId, actorId: fx.manager.id,
      idempotencyKey: `${fx.marker}-rebase-cursor`,
    });
    assert.equal(result.itemsRebased, 1, JSON.stringify(result));

    assert.equal(
      await stockOf(it.itemId), 108,
      "105 seen on the shelf plus the 3 that left after — the 5 the recounter " +
        "already saw must not be replayed on top of a figure that includes it"
    );

    const rebase = await db.stockCountRebase.findFirstOrThrow({
      where: { sessionId: it.sessionId },
    });
    assert.equal(Number(rebase.countedQuantity), 105, "the figure acted on is the recount's");
    assert.equal(Number(rebase.replayedDelta), 3, "only movements above the recount cursor");
    assert.equal(rebase.replayedMovementCount, 1, "one movement replayed, not two");
    assert.equal(Number(rebase.stockAfter), 108);
  });

  test("the rebase leaves the first count's evidence exactly as it was", async () => {
    const it = await counted({ stock: 50, count: 50 });
    const before = await db.stockCountLine.findUniqueOrThrow({ where: { id: it.lineId } });

    await db.stockCountLine.update({
      where: { id: it.lineId },
      data: { countedQuantity: "40", effectiveCountedQuantity: "40", varianceQuantity: "-10" },
    });
    const evidence = await db.stockCountLine.findUniqueOrThrow({ where: { id: it.lineId } });
    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });

    await move(it.itemId, 4);
    await recount(it.sessionId, it.lineId, 54);
    await move(it.itemId, -2);
    await confirm(it.sessionId, `${fx.marker}-evidence`);
    await rebaseFromCount({
      sessionId: it.sessionId, actorId: fx.manager.id,
      idempotencyKey: `${fx.marker}-rebase-evidence`,
    });

    const after = await db.stockCountLine.findUniqueOrThrow({ where: { id: it.lineId } });
    assert.equal(Number(after.countedQuantity), Number(evidence.countedQuantity));
    assert.equal(Number(after.expectedQuantity), Number(evidence.expectedQuantity));
    assert.equal(after.itemVersion, before.itemVersion, "the first count point is untouched");
    assert.equal(after.countedAt!.getTime(), before.countedAt!.getTime());
    assert.equal(after.counterId, fx.cashier.id);

    assert.equal(await stockOf(it.itemId), 52, "54 seen, then 2 left: 52");
  });

  test("with no recount the rebase still uses the original cursor", async () => {
    // The non-vacuity partner: if the resolver always reached for a recount,
    // this case would break instead.
    const it = await counted({ stock: 20, count: 18 });
    const line = await db.stockCountLine.findUniqueOrThrow({ where: { id: it.lineId } });
    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });

    await move(it.itemId, 6);
    const accepted = await as(
      fx.manager.email,
      `/api/stock-counts/${it.sessionId}/lines/${it.lineId}/accept-variance`,
      { method: "POST", body: JSON.stringify({ reasonCodeId }) }
    );
    assert.ok(accepted.status < 300, accepted.text);
    await confirm(it.sessionId, `${fx.marker}-plain`);

    const result = await rebaseFromCount({
      sessionId: it.sessionId, actorId: fx.manager.id,
      idempotencyKey: `${fx.marker}-rebase-plain`,
    });
    assert.equal(result.itemsRebased, 1);

    const rebase = await db.stockCountRebase.findFirstOrThrow({
      where: { sessionId: it.sessionId },
    });
    assert.equal(Number(rebase.countedQuantity), 18);
    assert.equal(Number(rebase.replayedDelta), 6, "replayed from the original count point");
    assert.equal(await stockOf(it.itemId), 24, "18 seen, then 6 arrived");
    assert.equal(line.itemVersion, (await db.stockCountLine.findUniqueOrThrow({
      where: { id: it.lineId },
    })).itemVersion);
  });

  test("an approved correction rebases the corrected figure from the original cursor", async () => {
    const it = await counted({ stock: 30, count: 35 });
    await submitCountSession({ sessionId: it.sessionId, submittedById: fx.manager.id });

    const proposed = await as<{ correctionId?: string }>(
      fx.manager.email,
      `/api/stock-counts/${it.sessionId}/lines/${it.lineId}/correction`,
      { method: "POST", body: JSON.stringify({ newCountedQuantity: 3.5, reasonCodeId }) }
    );
    assert.ok(proposed.status < 300, proposed.text);
    const signed = await as(fx.owner.email, `/api/corrections/${proposed.body.correctionId}/approve`, {
      method: "POST", body: "{}",
    });
    assert.ok(signed.status < 300, signed.text);

    await move(it.itemId, 1);

    const accepted = await as(
      fx.manager.email,
      `/api/stock-counts/${it.sessionId}/lines/${it.lineId}/accept-variance`,
      { method: "POST", body: JSON.stringify({ reasonCodeId }) }
    );
    assert.ok(accepted.status < 300, accepted.text);
    await confirm(it.sessionId, `${fx.marker}-corrected`);
    await rebaseFromCount({
      sessionId: it.sessionId, actorId: fx.manager.id,
      idempotencyKey: `${fx.marker}-rebase-corrected`,
    });

    const rebase = await db.stockCountRebase.findFirstOrThrow({
      where: { sessionId: it.sessionId },
    });
    assert.equal(Number(rebase.countedQuantity), 3.5, "the corrected figure");
    assert.equal(Number(rebase.replayedDelta), 1, "from the original count point");
    assert.equal(await stockOf(it.itemId), 4.5);
    assert.equal(
      Number((await db.stockCountLine.findUniqueOrThrow({ where: { id: it.lineId } })).countedQuantity),
      35,
      "and the observation that was corrected is still on the record"
    );
  });
});
