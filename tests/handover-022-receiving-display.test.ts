import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, login } from "./helpers/http";
import { ensureCustodyForShift } from "@/lib/custody";
import { closeShiftWithSettlement } from "@/lib/cash-close";
import { unsettledLinesMessage } from "@/lib/stock-count";
import { receivingRowDisplay, signedQuantity } from "@/components/handovers/receiving-model";

// ── Pure: what a receiving row shows ───────────────────────────────────────────
test("a disputed receiving row shows the receiving difference, not the outgoing variance", () => {
  const line = { countedQuantity: "10.000", varianceQuantity: "0.000" };
  const row = receivingRowDisplay(line, { stockCountLineId: "l", decision: "DISPUTED", incomingCountedQuantity: "8.000", handedOverQuantity: "10.000", varianceQuantity: "-2.000" }, true);
  assert.equal(row.state, "disputed");
  assert.equal(row.outgoingCount, "10");
  assert.equal(row.outgoingDifference, "0"); // the outgoing count against expected stock
  assert.equal(row.incomingCount, "8");
  assert.equal(row.handedOver, "10");
  assert.equal(row.receivingDifference, "−2"); // the receiver's count against what was handed over
});

test("no independent count is not zero, and carries no receiving difference", () => {
  const none = receivingRowDisplay({ countedQuantity: "10", varianceQuantity: "0" }, { stockCountLineId: "l", decision: "ACCEPTED", incomingCountedQuantity: null, handedOverQuantity: "10", varianceQuantity: null }, true);
  assert.equal(none.incomingCount, "بدون عدّ مستقل");
  assert.equal(none.receivingDifference, "—");
  const zero = receivingRowDisplay({ countedQuantity: "10", varianceQuantity: "0" }, { stockCountLineId: "l", decision: "DISPUTED", incomingCountedQuantity: "0", handedOverQuantity: "10", varianceQuantity: "-10" }, true);
  assert.equal(zero.incomingCount, "0");
  assert.equal(zero.receivingDifference, "−10");
});

test("outgoing figures stay hidden until disclosed; an unreceived line says so", () => {
  const hidden = receivingRowDisplay({ countedQuantity: "10", varianceQuantity: "1" }, undefined, false);
  assert.deepEqual([hidden.outgoingCount, hidden.outgoingDifference, hidden.state], ["مخفي", "مخفي", "pending"]);
  const open = receivingRowDisplay({ countedQuantity: "10", varianceQuantity: "1.500" }, undefined, true);
  assert.deepEqual([open.outgoingCount, open.outgoingDifference, open.incomingCount, open.receivingDifference], ["10", "+1.5", "—", "—"]);
});

test("signed quantities use a real minus, an explicit plus and a plain zero", () => {
  assert.deepEqual(["-2.000", "2.000", "0.000", "-0.250", null, ""].map(signedQuantity), ["−2", "+2", "0", "−0.25", "—", "—"]);
});

test("the manager refusal names the items and says what to do, never a line id", () => {
  const message = unsettledLinesMessage([{ inventoryItem: { name: "بن" } }, { inventoryItem: { name: "لبن" } }]);
  assert.match(message, /مش مقفولة \(2\): بن، لبن/);
  assert.match(message, /اعتمد الفرق.*سجّل سبب الفرق.*إعادة عد/);
  assert.doesNotMatch(message, /\bc[a-z0-9]{24}\b/);
});

