// COUNT-018 (SH-21 reachability) — a handover count may state which shelves
// nobody reached.
//
// THE DEFECT THIS SUITE EXISTS FOR. SH-21 lets a manager finish a handover
// whose required set was never fully counted, and SH-20 refuses one. Both
// were correct, and between them there was no way for a café to REACH the
// state either of them describes: `submitCountSession` refused any session
// carrying a line with no figure, so the count could not be submitted, so it
// could not be confirmed, so the handover could not be submitted, so the
// acceptance SH-21 overrides could never be requested. The override was
// unreachable from production. The only way any test had reached it was by
// deleting a `StockCountLine` row out from under the session — a corruption,
// not a workflow.
//
// THE REPRESENTATION. For `accountabilityContext = "HANDOVER"` ONLY, a
// session may be submitted and confirmed while one or more lines remain
// exactly as they were created:
//
//     disposition = PENDING, countedQuantity = NULL, countedAt = NULL,
//     itemVersion = NULL, and no authoritative observation of any kind.
//
// Which says: the item was explicitly in count scope, nobody physically
// observed it on this round, and capture is now closed. That is a truthful
// statement a café can make. It is NOT the same statement as "the shelf held
// zero", and every assertion below exists to keep the two apart.
//
// WHY HANDOVER ONLY. An ordinary count answers to nobody but itself, so
// "close it with gaps" has no authority behind it and no record of who
// permitted it. A handover count is answered for downstream by a named
// acceptance — SH-20 refuses the gap, SH-21 records a manager who waived it —
// so the relaxation is only ever reached through a path that names somebody.
// `BRANCH_OPENING_VERIFICATION` gets no relaxation for the same reason: SH-22
// has not defined who answers for it.
//
// The gate is spelled `=== "HANDOVER"` everywhere, never `!== "NONE"`, so a
// context added later inherits strictness rather than permission.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import {
  effectiveCountEvidence,
  hasAuthoritativeObservation,
  type LineWithEvidence,
} from "@/lib/count-evidence";

let fx: CountCafe;
/** A real handover row, so the HANDOVER context satisfies its CHECK. */
let handoverId: string;
/** A real STOCK custody, so BRANCH_OPENING_VERIFICATION satisfies its CHECK. */
let openingCustodyId: string;

before(async () => {
  await requireServer();
  fx = await countCafe("COUNT018");
  await db.toleranceRule.create({
    data: { cafeId: fx.cafeId, scope: "BRANCH", branchId: fx.branchId, quantityTolerance: "0.5" },
  });
  await db.cafeSettings.update({
    where: { cafeId: fx.cafeId },
    data: { recountRequiredOutsideTolerance: false },
  });

  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id,
      shiftNumber: 918001, openingCashAmount: 0, expectedCashAmount: 0,
    },
  });
  handoverId = (await db.handoverSession.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId,
      outgoingShiftId: shift.id, outgoingUserId: fx.cashier.id,
    },
  })).id;
  openingCustodyId = (await db.custodyPeriod.create({
    data: { cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK" },
  })).id;
});

after(() => teardownTaggedCafe(fx?.cafeId, [
  () => db.stockCountLine.deleteMany({ where: { session: { cafeId: fx.cafeId } } }),
  () => db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } }),
  () => db.handoverSession.deleteMany({ where: { cafeId: fx.cafeId } }),
], { disconnect: true }));

// ─────────────────────── the pure predicate (A2) ───────────────────────
//
// `hasAuthoritativeObservation` is the one question every consumer of this
// fix asks: did somebody physically observe this line, after recount and
// correction precedence has been resolved? It is answered on
// `effectiveCountEvidence(line).itemVersion !== null` because quantity and
// cursor are written together, in one locked transaction, by every path that
// records an observation — `recordCountLine` and `recordRecount` — and are
// meaningless apart. A figure with no cursor is not evidence the rebase can
// act on; a cursor is what makes a quantity locatable in the ledger.
//
// The table below is the whole state space, checked without a database so the
// rule can be reasoned about rather than reconstructed from six fixtures.

