// Ordinary acceptance must recheck staff scope after temporary assignment changes.
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabase, db, tag, teardownTaggedCafe } from "./helpers/db";
import { acceptHandover } from "@/lib/handover";
import { resolveStaffBranch } from "@/lib/staff-branch";

let fx: { cafeId: string; branchId: string; otherBranchId: string; ownerId: string; staffId: string; coworkerId: string };
beforeEach(async () => {
  await assertTestDatabase();
  const marker = tag("HANDOVER014");
  const cafe = await db.cafe.create({ data: {
    name: marker, slug: marker.toLowerCase(), settings: { create: {} },
    branches: { create: [{ name: marker + " main" }, { name: marker + " annex" }] },
  }, include: { branches: true } });
  const branchId = cafe.branches.find(b => b.name.endsWith("main"))!.id;
  const otherBranchId = cafe.branches.find(b => b.name.endsWith("annex"))!.id;
  const owner = await db.user.create({ data: { cafeId: cafe.id, role: "CAFE_OWNER", email: marker + "-owner@example.invalid", name: marker + " owner", passwordHash: "no-login-path" } });
  const staff = await db.user.create({ data: { cafeId: cafe.id, branchId, role: "CASHIER", email: marker + "-staff@example.invalid", name: marker + " staff", passwordHash: "no-login-path" } });
  const coworker = await db.user.create({ data: { cafeId: cafe.id, branchId, role: "CASHIER", email: marker + "-coworker@example.invalid", name: marker + " coworker", passwordHash: "no-login-path" } });
  fx = { cafeId: cafe.id, branchId, otherBranchId, ownerId: owner.id, staffId: staff.id, coworkerId: coworker.id };
});
afterEach(async () => { if (fx) await teardownTaggedCafe(fx.cafeId); });
after(async () => { await db.$disconnect(); });

// There is no inventory in this owned cafe: its complete confirmed count and
// required-item snapshot are both empty. All custody, freeze and shift gates
// still run, and successful controls prove this is fully acceptable evidence.
async function acceptable(branchId = fx.branchId) {
  const outgoing = await db.shift.create({ data: { cafeId: fx.cafeId, branchId, cashierId: fx.ownerId, shiftNumber: 1, status: "AWAITING_HANDOVER", financiallyClosedAt: new Date() } });
  const stock = await db.custodyPeriod.create({ data: { cafeId: fx.cafeId, branchId, scope: "STOCK", holderType: "USER", responsibleShiftId: outgoing.id, participants: { create: { userId: fx.ownerId, role: "PRIMARY" } } } });
  const incoming = await db.shift.create({ data: { cafeId: fx.cafeId, branchId, cashierId: fx.coworkerId, shiftNumber: 2, custodyGateReason: "AWAITING_CUSTODY_TRANSFER" } });
  const handover = await db.handoverSession.create({ data: {
    cafeId: fx.cafeId, branchId, outgoingShiftId: outgoing.id, outgoingUserId: fx.ownerId,
    outgoingStockCustodyId: stock.id, status: "OUTGOING_SUBMITTED", target: "SHIFT_TO_SHIFT",
    stockMode: "SELECTED", requiredItemTrigger: "REGULAR_MODE", requiredItemCount: 0,
    periodicScheduleSnapshot: "MANUAL_ONLY", configSnapshotAt: new Date(), businessDateSnapshot: "2026-10-02",
  } });
  const count = await db.stockCountSession.create({ data: {
    cafeId: fx.cafeId, branchId, type: "CRITICAL", status: "CONFIRMED", scopeDerivation: "CRITICAL_ONLY",
    accountabilityContext: "HANDOVER", handoverId: handover.id, custodyPeriodId: stock.id,
    initiatedById: fx.ownerId, confirmedById: fx.ownerId, confirmedAt: new Date(),
  } });
  await db.handoverSession.update({ where: { id: handover.id }, data: { stockCountSessionId: count.id } });
  const freeze = await db.inventoryFreeze.create({ data: { cafeId: fx.cafeId, branchId, handoverId: handover.id, startedById: fx.ownerId } });
  return { handoverId: handover.id, incomingShiftId: incoming.id, stockId: stock.id, countId: count.id, freezeId: freeze.id, branchId };
}
type Ready = Awaited<ReturnType<typeof acceptable>>;
const accept = (h: Ready, incomingUserId = fx.staffId, viewerBranchId: string | null = h.branchId) => acceptHandover({
  handoverId: h.handoverId, cafeId: fx.cafeId, incomingUserId, viewerBranchId,
  incomingShiftId: h.incomingShiftId, idempotencyKey: "handover014:" + h.handoverId,
});
async function untouched(h: Ready) {
  assert.equal((await db.handoverSession.findUniqueOrThrow({ where: { id: h.handoverId } })).status, "OUTGOING_SUBMITTED");
  assert.equal((await db.custodyPeriod.findUniqueOrThrow({ where: { id: h.stockId } })).status, "OPEN");
  assert.equal((await db.stockCountSession.findUniqueOrThrow({ where: { id: h.countId } })).status, "CONFIRMED");
  assert.equal((await db.inventoryFreeze.findUniqueOrThrow({ where: { id: h.freezeId } })).releasedAt, null);
  assert.equal(await db.custodyParticipant.count({ where: { userId: fx.staffId, custodyPeriod: { cafeId: fx.cafeId } } }), 0);
  assert.equal(await db.custodyPeriod.count({ where: { cafeId: fx.cafeId } }), 1);
  assert.equal(await db.auditLog.count({ where: { cafeId: fx.cafeId } }), 0);
}
const forbidden = (error: unknown) => (error as { status?: number }).status === 403;