// ── HTTP: current round only, with the stored figures ─────────────────────────
const cafes: string[] = [];
after(async () => {
  for (const id of cafes) {
    await db.handoverStockAcknowledgement.deleteMany({ where: { handover: { cafeId: id } } });
    await db.handoverStockBoundary.deleteMany({ where: { handover: { cafeId: id } } });
    await db.handoverRequiredItem.updateMany({ where: { handover: { cafeId: id } }, data: { satisfiedByLineId: null } });
    await db.handoverSession.updateMany({ where: { cafeId: id }, data: { stockCountSessionId: null, acceptedStockCountSessionId: null } });
    await db.stockCountSession.updateMany({ where: { cafeId: id }, data: { handoverId: null, lockedByHandoverId: null, accountabilityContext: "NONE" } });
    await db.stockCountRebase.deleteMany({ where: { session: { cafeId: id } } });
    await db.stockVarianceSpanCustody.deleteMany({ where: { span: { varianceCase: { cafeId: id } } } });
    await db.stockVarianceSpan.deleteMany({ where: { varianceCase: { cafeId: id } } });
    await db.varianceCase.deleteMany({ where: { cafeId: id } });
    await db.stockCountSession.deleteMany({ where: { cafeId: id } });
    await db.inventoryFreeze.deleteMany({ where: { cafeId: id } });
    // v2 (C1): a sheet difference/dispute opens a review row, which must go before its handover.
    await db.stockHandoverReview.deleteMany({ where: { cafeId: id } });
    await db.handoverSession.deleteMany({ where: { cafeId: id } });
    await teardownTaggedCafe(id);
  }
  await db.$disconnect();
});

async function shift(fx: CountCafe, userId: string, n: number) {
  const s = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: userId, shiftNumber: n, openingCashAmount: 100, expectedCashAmount: 100 } });
  await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: s.id, userId, openingCashAmount: 100 }));
  return s;
}
async function post<T = Record<string, unknown>>(email: string, path: string, body: unknown) {
  const r = await as<T>(email, path, { method: "POST", body: JSON.stringify(body) });
  assert.equal(r.status, 200, `${path}: ${r.text}`);
  return r.body;
}
type View = { handover: { acknowledged: boolean; workflow: { acknowledgements: { stockCountLineId: string; decision: string; incomingCountedQuantity: string | null; handedOverQuantity: string; varianceQuantity: string | null }[] }; count: { sessionId: string; countVersion: string; lines: { id: string; inventoryItem: { name: string }; countedQuantity?: unknown }[] } | null } };

