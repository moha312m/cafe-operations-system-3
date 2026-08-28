// COUNT-008 (T24) — the scope of a count is not the caller's to choose.
//
// Spec §3/§4. A count is evidence, and evidence that the person being
// measured can shape is not evidence. The whole task reduces to one property
// with two halves:
//
//   THE SERVER DERIVES THE SCOPE. `resolveCountScope` (T9) takes no item-id
//   parameter, so there is nowhere for a request to say which shelves to
//   look at. This suite pins that the HTTP layer did not quietly reintroduce
//   the parameter the service refused to have.
//
//   A SUPPLIED SCOPE IS REFUSED, NOT IGNORED. Dropping `inventoryItemIds`
//   silently would leave a custodian believing they had narrowed the count —
//   and believing a clean result meant something. So the body is rejected
//   with a sentence saying where scope comes from.
//
// CYCLE keeps the same shape it has in the service: refused by name. Running
// a FULL count and labelling it a cycle would let an owner believe cycle
// counting was happening when nothing was.
//
// These run against the real API because the defect they guard is in what the
// server accepts from a browser, not in what a service function computes.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { requireServer, as } from "./helpers/http";
import { countCafe, countItem, type CountCafe } from "./helpers/count";

let fx: CountCafe;
let other: CountCafe;

/** Item ids by role in the scope, so assertions can name them. */
let criticalIds: string[];
let plainIds: string[];
let excludedIds: string[];

before(async () => {
  await requireServer();
  fx = await countCafe("COUNT008");
  other = await countCafe("COUNT008X");

  const critA = await countItem(fx, "critical beans", { isCritical: true, stock: 12 });
  const critB = await countItem(fx, "critical milk", { isCritical: true, stock: 30 });
  const plainA = await countItem(fx, "sugar", { stock: 5 });
  const plainB = await countItem(fx, "cups", { stock: 100 });
  const plainC = await countItem(fx, "lids", { stock: 80 });
  const archived = await countItem(fx, "archived beans", { isCritical: true, archived: true });
  const inactive = await countItem(fx, "retired milk", { isCritical: true, isActive: false });

  criticalIds = [critA.id, critB.id].sort();
  plainIds = [plainA.id, plainB.id, plainC.id].sort();
  excludedIds = [archived.id, inactive.id].sort();

  // The annex holds nothing critical — a branch that cannot answer a
  // CRITICAL count, which is a refusal rather than an empty count.
  await countItem(fx, "annex sugar", { branchId: fx.otherBranchId, stock: 4 });
});

after(() =>
  teardownTaggedCafe([fx?.cafeId, other?.cafeId].filter(Boolean) as string[], [], {
    disconnect: true,
  })
);

/**
 * Clear the branch's live sessions.
 *
 * Not politeness: the partial unique index permits one active session per
 * branch, so a suite that left one behind would make every later test fail
 * for a reason that has nothing to do with what it asserts.
 */
async function clearSessions() {
  await db.stockCountSession.deleteMany({ where: { cafeId: fx.cafeId } });
}

type StartBody = {
  session?: {
    id: string;
    type: string;
    status: string;
    scopeDerivation: string;
    custodyPeriodId: string | null;
    lineCount: number;
  };
  error?: string;
};

const start = (email: string, body: Record<string, unknown>) =>
  as<StartBody>(email, "/api/stock-counts", {
    method: "POST",
    body: JSON.stringify(body),
  });

/** The scope the server actually wrote, read straight from the lines. */
async function scopeOf(sessionId: string): Promise<string[]> {
  const lines = await db.stockCountLine.findMany({
    where: { sessionId },
    select: { inventoryItemId: true },
  });
  return lines.map((l) => l.inventoryItemId).sort();
}