test("activation after authentication refuses accepting custody in the old home branch", async () => {
  const h = await acceptable();
  const viewerBranchId = (await resolveStaffBranch(fx.staffId))!.branchId;
  await db.user.update({ where: { id: fx.staffId }, data: {
    temporaryBranchId: fx.otherBranchId, temporaryBranchUntil: new Date(Date.now() + 3600000), temporaryBranchStartedAt: null,
  } });
  await assert.rejects(() => accept(h, fx.staffId, viewerBranchId), forbidden);
  await untouched(h);
});

test("expiry after authentication refuses accepting custody in the old temporary branch", async () => {
  await db.user.update({ where: { id: fx.staffId }, data: {
    temporaryBranchId: fx.otherBranchId, temporaryBranchUntil: new Date(Date.now() + 3600000), temporaryBranchStartedAt: new Date(),
  } });
  const viewerBranchId = (await resolveStaffBranch(fx.staffId))!.branchId;
  const h = await acceptable(fx.otherBranchId);
  await db.user.update({ where: { id: fx.staffId }, data: { temporaryBranchUntil: new Date(Date.now() - 60000) } });
  await assert.rejects(() => accept(h, fx.staffId, viewerBranchId), forbidden);
  await untouched(h);
});

test("unassigned staff cannot use a null viewer branch to accept custody", async () => {
  const h = await acceptable();
  await db.user.update({ where: { id: fx.staffId }, data: { branchId: null } });
  await assert.rejects(() => accept(h, fx.staffId, null), forbidden);
  await untouched(h);
});

test("a current staff branch can accept the complete custody transition", async () => {
  const h = await acceptable();
  const result = await accept(h);
  assert.equal(result.status, "COMPLETED");
  const stock = await db.custodyPeriod.findUniqueOrThrow({ where: { id: result.incomingStockCustodyId! }, include: { participants: true } });
  assert.equal(stock.branchId, fx.branchId);
  assert.equal(stock.responsibleShiftId, h.incomingShiftId);
  assert.equal(stock.participants[0].userId, fx.staffId);
});

test("an unassigned owner retains branch choice for ordinary acceptance", async () => {
  const h = await acceptable(fx.otherBranchId);
  const result = await accept(h, fx.ownerId, null);
  assert.equal(result.status, "COMPLETED");
  assert.equal((await db.custodyPeriod.findUniqueOrThrow({ where: { id: result.incomingStockCustodyId! } })).branchId, fx.otherBranchId);
});