test("acknowledgements are the current round's, with the receiver's own figures; a superseded dispute stays out", async () => {
  const fx = await countCafe("HNDDISPLAY");
  cafes.push(fx.cafeId);
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "HYBRID", handoverCountType: "CRITICAL", periodicFullCountSchedule: "MANUAL_ONLY", recountRequiredOutsideTolerance: false, varianceBlocksHandover: false } });
  await countItem(fx, "Alpha", { stock: 10, isCritical: true });
  await countItem(fx, "Beta", { stock: 5, isCritical: true });
  const outgoing = await shift(fx, fx.cashier.id, 1);
  const closed = await closeShiftWithSettlement({ shiftId: outgoing.id, actualCash: 100, actorId: fx.cashier.id, closedByManager: false, handoverTarget: "SHIFT_TO_SHIFT", grants: { handoverSubmit: true, handoverException: true } });
  const hid = closed.handoverId!;
  const incoming = await db.user.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, email: `incoming-${fx.marker.toLowerCase()}@example.invalid`, name: "Synthetic incoming", role: "CASHIER", passwordHash: (await db.user.findUniqueOrThrow({ where: { id: fx.cashier.id } })).passwordHash } });
  await login(incoming.email, "count-fixture-1234");
  const reason = await db.reasonCode.create({ data: { cafeId: fx.cafeId, domain: "HANDOVER", code: "RECEIVING", label: "Synthetic receiving difference" } });

  async function countAndSubmit() {
    const start = await post<{ countSession: { id: string } }>(fx.cashier.email, "/api/handovers", { action: "start_count", handoverId: hid });
    const sid = start.countSession.id;
    const detail = await as<{ session: { lines: { id: string; inventoryItem: { name: string } }[] } }>(fx.cashier.email, `/api/stock-counts/${sid}`);
    for (const line of detail.body.session.lines) {
      const q = line.inventoryItem.name.endsWith("Alpha") ? 10 : 5;
      const r = await as(fx.cashier.email, `/api/stock-counts/${sid}/lines/${line.id}`, { method: "PATCH", body: JSON.stringify({ countedQuantity: q, expectedCountedAt: null }) });
      assert.equal(r.status, 200, r.text);
    }
    assert.equal((await post<{ status: string }>(fx.cashier.email, `/api/stock-counts/${sid}/submit`, {})).status, "CONFIRMED");
    await post(fx.cashier.email, "/api/handovers", { action: "submit", handoverId: hid });
    return sid;
  }

  const sid1 = await countAndSubmit();
  await shift(fx, incoming.id, 2);
  const before = await as<View>(incoming.email, `/api/handovers/${hid}`);
  assert.equal(before.status, 200, before.text);
  assert.deepEqual(before.body.handover.workflow.acknowledgements, []);
  assert.ok(before.body.handover.count!.lines.every((l) => !("countedQuantity" in l)), "blind before the receiver's own look");

  // Alpha: incoming 8 against 10 handed over; Beta received without an independent count.
  const lines = before.body.handover.count!.lines;
  const decisions = lines.map((l) => l.inventoryItem.name.endsWith("Alpha")
    ? { stockCountLineId: l.id, incomingCountedQuantity: 8, disputeReasonCodeId: reason.id }
    : { stockCountLineId: l.id, incomingCountedQuantity: null });
  await post(incoming.email, `/api/handovers/${hid}/acknowledge`, { countSessionId: sid1, countVersion: before.body.handover.count!.countVersion, lines: decisions, idempotencyKey: crypto.randomUUID() });

  const after1 = await as<View>(incoming.email, `/api/handovers/${hid}`);
  const acks = after1.body.handover.workflow.acknowledgements;
  const alphaId = lines.find((l) => l.inventoryItem.name.endsWith("Alpha"))!.id;
  const betaId = lines.find((l) => l.inventoryItem.name.endsWith("Beta"))!.id;
  const alpha = acks.find((a) => a.stockCountLineId === alphaId)!;
  const beta = acks.find((a) => a.stockCountLineId === betaId)!;
  assert.equal(alpha.decision, "DISPUTED");
  assert.deepEqual([Number(alpha.incomingCountedQuantity), Number(alpha.handedOverQuantity), Number(alpha.varianceQuantity)], [8, 10, -2]);
  assert.equal(beta.incomingCountedQuantity, null); // no independent count is null, not zero
  assert.equal(beta.varianceQuantity, null);
  assert.equal(after1.body.handover.acknowledged, true);

  // Send it back and run a replacement round: the superseded dispute must not carry over.
  await post(incoming.email, `/api/handovers/${hid}/request-recount`, { reasonCodeId: reason.id, note: "synthetic" });
  const sid2 = await countAndSubmit();
  assert.notEqual(sid2, sid1);
  const next = await as<View>(incoming.email, `/api/handovers/${hid}`);
  assert.equal(next.status, 200, next.text);
  assert.equal(next.body.handover.count!.sessionId, sid2);
  assert.deepEqual(next.body.handover.workflow.acknowledgements, [], "no acknowledgement of the superseded round");
  assert.equal(next.body.handover.acknowledged, false, "the replacement stays blind until its own first acknowledgement");
  assert.ok(next.body.handover.count!.lines.every((l) => !("countedQuantity" in l)));
});

// ── Static: a long item name stays beside its own controls on a phone ───────────
import { readFileSync } from "node:fs";
test("below the sm breakpoint a count row is a stacked card with the full, wrapping item name", () => {
  const row = readFileSync("src/components/stock-counts/count-line-row.tsx", "utf8");
  const detail = readFileSync("src/components/stock-counts/stock-count-detail.tsx", "utf8");
  assert.match(row, /<TableRow data-testid="count-line-row" className="max-sm:block /);
  assert.match(row, /\[overflow-wrap:anywhere\] max-sm:block max-sm:max-w-none/);
  assert.match(detail, /<TableHeader className=\{compactCapture \? "max-sm:hidden" : undefined\}>/);
  assert.match(readFileSync("src/components/handovers/receiving-sheet.tsx", "utf8"), /font-medium \[overflow-wrap:anywhere\]/);
});

test("the receiving table also stacks below the sm breakpoint, so the receiving difference is not scrolled away", () => {
  const detail = readFileSync("src/components/handovers/handover-detail.tsx", "utf8");
  assert.match(detail, /<TableHeader className="max-sm:hidden">/);
  assert.match(detail, /data-testid="handover-line-row" className="max-sm:block /);
  assert.match(detail, /whitespace-normal text-end max-sm:block max-sm:text-start/);
});