/** A line as the schema creates it, before anything is written to it. */
function pendingLine(): LineWithEvidence {
  return {
    id: "line-pending",
    countedQuantity: null,
    expectedQuantity: null,
    itemVersion: null,
    expectedBasis: null,
    countedAt: null,
    counterId: null,
    recounts: [],
    corrections: [],
  } as unknown as LineWithEvidence;
}

function countedLine(over: Partial<Record<string, unknown>> = {}): LineWithEvidence {
  return {
    id: "line-counted",
    countedQuantity: 9,
    expectedQuantity: 10,
    itemVersion: BigInt(7),
    expectedBasis: "LOCKED_ITEM_VERSION",
    countedAt: new Date("2026-09-01T10:00:00.000Z"),
    counterId: "counter-1",
    recounts: [],
    corrections: [],
    ...over,
  } as unknown as LineWithEvidence;
}

const recount = (over: Record<string, unknown> = {}) => ({
  id: "recount-1",
  attempt: 1,
  countedQuantity: 8,
  expectedQuantity: 10,
  varianceQuantity: -2,
  itemVersion: BigInt(9),
  countedAt: new Date("2026-09-01T11:00:00.000Z"),
  counterId: "counter-2",
  resolved: true,
  ...over,
});

const correction = () => ({
  id: "correction-1",
  newCountedQuantity: 9.5,
  approvedAt: new Date("2026-09-01T12:00:00.000Z"),
});

describe("COUNT-018 the observation predicate", () => {
  test("a line nobody reached has no authoritative observation", () => {
    const line = pendingLine();
    assert.equal(hasAuthoritativeObservation(line), false);
    // And the resolver still collapses the absent figure to zero, which is
    // exactly why the predicate cannot be built on the quantity.
    assert.equal(effectiveCountEvidence(line).quantity, 0, "0 is the resolver's shape, not a count");
    assert.equal(effectiveCountEvidence(line).itemVersion, null);
  });

  test("every shape somebody actually observed has one", () => {
    const shapes: [string, LineWithEvidence][] = [
      ["COUNTED", countedLine()],
      ["corrected", countedLine({ corrections: [correction()] })],
      ["recounted", countedLine({ recounts: [recount()] })],
      // A recount supersedes both the first count and any correction of it,
      // and carries its own cursor — so the answer must come from the
      // recount's version, not the line's.
      ["superseding recount", countedLine({
        itemVersion: null, countedAt: null, countedQuantity: null,
        recounts: [recount()],
      })],
      // Terminal is a verdict about a figure, not evidence in itself; an
      // observed line keeps its observation whatever verdict it carries.
      ["terminal observed", countedLine()],
    ];
    for (const [name, line] of shapes) {
      assert.equal(hasAuthoritativeObservation(line), true, `${name} is an observation`);
    }
  });

  test("a figure with no count point is not an observation either", () => {
    // HANDOVER-005's malformed fixture: a quantity written with no locked
    // cursor. The rebase target is "quantity + every movement above that
    // cursor", so a figure with no cursor cannot be acted on. The predicate
    // says so; the boundary still REFUSES it rather than carrying it, because
    // a figure somebody wrote down is not a shelf nobody reached.
    assert.equal(hasAuthoritativeObservation(countedLine({ itemVersion: null })), false);
    // A recount with no cursor is the same defect one level up.
    assert.equal(
      hasAuthoritativeObservation(countedLine({ recounts: [recount({ itemVersion: null })] })),
      false
    );
  });

  test("on every well-formed shape it agrees with `countedAt !== null`", () => {
    // The equivalence that lets the closing position substitute one for the
    // other. Both are written by the same locked transaction in
    // `recordCountLine` and `recordRecount`, so on anything the production
    // paths can produce they cannot disagree.
    const wellFormed: LineWithEvidence[] = [
      pendingLine(),
      countedLine(),
      countedLine({ corrections: [correction()] }),
      countedLine({ recounts: [recount()] }),
      countedLine({ itemVersion: null, countedAt: null, countedQuantity: null, recounts: [recount()] }),
    ];
    for (const line of wellFormed) {
      assert.equal(
        hasAuthoritativeObservation(line),
        effectiveCountEvidence(line).countedAt !== null,
        `predicate and countedAt must agree on ${line.id}`
      );
    }
  });
});

