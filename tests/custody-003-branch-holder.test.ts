import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { db, closeOpenShifts, tag, teardownTaggedCafe } from "./helpers/db";

const MARKER = tag("CUSTODY003");
let cafeId: string;
let branchId: string;
let userA: string;
let userB: string;

before(async () => {
  const cafe = await db.cafe.create({
    data: {
      name: `${MARKER} cafe`, slug: MARKER.toLowerCase(), settings: { create: {} },
      branches: { create: { name: `${MARKER} branch` } },
    },
    include: { branches: true },
  });
  cafeId = cafe.id;
  branchId = cafe.branches[0].id;
  const createUser = async (suffix: string) => (await db.user.create({
    data: {
      cafeId, branchId, email: `${MARKER}-${suffix}@example.invalid`,
      name: `${MARKER}-${suffix}`, passwordHash: "no-login-path", role: "CASHIER",
    },
  })).id;
  userA = await createUser("a");
  userB = await createUser("b");
});

after(() => teardownTaggedCafe(cafeId, [], { disconnect: true }));

async function shift() {
  // One drawer per cashier: close the one a previous test left open rather
  // than deleting it, so its evidence survives.
  await closeOpenShifts(branchId, userA);
  const last = await db.shift.aggregate({ where: { branchId }, _max: { shiftNumber: true } });
  return db.shift.create({
    data: {
      cafeId, branchId, cashierId: userA, shiftNumber: (last._max.shiftNumber ?? 0) + 1,
      openingCashAmount: 0, expectedCashAmount: 0,
    },
  });
}

async function clearCustody() {
  await db.custodyPeriod.updateMany({ where: { branchId }, data: { previousPeriodId: null } });
  await db.custodyPeriod.deleteMany({ where: { branchId } });
}

function stock(data: Record<string, unknown> = {}) {
  return db.custodyPeriod.create({
    data: { cafeId, branchId, scope: "STOCK", ...data } as never,
  });
}

describe("CUSTODY-003 branch-held stock custody", () => {
  test("defaults legacy-shaped custody to USER with no responsible shift", async () => {
    await clearCustody();
    const period = await stock();
    const saved = await db.custodyPeriod.findUniqueOrThrow({ where: { id: period.id } });
    assert.equal(saved.holderType, "USER");
    assert.equal(saved.responsibleShiftId, null);
  });

  test("persists BRANCH stock custody without participants or responsible shift", async () => {
    await clearCustody();
    const period = await stock({ holderType: "BRANCH" });
    const saved = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: period.id }, include: { participants: true },
    });
    assert.equal(saved.holderType, "BRANCH");
    assert.equal(saved.responsibleShiftId, null);
    assert.deepEqual(saved.participants, []);
  });

  test("persists nullable opening and acceptance evidence when supplied", async () => {
    await clearCustody();
    const acceptedAt = new Date("2026-08-31T01:00:00.000Z");
    const period = await stock({ openedById: userA, acceptedById: userB, acceptedAt });
    const saved = await db.custodyPeriod.findUniqueOrThrow({ where: { id: period.id } });
    assert.equal(saved.openedById, userA);
    assert.equal(saved.acceptedById, userB);
    assert.equal(saved.acceptedAt?.toISOString(), acceptedAt.toISOString());
  });

  test("keeps missing acceptedAt as evidence ambiguity rather than a database gate", async () => {
    await clearCustody();
    const period = await stock({ openedById: userA, acceptedById: userB });
    const saved = await db.custodyPeriod.findUniqueOrThrow({ where: { id: period.id } });
    assert.equal(saved.acceptedAt, null);
  });

  test("persists USER stock responsibility for a shift", async () => {
    await clearCustody();
    const responsible = await shift();
    const period = await stock({ responsibleShiftId: responsible.id });
    const saved = await db.custodyPeriod.findUniqueOrThrow({ where: { id: period.id } });
    assert.equal(saved.holderType, "USER");
    assert.equal(saved.responsibleShiftId, responsible.id);
  });

  test("adding a SHARED participant does not alter responsibility or PRIMARY participant", async () => {
    await clearCustody();
    const responsible = await shift();
    const period = await stock({
      responsibleShiftId: responsible.id,
      participants: { create: { userId: userA, role: "PRIMARY" } },
    });
    await db.custodyParticipant.create({
      data: { custodyPeriodId: period.id, userId: userB, role: "SHARED" },
    });
    const saved = await db.custodyPeriod.findUniqueOrThrow({
      where: { id: period.id }, include: { participants: { orderBy: { role: "asc" } } },
    });
    assert.equal(saved.responsibleShiftId, responsible.id);
    assert.deepEqual(saved.participants.map((participant) => participant.role), ["PRIMARY", "SHARED"]);
    assert.equal(saved.participants[0].userId, userA);
  });

  test("deleting the responsible shift preserves custody and clears its responsibility", async () => {
    await clearCustody();
    const responsible = await shift();
    const period = await stock({ responsibleShiftId: responsible.id });
    await db.shift.delete({ where: { id: responsible.id } });
    const saved = await db.custodyPeriod.findUniqueOrThrow({ where: { id: period.id } });
    assert.equal(saved.responsibleShiftId, null);
  });

  test("BRANCH stock custody can chain from a previous period", async () => {
    await clearCustody();
    const prior = await stock({ status: "TRANSFERRED" });
    const successor = await stock({ holderType: "BRANCH", previousPeriodId: prior.id });
    const saved = await db.custodyPeriod.findUniqueOrThrow({ where: { id: successor.id } });
    assert.equal(saved.previousPeriodId, prior.id);
  });

  test("retains the one-open-per-branch-and-scope invariant", async () => {
    await clearCustody();
    await stock({ holderType: "BRANCH" });
    await assert.rejects(() => stock({ holderType: "BRANCH" }), /unique|P2002/i);
  });

  test("indexes branch holder status and responsible shift for custody lookups", async () => {
    const indexes = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'CustodyPeriod'
    `;
    const definitions = indexes.map((row) => row.indexdef.replaceAll('"', ''));
    assert.ok(definitions.some((index) => /\(branchId, holderType, status\)/.test(index)));
    assert.ok(definitions.some((index) => /\(responsibleShiftId\)/.test(index)));
  });
});
