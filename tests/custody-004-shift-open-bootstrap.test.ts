import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { db, fixture, sessionFor, tag } from "./helpers/db";
import { ensureCustodyForShift, openCustodyPeriod } from "@/lib/custody";

const MARKER = tag("CUSTODY004");
let cafeId = "";
let branchId = "";
let userA = "";
let userB = "";
const branchIds: string[] = [];

async function shift(userId: string, number: number) {
  return db.shift.create({ data: { cafeId, branchId, cashierId: userId, shiftNumber: number } });
}

before(async () => {
  const fx = await fixture();
  cafeId = fx.cafeId;
  branchId = fx.branchId;
  userA = (await sessionFor("cashier@demo.com")).id;
  userB = (await sessionFor("manager@demo.com")).id;
});
after(async () => {
  if (branchIds.length) await db.branch.deleteMany({ where: { id: { in: branchIds } } });
});

describe("CUSTODY-004 shift-open bootstrap", () => {
  test("BRANCH cash custody is refused", async () => {
    const isolated = await db.branch.create({ data: { cafeId, name: `${MARKER}-branch-cash` } });
    branchIds.push(isolated.id);
    await assert.rejects(
      () => db.$transaction((tx) => openCustodyPeriod(tx, {
        cafeId,
        branchId: isolated.id,
        scope: "CASH",
        participants: [],
        holderType: "BRANCH",
      })),
      /Branch custody is stock-only/
    );
  });

  test("quiet branch opens anchored USER cash and stock custody", async () => {
    const isolated = await db.branch.create({ data: { cafeId, name: MARKER } });
    branchIds.push(isolated.id);
    const opening = await db.shift.create({ data: { cafeId, branchId: isolated.id, cashierId: userA, shiftNumber: 1, openingCashAmount: 25, expectedCashAmount: 25 } });
    const verdict = await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId, branchId: isolated.id, shiftId: opening.id, userId: userA, openingCashAmount: 25 }));
    assert.equal(verdict.operational, true);
    assert.ok(verdict.cashCustodyPeriodId);
    assert.ok(verdict.stockCustodyPeriodId);
    const stock = await db.custodyPeriod.findUniqueOrThrow({ where: { id: verdict.stockCustodyPeriodId! }, include: { participants: true } });
    assert.equal(stock.holderType, "USER");
    assert.equal(stock.responsibleShiftId, opening.id);
    assert.deepEqual(stock.participants.map((p) => p.role), ["PRIMARY"]);
  });

  test("shared coworker joins without changing stock responsibility", async () => {
    const isolated = await db.branch.create({ data: { cafeId, name: `${MARKER}-shared` } });
    branchIds.push(isolated.id);
    const first = await db.shift.create({ data: { cafeId, branchId: isolated.id, cashierId: userA, shiftNumber: 1 } });
    const firstVerdict = await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId, branchId: isolated.id, shiftId: first.id, userId: userA, openingCashAmount: 0 }));
    const second = await db.shift.create({ data: { cafeId, branchId: isolated.id, cashierId: userB, shiftNumber: 2 } });
    await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId, branchId: isolated.id, shiftId: second.id, userId: userB, openingCashAmount: 0 }));
    const stock = await db.custodyPeriod.findUniqueOrThrow({ where: { id: firstVerdict.stockCustodyPeriodId! }, include: { participants: true } });
    assert.equal(stock.responsibleShiftId, first.id);
    assert.deepEqual(stock.participants.map((p) => p.userId).sort(), [userA, userB].sort());
  });

  test("live handover withholds incoming stock without changing outgoing responsibility", async () => {
    const isolated = await db.branch.create({ data: { cafeId, name: `${MARKER}-handover` } });
    branchIds.push(isolated.id);
    const outgoing = await db.shift.create({ data: { cafeId, branchId: isolated.id, cashierId: userA, shiftNumber: 1 } });
    const initial = await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId, branchId: isolated.id, shiftId: outgoing.id, userId: userA, openingCashAmount: 0 }));
    await db.handoverSession.create({
      data: {
        cafeId,
        branchId: isolated.id,
        status: "OUTGOING_SUBMITTED",
        outgoingShiftId: outgoing.id,
        outgoingUserId: userA,
        outgoingStockCustodyId: initial.stockCustodyPeriodId!,
      },
    });
    const incoming = await db.shift.create({ data: { cafeId, branchId: isolated.id, cashierId: userB, shiftNumber: 2 } });
    const verdict = await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId, branchId: isolated.id, shiftId: incoming.id, userId: userB, openingCashAmount: 0 }));
    const stock = await db.custodyPeriod.findUniqueOrThrow({ where: { id: initial.stockCustodyPeriodId! }, include: { participants: true } });
    assert.equal(verdict.gate, "AWAITING_CUSTODY_TRANSFER");
    assert.equal(stock.responsibleShiftId, outgoing.id);
    assert.equal(stock.acceptedAt, null);
    assert.deepEqual(stock.participants.map((p) => p.userId), [userA]);
    assert.equal(await db.shiftCustody.count({ where: { shiftId: incoming.id, scope: "STOCK" } }), 0);
  });

  test("BRANCH stock is withheld while ordinary USER cash opens", async () => {
    const isolated = await db.branch.create({ data: { cafeId, name: `${MARKER}-branch-stock` } });
    branchIds.push(isolated.id);
    await db.$transaction((tx) => openCustodyPeriod(tx, { cafeId, branchId: isolated.id, scope: "STOCK", participants: [{ userId: userA, role: "PRIMARY" }], holderType: "BRANCH" }));
    const opening = await db.shift.create({ data: { cafeId, branchId: isolated.id, cashierId: userB, shiftNumber: 1, openingCashAmount: 10, expectedCashAmount: 10 } });
    const verdict = await db.$transaction((tx) => ensureCustodyForShift(tx, { cafeId, branchId: isolated.id, shiftId: opening.id, userId: userB, openingCashAmount: 10 }));
    assert.equal(verdict.gate, "AWAITING_OPENING_VERIFICATION");
    assert.deepEqual(verdict.withheld, ["STOCK"]);
    const cash = await db.custodyPeriod.findUniqueOrThrow({ where: { id: verdict.cashCustodyPeriodId! } });
    assert.equal(cash.holderType, "USER");
    assert.equal(await db.custodyPeriod.count({ where: { branchId: isolated.id, scope: "CASH", holderType: "BRANCH" } }), 0);
  });
});