// ──────────────────── submitting an incomplete count ────────────────────

let seq = 0;
async function item(stock: number) {
  seq += 1;
  return countItem(fx, `c018 item ${seq}`, { stock, isCritical: true, costPerUnit: 450 });
}

type Ctx = "NONE" | "HANDOVER" | "BRANCH_OPENING_VERIFICATION";

const binding = (context: Ctx) =>
  context === "HANDOVER"
    ? { handoverId }
    : context === "BRANCH_OPENING_VERIFICATION"
      ? { openingBranchCustodyPeriodId: openingCustodyId }
      : {};

/**
 * A session over `observed.length` captured items and `unobserved` items that
 * are in scope and never touched.
 *
 * Capture goes through the real PATCH route: the point of this suite is what
 * production can reach, and a fixture that wrote figures directly would prove
 * nothing about the path a café walks.
 */
async function session(context: Ctx, observed: number[], unobserved: number) {
  await db.stockCountLine.deleteMany({ where: { session: { cafeId: fx.cafeId } } });
  await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });

  const observedItems = await Promise.all(observed.map(() => item(10)));
  const unobservedItems = await Promise.all(
    Array.from({ length: unobserved }, () => item(10))
  );
  const s = await db.stockCountSession.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, type: "CRITICAL",
      scopeDerivation: "CRITICAL_ONLY", status: "IN_PROGRESS",
      initiatedById: fx.manager.id,
      accountabilityContext: context,
      ...binding(context),
      lines: {
        create: [...observedItems, ...unobservedItems].map((it) => ({
          inventoryItemId: it.id, unit: "KG" as const,
        })),
      },
    },
    select: { id: true, lines: { select: { id: true, inventoryItemId: true } } },
  });

  for (const [i, it] of observedItems.entries()) {
    const lineId = s.lines.find((l) => l.inventoryItemId === it.id)!.id;
    const r = await as(fx.cashier.email, `/api/stock-counts/${s.id}/lines/${lineId}`, {
      method: "PATCH", body: JSON.stringify({ countedQuantity: observed[i] }),
    });
    assert.ok(r.status < 300, `fixture capture failed: ${r.text}`);
  }

  return {
    id: s.id,
    observedLineIds: observedItems.map((it) => s.lines.find((l) => l.inventoryItemId === it.id)!.id),
    unobservedLineIds: unobservedItems.map(
      (it) => s.lines.find((l) => l.inventoryItemId === it.id)!.id
    ),
  };
}

const submit = (id: string) =>
  as<{ status?: string; within?: number; outside?: number; skippedUnobserved?: number; error?: string }>(
    fx.manager.email, `/api/stock-counts/${id}/submit`, { method: "POST", body: "{}" }
  );

/** Every column an unobserved line must still be empty in after a submit. */
async function assertUntouched(lineIds: string[]) {
  for (const id of lineIds) {
    const line = await db.stockCountLine.findUniqueOrThrow({
      where: { id },
      include: { recounts: true, corrections: true },
    });
    assert.equal(line.disposition, "PENDING", `${id} disposition`);
    assert.equal(line.countedQuantity, null, `${id} countedQuantity — a NULL is not a zero`);
    assert.equal(line.countedAt, null, `${id} countedAt`);
    assert.equal(line.itemVersion, null, `${id} itemVersion`);
    assert.equal(line.counterId, null, `${id} counterId`);
    assert.equal(line.expectedQuantity, null, `${id} expectedQuantity — nothing was expected of it`);
    assert.equal(line.expectedBasis, null, `${id} expectedBasis`);
    assert.equal(line.effectiveCountedQuantity, null, `${id} effectiveCountedQuantity`);
    assert.equal(line.varianceQuantity, null, `${id} varianceQuantity — no gap was found`);
    // Unchanged from the value the row was created with — never re-rated,
    // because there is no observation to rate.
    assert.equal(line.confidence, "UNVERIFIABLE", `${id} confidence`);
    assert.equal(line.confidenceIssues, null, `${id} confidenceIssues`);
    assert.equal(line.confidenceWindowFrom, null, `${id} confidenceWindowFrom`);
    assert.equal(line.costImpact, null, `${id} costImpact`);
    assert.equal(line.costImpactAvailable, false, `${id} costImpactAvailable`);
    assert.equal(line.costUnavailableReason, null, `${id} costUnavailableReason`);
    assert.equal(line.unitCostSnapshot, null, `${id} unitCostSnapshot`);
    assert.equal(line.unitCostSource, null, `${id} unitCostSource`);
    assert.equal(line.unitCostCapturedAt, null, `${id} unitCostCapturedAt`);
    assert.equal(line.reasonCodeId, null, `${id} reasonCodeId — nobody owes a reason for it`);
    assert.deepEqual(line.recounts, [], `${id} recounts`);
    assert.deepEqual(line.corrections, [], `${id} corrections`);
  }
}

