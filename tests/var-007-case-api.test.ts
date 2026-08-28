// VAR-007 (T32) — a board of what is still open.
//
// Somebody has to be able to look at the differences a café has found and
// decide what to do about them, which needs the cases listable and
// filterable. Three properties make that safe rather than merely useful:
//
//   SCOPE IS THE CALLER'S, NOT THE QUERY'S. A branch-pinned user sees their
//   branch whether or not they asked for a filter, and asking for another
//   branch is refused rather than quietly widened or quietly narrowed. The
//   café boundary is absolute: another tenant's cases are not listed, not
//   counted, and not confirmed to exist.
//
//   AN UNAVAILABLE IMPACT SERIALISES AS null, NEVER 0. This is spec §12 at
//   the wire, and it is the property most easily lost between the database
//   and a JSON body: `Decimal | null` rendered carelessly becomes `0`, and a
//   shortage nobody could price then reads on a board as a shortage that
//   cost nothing. The paired flag and reason travel with it.
//
//   THE SOURCE RESOLVES THROUGH ITS RELATION. A case says what caused it —
//   the counted line, the custody period it arose under — so a reader is
//   never left holding an id and no way to see what it points at.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { dateStrInTz } from "@/lib/date-range";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { openVarianceCase } from "@/lib/variance-case";

let fx: CountCafe;
let other: CountCafe;

/** Cases this suite created, by the label it knows them by. */
const ids: Record<string, string> = {};
let custodyPeriodId: string;
let stockLineId: string;

type CaseShape = Record<string, unknown> & { id: string };

before(async () => {
  await requireServer();
  fx = await countCafe("VAR007");
  other = await countCafe("VAR007X");

  custodyPeriodId = (await db.custodyPeriod.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK",
      participants: { create: [{ userId: fx.cashier.id, role: "PRIMARY" }] },
    },
  })).id;

  // A STOCK case needs a counted line to point at.
  const item = await countItem(fx, "beans", { stock: 10, isCritical: true });
  const session = await db.stockCountSession.create({
    data: {
      cafeId: fx.cafeId, branchId: fx.branchId, type: "CRITICAL",
      scopeDerivation: "CRITICAL_ONLY", status: "CONFIRMED", confirmedAt: new Date(),
      initiatedById: fx.manager.id,
      lines: {
        create: [{
          inventoryItemId: item.id, unit: "KG",
          expectedQuantity: "10", countedQuantity: "8",
          effectiveCountedQuantity: "8", varianceQuantity: "-2",
          itemVersion: BigInt(1), countedAt: new Date(),
          disposition: "VARIANCE_CONFIRMED",
        }],
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  });
  stockLineId = session.lines[0].id;

  let n = 0;
  const shift = async (branchId: string, cafe: CountCafe) => {
    n += 1;
    return (await db.shift.create({
      data: {
        cafeId: cafe.cafeId, branchId, cashierId: cafe.cashier.id,
        shiftNumber: 6000 + n, openingCashAmount: 0, expectedCashAmount: 0,
      },
    })).id;
  };

  // A priced STOCK case, attached to the custody period it arose under.
  ids.stock = (await db.$transaction((tx) =>
    openVarianceCase(tx, {
      cafeId: fx.cafeId, branchId: fx.branchId, type: "STOCK",
      custodyPeriodId,
      source: { kind: "STOCK_LINE", stockCountLineId: stockLineId },
      quantityVariance: -2,
      amountVariance: 900,
      financialImpact: { available: true, value: 900 },
      confidence: "VERIFIED", openedById: fx.manager.id,
    })
  )).caseId;

  // A CASH case whose impact could not be established.
  ids.unpriced = (await db.$transaction(async (tx) =>
    openVarianceCase(tx, {
      cafeId: fx.cafeId, branchId: fx.branchId, type: "CASH",
      shiftId: await shift(fx.branchId, fx),
      source: { kind: "CASH_SHIFT" },
      amountVariance: -40,
      financialImpact: { available: false, reason: "CONFIDENCE_NOT_VERIFIED" },
      confidence: "PARTIAL", openedById: fx.manager.id,
    })
  )).caseId;

  // One at the café's other branch, so branch scoping is testable.
  ids.annex = (await db.$transaction(async (tx) =>
    openVarianceCase(tx, {
      cafeId: fx.cafeId, branchId: fx.otherBranchId, type: "CASH",
      shiftId: await shift(fx.otherBranchId, fx),
      source: { kind: "CASH_SHIFT" },
      amountVariance: -5,
      financialImpact: { available: true, value: 5 },
      openedById: fx.owner.id,
    })
  )).caseId;

  // And one belonging to a different café entirely.
  ids.foreign = (await db.$transaction(async (tx) =>
    openVarianceCase(tx, {
      cafeId: other.cafeId, branchId: other.branchId, type: "CASH",
      shiftId: await shift(other.branchId, other),
      source: { kind: "CASH_SHIFT" },
      amountVariance: -99,
      financialImpact: { available: true, value: 99 },
      openedById: other.manager.id,
    })
  )).caseId;
});

