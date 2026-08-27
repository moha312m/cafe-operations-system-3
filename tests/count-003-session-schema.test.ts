// COUNT-003 — a physical count is its own session, not an adjustment.
//
// Spec §4. The distinction matters for reporting more than for storage: a
// manager needs to tell a physical recount from somebody's tweak, and that is
// impossible if a count is recorded as an ADJUSTMENT like any other.
//
// Two things this suite pins that are easy to lose later:
//
//   • `custodyPeriodId` is a real foreign key, not a loose string. A count
//     belongs to the custody it was taken under, and that is what lets a
//     shortage be attributed to whoever actually held the room.
//
//   • `lockedByHandoverId` is deliberately ABSENT at this migration. It ships
//     in M8, in the same migration as the `HandoverSession` table it points
//     at. Every FK-bearing column in this milestone is created together with
//     its target — no column waits two migrations for its constraint. That
//     ordering is asserted here so it stays visible rather than being a
//     remark in a plan nobody rereads.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("COUNT003");
let cafeId: string;
let branchId: string;
let userId: string;
let custodyPeriodId: string;

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: MARKER.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} main` }] },
    },
    include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;

  userId = (await db.user.create({
    data: {
      email: `${MARKER}@example.invalid`, name: MARKER,
      passwordHash: "no-login-path", role: "BRANCH_MANAGER", cafeId, branchId,
    },
  })).id;

  custodyPeriodId = (await db.custodyPeriod.create({
    data: { cafeId, branchId, scope: "STOCK" },
  })).id;
});

// This teardown used to open with `db.stockCountSession.deleteMany(...)` —
// the model the RED run existed to prove absent. The delegate was undefined,
// the hook threw on its first line, and the tagged café stayed behind. The
// purge names no model at all; see TOOLING-003.
after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

/** A session this suite owns. */
function session(data: Record<string, unknown> = {}) {
  return db.stockCountSession.create({
    data: {
      cafeId, branchId, type: "CRITICAL", scopeDerivation: "CRITICAL_ONLY",
      initiatedById: userId, ...data,
    },
  });
}

async function clearSessions() {
  await db.stockCountSession.deleteMany({ where: { cafeId } });
}

describe("COUNT-003 count session schema", () => {
  test("a session persists as DRAFT and BLIND, carrying how its scope was derived", async () => {
    await clearSessions();
    const s = await session();
    assert.equal(s.status, "DRAFT");
    assert.equal(s.mode, "BLIND", "a count is blind unless the owner says otherwise");
    assert.equal(s.type, "CRITICAL");
    assert.equal(
      s.scopeDerivation, "CRITICAL_ONLY",
      "the session records HOW its scope was chosen, so the count can be audited later"
    );
  });

  test("the custody period resolves through a relation, not a loose id", async () => {
    await clearSessions();
    const s = await session({ custodyPeriodId });
    const loaded = await db.stockCountSession.findUniqueOrThrow({
      where: { id: s.id }, include: { custodyPeriod: true },
    });
    assert.equal(loaded.custodyPeriod?.id, custodyPeriodId);
    assert.equal(
      loaded.custodyPeriod?.scope, "STOCK",
      "a stock count belongs to a stock custody — that is what makes attribution possible"
    );
  });

  test("deleting the custody period nulls the link rather than orphaning the count", async () => {
    // The count is evidence. It must survive the disappearance of the
    // custody row, holding a NULL rather than a dangling id.
    await clearSessions();
    const spare = await db.custodyPeriod.create({
      data: { cafeId, branchId, scope: "STOCK", status: "TRANSFERRED" },
    });
    const s = await session({ custodyPeriodId: spare.id });
    await db.custodyPeriod.delete({ where: { id: spare.id } });

    const after = await db.stockCountSession.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(after.custodyPeriodId, null, "the count survives, unattributed");
  });

  test("a branch may run only one active count, and may start another once confirmed", async () => {
    // Two concurrent counts of one branch would produce two contradictory
    // sets of evidence about the same shelves at the same time.
    await clearSessions();
    const first = await session({ status: "IN_PROGRESS" });
    await assert.rejects(
      () => session({ status: "IN_PROGRESS" }),
      (e: { code?: string }) => e.code === "P2002",
      "a second live count at one branch is two answers to one question"
    );

    await db.stockCountSession.update({
      where: { id: first.id }, data: { status: "CONFIRMED", confirmedAt: new Date() },
    });
    const second = await session({ status: "IN_PROGRESS" });
    assert.ok(second.id, "once the first is confirmed, the next may begin");
  });

  test("idempotencyKey is unique, so a retried submission cannot double-count", async () => {
    await clearSessions();
    const key = `${MARKER}-idem`;
    await session({ status: "CONFIRMED", idempotencyKey: key });
    await assert.rejects(
      () => session({ status: "CONFIRMED", idempotencyKey: key }),
      (e: { code?: string }) => e.code === "P2002"
    );
  });

  test("all six statuses store", async () => {
    await clearSessions();
    const statuses = [
      "DRAFT", "IN_PROGRESS", "SUBMITTED", "RECOUNT_REQUIRED", "CONFIRMED", "LOCKED",
    ] as const;
    // Only one may be active at a time, so terminal ones are created together
    // and the active ones checked one at a time.
    for (const status of statuses) {
      await clearSessions();
      const s = await session({ status });
      assert.equal(s.status, status);
    }

    const values = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'StockCountStatus' ORDER BY e.enumsortorder
    `;
    assert.deepEqual(values.map((v) => v.label), [...statuses]);
  });

  test("lockedByHandoverId does not exist yet — it ships with the table it points at", async () => {
    // R3.3, asserted rather than asserted-about. Every FK-bearing column in
    // this milestone is created in the same migration as its FOREIGN KEY, so
    // there is never an interval in which a column could hold a value no
    // constraint checks.
    const cols = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'StockCountSession' AND column_name = 'lockedByHandoverId'
    `;
    assert.deepEqual(
      cols, [],
      "lockedByHandoverId belongs to M8, alongside HandoverSession"
    );

    const handover = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_name = 'HandoverSession'
    `;
    assert.deepEqual(handover, [], "and its target does not exist yet either — consistently");
  });
});