describe("COUNT-018 submitting a handover count with shelves nobody reached", () => {
  test("a HANDOVER count submits with three lines still unobserved", async () => {
    const s = await session("HANDOVER", [10, 9.8, 10], 3);

    const r = await submit(s.id);
    assert.ok(r.status < 300, `expected submit to succeed, got ${r.status}: ${r.text}`);
    assert.equal(r.body.status, "SUBMITTED");
    // Three verdicts, from three observations. The unobserved lines are
    // counted nowhere near them.
    assert.equal((r.body.within ?? 0) + (r.body.outside ?? 0), 3, "one verdict per observation");
    assert.equal(r.body.skippedUnobserved, 3, "and three shelves nobody reached");

    const still = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(still.status, "SUBMITTED");
    assert.equal(
      await db.stockCountLine.count({ where: { sessionId: s.id } }),
      6,
      "all six lines still exist — the gap is stated, not deleted"
    );
  });

  test("nothing is written to the lines nobody reached", async () => {
    const s = await session("HANDOVER", [10, 9.8, 10], 3);
    const r = await submit(s.id);
    assert.ok(r.status < 300, r.text);

    await assertUntouched(s.unobservedLineIds);

    // No variance case, and no evidence row of any kind, was invented for them.
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLineId: { in: s.unobservedLineIds } } }),
      0,
      "a shelf nobody looked at accuses nobody"
    );
  });

  test("the lines somebody did reach are judged exactly as before", async () => {
    const s = await session("HANDOVER", [10, 9.8, 8], 3);
    const r = await submit(s.id);
    assert.ok(r.status < 300, r.text);

    const observed = await db.stockCountLine.findMany({
      where: { id: { in: s.observedLineIds } },
      orderBy: { id: "asc" },
    });
    assert.equal(observed.length, 3);
    for (const line of observed) {
      assert.ok(line.disposition !== "PENDING", "an observed line gets a verdict");
      assert.ok(line.countedAt !== null && line.itemVersion !== null);
      assert.ok(line.varianceQuantity !== null, "and a variance measured against its own count point");
      assert.ok(line.confidence !== null, "and a confidence rating");
      assert.ok(line.unitCostSource !== null, "and the cost observed when it was judged");
    }
    // 10 → within, 9.8 → within (tolerance 0.5), 8 → outside.
    assert.equal(r.body.within, 2);
    assert.equal(r.body.outside, 1);
    assert.equal(r.body.skippedUnobserved, 3);
  });
});

describe("COUNT-018 the relaxation reaches no other context", () => {
  test("an ordinary NONE count still refuses to submit over an unlooked-at shelf", async () => {
    const s = await session("NONE", [10, 10], 1);
    const r = await submit(s.id);
    assert.equal(r.status, 400, `expected the old refusal, got ${r.status}: ${r.text}`);
    assert.match(r.body.error ?? "", /لسه ما اتعدتش/);

    const still = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(still.status, "IN_PROGRESS", "a refused submit changes nothing");
    await assertUntouched(s.unobservedLineIds);
  });

  test("BRANCH_OPENING_VERIFICATION is not relaxed either", async () => {
    // The gate is `=== \"HANDOVER\"`, not `!== \"NONE\"`. A context that is not
    // NONE inherits strictness rather than permission, so SH-22 has to decide
    // for itself who answers for a gap.
    const s = await session("BRANCH_OPENING_VERIFICATION", [10, 10], 1);
    const r = await submit(s.id);
    assert.equal(r.status, 400, `expected the old refusal, got ${r.status}: ${r.text}`);
    assert.match(r.body.error ?? "", /لسه ما اتعدتش/);

    const still = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(still.status, "IN_PROGRESS");
    await assertUntouched(s.unobservedLineIds);
  });

  test("a fully counted HANDOVER session is unchanged by the relaxation", async () => {
    const s = await session("HANDOVER", [10, 9.8, 8], 0);
    const r = await submit(s.id);
    assert.ok(r.status < 300, r.text);
    assert.equal(r.body.within, 2);
    assert.equal(r.body.outside, 1);
    assert.equal(r.body.skippedUnobserved, 0, "nothing to skip, and the field says so");
  });
});