after(() =>
  teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], {
    disconnect: true,
  })
);

const list = (email: string, query = "") =>
  as<{ cases: CaseShape[]; error?: string }>(email, `/api/variances${query}`);

const detail = (email: string, id: string) =>
  as<{ case?: CaseShape; error?: string }>(email, `/api/variances/${id}`);

describe("VAR-007 variance case API", () => {
  test("listing returns the caller's café and nothing else", async () => {
    const r = await list(fx.owner.email, `?branchId=${fx.branchId}`);
    assert.equal(r.status, 200, r.text);
    const returned = r.body.cases.map((c) => c.id);
    assert.ok(returned.includes(ids.stock), "the café's own cases are listed");
    assert.ok(
      !returned.includes(ids.foreign),
      "another café's case must never appear on this café's board"
    );
    assert.ok(!r.text.includes(ids.foreign), "not even as an id in the payload");
  });

  test("a branch-pinned caller sees only their branch, filter or no filter", async () => {
    const unfiltered = await list(fx.manager.email);
    assert.equal(unfiltered.status, 200, unfiltered.text);
    const ids0 = unfiltered.body.cases.map((c) => c.id);
    assert.ok(ids0.includes(ids.stock), "their own branch's cases");
    assert.ok(
      !ids0.includes(ids.annex),
      "scope is the caller's, not the query's — no filter must not mean every branch"
    );

    const elsewhere = await list(fx.manager.email, `?branchId=${fx.otherBranchId}`);
    assert.equal(
      elsewhere.status, 403,
      `asking for another branch is refused, got ${elsewhere.status}: ${elsewhere.text}`
    );
  });

  test("an unpinned owner may pick a branch, and gets that branch", async () => {
    const r = await list(fx.owner.email, `?branchId=${fx.otherBranchId}`);
    assert.equal(r.status, 200, r.text);
    const returned = r.body.cases.map((c) => c.id);
    assert.deepEqual(returned, [ids.annex], "exactly the annex's cases");
  });

  test("?type= narrows to that kind of difference", async () => {
    const r = await list(fx.manager.email, `?branchId=${fx.branchId}&type=STOCK`);
    assert.equal(r.status, 200, r.text);
    const returned = r.body.cases.map((c) => c.id);
    assert.deepEqual(returned, [ids.stock]);
    assert.ok(!returned.includes(ids.unpriced), "the cash case is filtered out");
  });

  test("?status= narrows, and an unknown value is refused rather than ignored", async () => {
    const open = await list(fx.manager.email, `?branchId=${fx.branchId}&status=OPEN`);
    assert.equal(open.status, 200, open.text);
    assert.ok(open.body.cases.length >= 2, "both cases start OPEN");

    const resolved = await list(fx.manager.email, `?branchId=${fx.branchId}&status=RESOLVED`);
    assert.equal(resolved.status, 200, resolved.text);
    assert.deepEqual(resolved.body.cases, [], "and none are closed yet");

    const nonsense = await list(fx.manager.email, `?branchId=${fx.branchId}&status=NOPE`);
    assert.equal(
      nonsense.status, 400,
      "silently ignoring an unknown filter would show a board nobody asked for"
    );
  });

  test("?custodyPeriodId= returns that period's cases and no others", async () => {
    const r = await list(
      fx.manager.email,
      `?branchId=${fx.branchId}&custodyPeriodId=${custodyPeriodId}`
    );
    assert.equal(r.status, 200, r.text);
    const returned = r.body.cases.map((c) => c.id);
    assert.deepEqual(
      returned, [ids.stock],
      "who held the room is how a shortage gets attributed, so it must filter exactly"
    );
  });

  test("a date range narrows by when the case was opened", async () => {
    // The café's timezone, not UTC. `toISOString()` yields the UTC date, and
    // the API resolves `custom_day` in the café's zone (Africa/Cairo by
    // default) — so between local midnight and UTC midnight the two disagree
    // and this asked for yesterday. The suite now derives the day the same way
    // the server does, from the same helper, so they cannot drift.
    const today = dateStrInTz(new Date());
    const inRange = await list(
      fx.manager.email,
      `?branchId=${fx.branchId}&range=custom_day&date=${today}`
    );
    assert.equal(inRange.status, 200, inRange.text);
    assert.ok(inRange.body.cases.length >= 2, "opened today");

    const past = await list(
      fx.manager.email,
      `?branchId=${fx.branchId}&range=custom_day&date=2020-01-01`
    );
    assert.equal(past.status, 200, past.text);
    assert.deepEqual(past.body.cases, [], "and not on a day nothing happened");
  });

  test("an unavailable financial impact serialises as null, never as 0", async () => {
    const r = await detail(fx.manager.email, ids.unpriced);
    assert.equal(r.status, 200, r.text);
    const c = r.body.case!;
    assert.equal(
      c.financialImpact, null,
      "a shortage nobody could price is not a shortage that cost nothing"
    );
    assert.notEqual(c.financialImpact, 0, "and 0 is the wrong answer, not a rounding of it");
    assert.equal(c.financialImpactAvailable, false);
    assert.equal(c.financialImpactUnavailableReason, "CONFIDENCE_NOT_VERIFIED");
    assert.equal(c.blocking, false, "unknown is not presumed large");

    // The priced one proves the null above is not just how every case looks.
    const priced = await detail(fx.manager.email, ids.stock);
    assert.equal(Number(priced.body.case!.financialImpact), 900);
    assert.equal(priced.body.case!.financialImpactAvailable, true);
  });

  test("the detail resolves its source and custody period through relations", async () => {
    const r = await detail(fx.manager.email, ids.stock);
    assert.equal(r.status, 200, r.text);
    const c = r.body.case!;

    const line = c.stockCountLine as Record<string, unknown> | null;
    assert.ok(line, "a case must show what caused it, not just an id");
    assert.equal(line!.id, stockLineId);
    assert.equal(Number(line!.countedQuantity), 8, "the observation behind the case");
    const item = line!.inventoryItem as Record<string, unknown>;
    assert.ok(String(item.name).length > 0, "and which ingredient it was");

    const custody = c.custodyPeriod as Record<string, unknown> | null;
    assert.ok(custody, "and who held the room");
    assert.equal(custody!.id, custodyPeriodId);
    assert.equal(custody!.scope, "STOCK");
  });

  test("the payload carries no internal ledger counters", async () => {
    // LEDGER-004: `itemVersion` is a BigInt, so a route returning a count
    // line whole does not render a slightly wrong response — it returns 500.
    const r = await detail(fx.manager.email, ids.stock);
    assert.equal(r.status, 200, r.text);
    assert.ok(!/"itemVersion"/.test(r.text), "itemVersion must not reach a client");
    assert.ok(!/"ledgerVersion"/.test(r.text), "nor ledgerVersion");
  });

  test("a caller without variance.view is refused on both routes", async () => {
    const listed = await list(fx.cashier.email, `?branchId=${fx.branchId}`);
    assert.equal(listed.status, 403, `expected 403, got ${listed.status}: ${listed.text}`);
    const one = await detail(fx.cashier.email, ids.stock);
    assert.equal(one.status, 403, `expected 403, got ${one.status}: ${one.text}`);
  });

  test("another café's case is not found, and an unknown id is not found", async () => {
    const foreign = await detail(fx.manager.email, ids.foreign);
    assert.equal(foreign.status, 404, `expected 404, got ${foreign.status}: ${foreign.text}`);
    assert.ok(!foreign.text.includes("99"), "and the refusal discloses nothing about it");

    const unknown = await detail(fx.manager.email, "no-such-variance-case");
    assert.equal(unknown.status, 404, unknown.text);
  });

  test("a branch-pinned caller cannot read another branch's case", async () => {
    const r = await detail(fx.manager.email, ids.annex);
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);

    const owner = await detail(fx.owner.email, ids.annex);
    assert.equal(owner.status, 200, "while the unpinned owner may read it");
  });
});