describe("COUNT-008 count start and server-derived scope", () => {
  test("a CRITICAL start covers the owner's critical items and nothing else", async () => {
    await clearSessions();
    const r = await start(fx.manager.email, { type: "CRITICAL" });
    assert.ok(r.status < 300, `start failed: ${r.text}`);
    const session = r.body.session!;

    assert.equal(session.type, "CRITICAL");
    assert.equal(session.lineCount, criticalIds.length);
    assert.deepEqual(await scopeOf(session.id), criticalIds);

    const lines = await db.stockCountLine.findMany({ where: { sessionId: session.id } });
    assert.ok(
      lines.every((l) => l.disposition === "PENDING"),
      "a line nobody has counted yet is PENDING"
    );
    assert.ok(
      lines.every((l) => l.countedQuantity === null && l.expectedQuantity === null),
      "starting a count records no figures — the count point is captured at capture"
    );
  });

  test("a FULL start covers every eligible item and excludes archived and inactive", async () => {
    await clearSessions();
    const r = await start(fx.manager.email, { type: "FULL" });
    assert.ok(r.status < 300, `start failed: ${r.text}`);
    const session = r.body.session!;

    const expected = [...criticalIds, ...plainIds].sort();
    assert.deepEqual(await scopeOf(session.id), expected);
    for (const id of excludedIds) {
      assert.ok(
        !expected.includes(id),
        "an archived or deactivated ingredient is not on the shelf to be found"
      );
    }
    assert.equal(session.lineCount, expected.length);
  });

  test("a body naming the items is refused, not quietly ignored", async () => {
    await clearSessions();
    const before = await db.stockCountSession.count({ where: { cafeId: fx.cafeId } });

    const r = await start(fx.manager.email, {
      type: "FULL",
      inventoryItemIds: [criticalIds[0]],
    });
    assert.equal(r.status, 400, `expected a refusal, got ${r.status}: ${r.text}`);
    assert.match(
      r.body.error ?? "",
      /نطاق الجرد بيتحدد من الإعدادات، مش من الطلب/,
      "the refusal must say where scope comes from"
    );

    const after = await db.stockCountSession.count({ where: { cafeId: fx.cafeId } });
    assert.equal(after, before, "a refused start creates no session");
  });

  test("scopeDerivation is persisted, so a count can be audited without re-deriving it", async () => {
    await clearSessions();
    const critical = await start(fx.manager.email, { type: "CRITICAL" });
    assert.equal(critical.body.session!.scopeDerivation, "CRITICAL_ONLY");
    const stored = await db.stockCountSession.findUniqueOrThrow({
      where: { id: critical.body.session!.id },
    });
    assert.equal(stored.scopeDerivation, "CRITICAL_ONLY");

    await clearSessions();
    const full = await start(fx.manager.email, { type: "FULL" });
    assert.equal(full.body.session!.scopeDerivation, "ALL_ELIGIBLE");
  });

  test("a CYCLE-policy café is refused by name rather than served a FULL count", async () => {
    await clearSessions();
    await db.cafeSettings.update({
      where: { cafeId: fx.cafeId },
      data: { stockCountPolicy: "CYCLE" },
    });
    try {
      const r = await start(fx.manager.email, { type: "FULL" });
      assert.equal(r.status, 400, `expected a refusal, got ${r.status}: ${r.text}`);
      assert.match(
        r.body.error ?? "",
        /CYCLE/,
        "the refusal must name CYCLE — an owner who chose it should learn it is unsupported"
      );
      assert.equal(
        await db.stockCountSession.count({ where: { cafeId: fx.cafeId } }),
        0,
        "no session, and certainly not a FULL one wearing a CYCLE label"
      );
    } finally {
      await db.cafeSettings.update({
        where: { cafeId: fx.cafeId },
        data: { stockCountPolicy: "HYBRID" },
      });
    }
  });

  test("a caller asking for a CYCLE count is told CYCLE is unsupported", async () => {
    // Not "not one of FULL, CRITICAL" — true, but it would leave somebody who
    // meant cycle counting concluding they had mistyped.
    await clearSessions();
    const r = await start(fx.manager.email, { type: "CYCLE" });
    assert.equal(r.status, 400, `expected a refusal, got ${r.status}: ${r.text}`);
    assert.match(r.body.error ?? "", /CYCLE/);
    assert.equal(await db.stockCountSession.count({ where: { cafeId: fx.cafeId } }), 0);
  });

  test("a branch with nothing critical is refused rather than given an empty count", async () => {
    await clearSessions();
    const r = await start(fx.owner.email, {
      type: "CRITICAL",
      branchId: fx.otherBranchId,
    });
    assert.equal(r.status, 400, `expected a refusal, got ${r.status}: ${r.text}`);
    assert.match(r.body.error ?? "", /مفيش أصناف حرجة متظبطة/);
    assert.equal(await db.stockCountSession.count({ where: { cafeId: fx.cafeId } }), 0);
  });

  test("two starts racing at one branch leave one session, and the loser gets 409", async () => {
    await clearSessions();
    const [a, b] = await Promise.all([
      start(fx.manager.email, { type: "CRITICAL" }),
      start(fx.cashier.email, { type: "CRITICAL" }),
    ]);

    const codes = [a.status, b.status].sort((x, y) => x - y);
    assert.ok(codes[0] < 300, `one start should succeed: ${a.text} / ${b.text}`);
    assert.equal(
      codes[1],
      409,
      `the loser must be told a count is already running, not crash: ${a.text} / ${b.text}`
    );
    assert.equal(
      await db.stockCountSession.count({ where: { branchId: fx.branchId } }),
      1,
      "two live counts of one branch are two answers to one question"
    );
  });

  test("a caller without stock_count.start is refused", async () => {
    await clearSessions();
    const r = await start(fx.waiter.email, { type: "CRITICAL" });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
    assert.equal(await db.stockCountSession.count({ where: { cafeId: fx.cafeId } }), 0);
  });

  test("the session links the branch's open STOCK custody", async () => {
    await clearSessions();
    const period = await db.custodyPeriod.create({
      data: {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        scope: "STOCK",
        participants: { create: [{ userId: fx.cashier.id, role: "PRIMARY" }] },
      },
    });
    try {
      const r = await start(fx.manager.email, { type: "CRITICAL" });
      assert.ok(r.status < 300, r.text);
      assert.equal(
        r.body.session!.custodyPeriodId,
        period.id,
        "a shortage is attributable only if the count names who held the room"
      );
    } finally {
      await clearSessions();
      await db.custodyPeriod.delete({ where: { id: period.id } });
    }
  });

  test("a branch-pinned caller cannot start a count at another branch", async () => {
    await clearSessions();
    const r = await start(fx.manager.email, {
      type: "FULL",
      branchId: fx.otherBranchId,
    });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${r.text}`);
    assert.equal(await db.stockCountSession.count({ where: { cafeId: fx.cafeId } }), 0);
  });

  test("another café's owner cannot start a count on this café's branch", async () => {
    await clearSessions();
    const r = await start(other.owner.email, { type: "FULL", branchId: fx.branchId });
    assert.ok(
      r.status === 400 || r.status === 403,
      // Not `>= 400`: a 404 from a route that does not exist would satisfy
      // that and prove nothing about tenancy.
      `expected a tenancy refusal, got ${r.status}: ${r.text}`
    );
    assert.equal(
      await db.stockCountSession.count({ where: { branchId: fx.branchId } }),
      0,
      "no session at the branch that was not theirs to count"
    );
    assert.equal(
      await db.stockCountSession.count({ where: { cafeId: other.cafeId } }),
      0,
      "and none quietly filed under their own café either"
    );
  });

  test("listing counts needs stock_count.view and never carries a target figure", async () => {
    await clearSessions();
    const started = await start(fx.manager.email, { type: "CRITICAL" });
    assert.ok(started.status < 300, started.text);

    const denied = await as(fx.waiter.email, `/api/stock-counts?branchId=${fx.branchId}`);
    assert.equal(denied.status, 403);

    const listed = await as<{ sessions: { id: string }[] }>(
      fx.cashier.email,
      `/api/stock-counts?branchId=${fx.branchId}`
    );
    assert.equal(listed.status, 200, listed.text);
    assert.ok(
      listed.body.sessions.some((s) => s.id === started.body.session!.id),
      "the count that was just started should be listed"
    );
    assert.ok(
      !/expectedQuantity|varianceQuantity/.test(listed.text),
      "the list must not carry the figure the counter is not supposed to know"
    );
  });
});