// ─────────────────── confirming over the gaps (T2 / A5) ───────────────────
//
// WHAT CONFIRMING MEANS HERE. Not "every shelf was counted" — that claim is
// exactly what the session no longer makes. It means: every observation that
// was actually made is final, and the shelves nobody reached are frozen as
// unreached and can no longer be filled in on this round. Capture closes for
// the whole session, including for the lines that were never touched, so
// there is no window in which somebody can quietly turn a gap into an
// observation after the count was signed off.
//
// The way back is a recount round — a new session, openly requested, with its
// own evidence. Not a late edit to a closed one.

const confirm = (id: string, idempotencyKey: string) =>
  as<{ status?: string; alreadyConfirmed?: boolean; varianceCaseIds?: string[]; error?: string }>(
    fx.manager.email, `/api/stock-counts/${id}/confirm`,
    { method: "POST", body: JSON.stringify({ idempotencyKey }) },
  );

const patch = (sessionId: string, lineId: string, countedQuantity: number) =>
  as<{ error?: string }>(fx.manager.email, `/api/stock-counts/${sessionId}/lines/${lineId}`, {
    method: "PATCH", body: JSON.stringify({ countedQuantity }),
  });

describe("COUNT-018 confirming a handover count over the shelves nobody reached", () => {
  test("the session confirms and the three gaps stay gaps", async () => {
    const s = await session("HANDOVER", [10, 9.8, 10], 3);
    assert.ok((await submit(s.id)).status < 300);

    const r = await confirm(s.id, `${s.id}-confirm`);
    assert.ok(r.status < 300, `expected confirm to succeed, got ${r.status}: ${r.text}`);
    assert.equal(r.body.status, "CONFIRMED");

    const still = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(still.status, "CONFIRMED");
    assert.ok(still.confirmedAt !== null);

    await assertUntouched(s.unobservedLineIds);
    assert.equal(
      await db.stockCountLine.count({ where: { sessionId: s.id, disposition: "PENDING" } }),
      3,
      "three lines are frozen as unobserved, not settled and not deleted"
    );
  });

  test("confirming fabricates no case and no evidence for them", async () => {
    const s = await session("HANDOVER", [10, 9.8, 10], 3);
    assert.ok((await submit(s.id)).status < 300);
    const r = await confirm(s.id, `${s.id}-confirm`);
    assert.ok(r.status < 300, r.text);

    // A handover count defers case-opening to the acceptance whatever it
    // contains, so this is zero for the observed lines too — and it must be
    // zero for the unobserved ones under every later path as well.
    assert.deepEqual(r.body.varianceCaseIds, []);
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLine: { sessionId: s.id } } }), 0
    );
    assert.equal(
      await db.stockCountRecount.count({ where: { lineId: { in: s.unobservedLineIds } } }), 0
    );
    assert.equal(
      await db.stockCountCorrection.count({ where: { lineId: { in: s.unobservedLineIds } } }), 0
    );
    assert.equal(
      await db.stockCountRebase.count({ where: { line: { sessionId: s.id } } }), 0,
      "confirming still does not move stock"
    );
  });

  test("capture is closed afterwards, for the gaps as much as for the rest", async () => {
    const s = await session("HANDOVER", [10, 9.8, 10], 3);
    assert.ok((await submit(s.id)).status < 300);
    assert.ok((await confirm(s.id, `${s.id}-confirm`)).status < 300);

    // The whole point of freezing them: a gap cannot be back-filled into an
    // observation after the count was signed off.
    const late = await patch(s.id, s.unobservedLineIds[0], 7);
    assert.equal(late.status, 409, `expected capture to be closed, got ${late.status}: ${late.text}`);
    assert.match(late.body.error ?? "", /اتقفل/);
    await assertUntouched(s.unobservedLineIds);

    // And the observed lines are just as closed.
    const alsoLate = await patch(s.id, s.observedLineIds[0], 7);
    assert.equal(alsoLate.status, 409, alsoLate.text);
  });

  test("neither a recount nor a correction can turn a gap into an observation", async () => {
    const s = await session("HANDOVER", [10, 9.8, 10], 3);
    assert.ok((await submit(s.id)).status < 300);
    const gap = s.unobservedLineIds[0];
    const { recordRecount } = await import("@/lib/recount");

    // Even before the count closes, a gap is not recountable: a recount is a
    // SECOND look, and there was never a first one to dispute.
    await assert.rejects(
      () => recordRecount({ lineId: gap, countedQuantity: 7, recounterId: fx.manager.id }),
      (e: Error) => /العد الأول/.test(e.message),
      "a recount may not stand in for the count that never happened"
    );

    assert.ok((await confirm(s.id, `${s.id}-confirm`)).status < 300);

    // And once the round is closed the whole session refuses, ahead of any
    // question about this particular line.
    await assert.rejects(
      () => recordRecount({ lineId: gap, countedQuantity: 7, recounterId: fx.manager.id }),
      (e: Error) => /اتقفل خلاص/.test(e.message),
      "a closed round is closed to recounts"
    );

    const reason = await db.reasonCode.create({
      data: { cafeId: fx.cafeId, domain: "STOCK", code: `${fx.marker}-C018`, label: "تصحيح" },
    });
    const { createCountCorrection } = await import("@/lib/stock-count");
    await assert.rejects(
      () => createCountCorrection({
        lineId: gap, newCountedQuantity: 7, reasonCodeId: reason.id, actorId: fx.manager.id,
      }),
      // A correction supersedes a FIGURE. There is no figure here to supersede.
      (e: Error) => /ما اتعدش/.test(e.message),
      "a correction may not invent the figure it claims to correct"
    );

    await assertUntouched(s.unobservedLineIds);
  });

  test("a repeat confirm is still idempotent and still opens nothing", async () => {
    const s = await session("HANDOVER", [10, 9.8, 10], 3);
    assert.ok((await submit(s.id)).status < 300);
    const first = await confirm(s.id, `${s.id}-confirm`);
    assert.ok(first.status < 300, first.text);
    const again = await confirm(s.id, `${s.id}-confirm`);
    assert.ok(again.status < 300, again.text);
    assert.equal(again.body.alreadyConfirmed, true);
    assert.equal(
      await db.stockCountLine.count({ where: { sessionId: s.id, disposition: "PENDING" } }), 3
    );
    await assertUntouched(s.unobservedLineIds);
  });
});

