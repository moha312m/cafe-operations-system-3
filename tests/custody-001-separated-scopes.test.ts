// CUSTODY-001 — the drawer and the store room are held separately.
//
// An earlier draft had `CustodyScope.BOTH`, plus `Shift.custodyPeriodId` and
// `CustodyPeriod.shiftId` — three overlapping ways to say the same thing, and
// none of them able to express the ordinary case: the barista holds the stock
// while the cashier holds the drawer. All three are gone.
//
// What replaces them is two independent periods and a join table. A shift may
// hold one CASH and one STOCK period at once; a period may span shifts.
// Neither owns the other, so the link is a row, not a column.
//
// The thing this suite protects hardest is what did NOT change. `Shift` gains
// no custody column, `Shift.cashierId` is untouched, and `requireCashCustody`
// and `getActiveShift` are not consulted — POS keeps working exactly as it
// did. A schema that quietly moved custody out from under the existing cash
// path would break the one flow this system already gets right.

import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { db, tag, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("CUSTODY001");
let cafeId: string;
let branchId: string;
let userA: string;
let userB: string;
let shiftId: string;

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`,
      slug: MARKER.toLowerCase(),
      settings: { create: {} },
      branches: { create: [{ name: `${MARKER} main` }, { name: `${MARKER} other` }] },
    },
    include: { branches: { orderBy: { name: "asc" } } },
  });
  cafeId = cafe.id;
  // "main" sorts before "other". The second branch exists so the partial
  // unique index is exercised against a café that has more than one.
  branchId = cafe.branches[0].id;

  const mk = async (suffix: string) =>
    (await db.user.create({
      data: {
        email: `${MARKER}-${suffix}@example.invalid`,
        name: `${MARKER}-${suffix}`,
        passwordHash: "no-login-path",
        role: "CASHIER",
        cafeId,
        branchId,
      },
    })).id;
  userA = await mk("a");
  userB = await mk("b");

  const shift = await db.shift.create({
    data: {
      cafeId, branchId, cashierId: userA, shiftNumber: 1,
      openingCashAmount: 100, expectedCashAmount: 100,
    },
  });
  shiftId = shift.id;
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

/** A custody period this test owns, cleaned up by café cascade. */
async function period(scope: "CASH" | "STOCK", data: Record<string, unknown> = {}) {
  return db.custodyPeriod.create({
    data: { cafeId, branchId, scope, ...data },
  });
}

describe("CUSTODY-001 CASH and STOCK are separate custodies", () => {
  test("one shift carries a CASH period and a STOCK period at the same time", async () => {
    // The case the old `BOTH` scope could not express, and the whole reason
    // the join exists: the cashier holds the drawer, the barista the store.
    const cash = await period("CASH", { openingCashAmount: 100 });
    const stock = await period("STOCK");
    try {
      await db.shiftCustody.create({
        data: { shiftId, custodyPeriodId: cash.id, scope: "CASH" },
      });
      await db.shiftCustody.create({
        data: { shiftId, custodyPeriodId: stock.id, scope: "STOCK" },
      });

      const links = await db.shiftCustody.findMany({
        where: { shiftId }, include: { custodyPeriod: true },
      });
      assert.equal(links.length, 2);
      assert.deepEqual(
        links.map((l) => l.scope).sort(), ["CASH", "STOCK"],
        "one shift, two custodies, neither owning the other"
      );
    } finally {
      await db.shiftCustody.deleteMany({ where: { shiftId } });
      await db.custodyPeriod.deleteMany({ where: { id: { in: [cash.id, stock.id] } } });
    }
  });

  test("a shift cannot hold two CASH custodies at once", async () => {
    const first = await period("CASH");
    const second = await period("CASH", { status: "TRANSFERRED" });
    try {
      await db.shiftCustody.create({
        data: { shiftId, custodyPeriodId: first.id, scope: "CASH" },
      });
      await assert.rejects(
        () => db.shiftCustody.create({
          data: { shiftId, custodyPeriodId: second.id, scope: "CASH" },
        }),
        (e: { code?: string }) => e.code === "P2002",
        "two people cannot both be answerable for one drawer on one shift"
      );
    } finally {
      await db.shiftCustody.deleteMany({ where: { shiftId } });
      await db.custodyPeriod.deleteMany({ where: { id: { in: [first.id, second.id] } } });
    }
  });

  test("CustodyScope has exactly two values, and BOTH is not one of them", async () => {
    const values = await db.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'CustodyScope' ORDER BY e.enumsortorder
    `;
    assert.deepEqual(
      values.map((v) => v.label), ["CASH", "STOCK"],
      "BOTH was the ambiguity — it must not come back"
    );
  });

  test("a period holds a PRIMARY and a SHARED participant", async () => {
    // Spec §22: a custody may be shared, and the record must say who was
    // principally answerable and who was alongside them.
    const p = await period("STOCK");
    try {
      await db.custodyParticipant.createMany({
        data: [
          { custodyPeriodId: p.id, userId: userA, role: "PRIMARY" },
          { custodyPeriodId: p.id, userId: userB, role: "SHARED" },
        ],
      });
      const parts = await db.custodyParticipant.findMany({
        where: { custodyPeriodId: p.id }, orderBy: { role: "asc" },
      });
      assert.deepEqual(parts.map((x) => x.role), ["PRIMARY", "SHARED"]);
    } finally {
      await db.custodyPeriod.deleteMany({ where: { id: p.id } });
    }
  });

  test("the same user cannot join one period twice", async () => {
    const p = await period("STOCK");
    try {
      await db.custodyParticipant.create({
        data: { custodyPeriodId: p.id, userId: userA, role: "PRIMARY" },
      });
      await assert.rejects(
        () => db.custodyParticipant.create({
          data: { custodyPeriodId: p.id, userId: userA, role: "SHARED" },
        }),
        (e: { code?: string }) => e.code === "P2002"
      );
    } finally {
      await db.custodyPeriod.deleteMany({ where: { id: p.id } });
    }
  });

  test("previousPeriodId chains, and nextPeriod reads back the other way", async () => {
    const first = await period("CASH", { status: "TRANSFERRED" });
    const second = await period("CASH", { previousPeriodId: first.id });
    try {
      const back = await db.custodyPeriod.findUniqueOrThrow({
        where: { id: second.id }, include: { previousPeriod: true },
      });
      assert.equal(back.previousPeriod?.id, first.id);

      const forward = await db.custodyPeriod.findUniqueOrThrow({
        where: { id: first.id }, include: { nextPeriod: true },
      });
      assert.equal(
        forward.nextPeriod?.id, second.id,
        "the chain is walkable in both directions, so a shortage can be traced to a holder"
      );
    } finally {
      await db.custodyPeriod.deleteMany({ where: { id: { in: [second.id, first.id] } } });
    }
  });

  test("a branch may hold only one OPEN period per scope, and may open another once transferred", async () => {
    // The partial unique index. Without it, two OPEN stock custodies could
    // exist at one branch and neither would be answerable for a shortage.
    const open = await period("STOCK");
    try {
      await assert.rejects(
        () => period("STOCK"),
        (e: { code?: string }) => e.code === "P2002",
        "a second OPEN stock custody at one branch is nobody being responsible"
      );

      // A CASH period is a different scope and must be unaffected.
      const cash = await period("CASH");
      await db.custodyPeriod.delete({ where: { id: cash.id } });

      await db.custodyPeriod.update({
        where: { id: open.id }, data: { status: "TRANSFERRED", endedAt: new Date() },
      });
      const next = await period("STOCK");
      assert.ok(next.id, "once handed over, the next custodian may open theirs");
      await db.custodyPeriod.delete({ where: { id: next.id } });
    } finally {
      await db.custodyPeriod.deleteMany({ where: { branchId } });
    }
  });

  test("Shift gained no custody column", async () => {
    // R3's correction, asserted structurally. Custody lives in the join, so
    // one shift can hold both scopes — a column could only hold one.
    const cols = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'Shift' AND column_name IN ('custodyPeriodId', 'custodyId')
    `;
    assert.deepEqual(cols, [], "Shift must carry no custody column");
  });

  test("the existing cash path is untouched: cashierId still governs a shift", async () => {
    // The load-bearing non-change. POS resolves cash custody through
    // Shift.cashierId, and nothing in this milestone may move that.
    const shift = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
    assert.equal(shift.cashierId, userA, "cashierId is intact");

    const notNull = await db.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'Shift' AND column_name = 'cashierId'
    `;
    assert.equal(
      notNull[0]?.is_nullable, "NO",
      "cashierId must not have been made nullable to make room for custody"
    );
  });
});