describe("COUNT-018 confirm strictness outside HANDOVER", () => {
  /**
   * A session parked at SUBMITTED with one line still PENDING.
   *
   * Written directly, because the submit gate above already refuses to
   * produce this for a non-HANDOVER context — which is the point. The
   * question here is whether the CONFIRM gate is independently scoped to
   * HANDOVER, or whether it was only ever protected by the submit gate in
   * front of it. Two gates, proved separately.
   */
  async function parkedAtSubmitted(context: Ctx) {
    const s = await session(context, [10], 1);
    await db.stockCountLine.updateMany({
      where: { id: { in: s.observedLineIds } },
      data: { disposition: "WITHIN_TOLERANCE" },
    });
    await db.stockCountSession.update({
      where: { id: s.id }, data: { status: "SUBMITTED", submittedAt: new Date() },
    });
    return s;
  }

  for (const context of ["NONE", "BRANCH_OPENING_VERIFICATION"] as const) {
    test(`a ${context} count still refuses to confirm over an unsettled line`, async () => {
      const s = await parkedAtSubmitted(context);
      const r = await confirm(s.id, `${s.id}-confirm`);
      assert.equal(r.status, 409, `expected the old refusal, got ${r.status}: ${r.text}`);
      assert.match(r.body.error ?? "", /مش مقفولة/);

      const still = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
      assert.equal(still.status, "SUBMITTED", "a refused confirm changes nothing");
      assert.equal(still.confirmedAt, null);
      await assertUntouched(s.unobservedLineIds);
    });
  }

  test("a HANDOVER count still refuses to confirm over a line that WAS observed and left unsettled", async () => {
    // The relaxation admits a line the count never touched. A line somebody
    // counted and left contested is a different thing entirely: it has a
    // figure, a count point and an unanswered question, and confirming over
    // it would close a dispute nobody resolved.
    const s = await session("HANDOVER", [10, 4], 1);
    assert.ok((await submit(s.id)).status < 300);
    const contested = await db.stockCountLine.findMany({
      where: { sessionId: s.id, disposition: { in: ["OUTSIDE_TOLERANCE", "RECOUNT_REQUIRED"] } },
      select: { id: true },
    });
    assert.equal(contested.length, 1, "the 4-against-10 line is outside tolerance");

    const r = await confirm(s.id, `${s.id}-confirm`);
    assert.equal(r.status, 409, `expected a refusal, got ${r.status}: ${r.text}`);
    assert.match(r.body.error ?? "", /مش مقفولة/);
    assert.ok(
      (r.body.error ?? "").includes(contested[0].id),
      "and the refusal names the line, not the gap"
    );
    assert.ok(!(r.body.error ?? "").includes(s.unobservedLineIds[0]));
  });
});

// ────────────────── two people confirming at once (T9) ───────────────────

describe("COUNT-018 confirming the same gap-carrying count twice at once", () => {
  test("one winner, three lines still PENDING, and nothing fabricated", async () => {
    const s = await session("HANDOVER", [10, 9.8, 10], 3);
    assert.ok((await submit(s.id)).status < 300);

    // Real HTTP, both in flight. The status guard is a conditional UPDATE, so
    // of two callers exactly one sees a row change; a serialisation bug here
    // would confirm twice and — for a count carrying gaps — is the one place
    // a second pass could invent a verdict for a shelf nobody reached.
    const [a, b] = await Promise.all([
      confirm(s.id, `${s.id}-race-a`),
      confirm(s.id, `${s.id}-race-b`),
    ]);
    assert.ok(a.status < 300, a.text);
    assert.ok(b.status < 300, b.text);
    assert.equal(
      [a, b].filter((r) => r.body.alreadyConfirmed === false).length, 1,
      "exactly one caller confirmed it; the other was told it already was",
    );

    const still = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(still.status, "CONFIRMED");
    assert.equal(
      await db.stockCountLine.count({ where: { sessionId: s.id, disposition: "PENDING" } }), 3,
      "the gaps survived the race as gaps",
    );
    assert.equal(
      await db.varianceCase.count({ where: { stockCountLine: { sessionId: s.id } } }), 0,
    );
    await assertUntouched(s.unobservedLineIds);
  });
});

// ─────────────────── the gate, read off the source (A3) ───────────────────

describe("COUNT-018 the relaxation is spelled the narrow way", () => {
  test("every accountability gate in the count engine names HANDOVER exactly", () => {
    // Behavioural tests above prove NONE and BRANCH_OPENING_VERIFICATION are
    // strict TODAY. This one is about tomorrow: `!== "NONE"` would pass every
    // test in this file and would silently hand the relaxation to whatever
    // context SH-22 adds next, before anybody had decided who answers for its
    // gaps. Read off the source so the spelling itself is the guarantee.
    const source = readFileSync("src/lib/stock-count.ts", "utf8");
    const gates = source.match(/accountabilityContext\s*[!=]==\s*"[A-Z_]+"/g) ?? [];
    assert.ok(gates.length >= 3, `expected the context gates, found ${gates.length}`);
    for (const gate of gates) {
      assert.ok(
        /accountabilityContext\s*===\s*"(HANDOVER|NONE)"/.test(gate),
        `a context gate must name its context positively, found: ${gate}`,
      );
    }
    assert.ok(
      !/accountabilityContext\s*!==\s*"NONE"/.test(source),
      "`!== \"NONE\"` would grant the relaxation to every context added later",
    );
  });
});
