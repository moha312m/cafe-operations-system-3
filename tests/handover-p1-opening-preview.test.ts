// P1 — the opening warning on the POS must say what the open will actually do.
//
// GET /api/shifts/active computes `openingBlocker` for a cashier with no
// shift. The open (POST /api/shifts) reconciles first: an employee stock
// custody nobody's open shift answers for passes to the branch, and the open
// then succeeds onto the opening verification. The warning used to read the
// raw rows and announce STOCK_WITHOUT_CASH for exactly that branch.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { countCafe, countItem, type CountActor, type CountCafe } from "./helpers/count";
import { db, teardownTaggedCafe } from "./helpers/db";
import { as } from "./helpers/http";

const cafes: string[] = [];
after(async () => {
  for (const cafeId of cafes) await teardownTaggedCafe(cafeId);
  await db.$disconnect();
});

async function fixture() {
  const fx = await countCafe("P1PREVIEW");
  cafes.push(fx.cafeId);
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { stockCountPolicy: "HYBRID", handoverCountType: "FULL" } });
  await countItem(fx, "Shelf", { stock: 10, isCritical: true });
  return fx;
}

const preview = (fx: CountCafe, actor: CountActor) =>
  as<{ openingBlocker: { code: string } | null }>(actor.email, `/api/shifts/active?branchId=${fx.branchId}`);
const open = (fx: CountCafe, actor: CountActor) =>
  as<{ shift: { custodyGateReason: string | null } }>(actor.email, "/api/shifts", {
    method: "POST", body: JSON.stringify({ branchId: fx.branchId, openingCashAmount: 0 }),
  });

test("an orphaned employee stock custody is not announced as a blocker the open would repair", async () => {
  const fx = await fixture();
  // Historical fixture: stock held by somebody with no open shift, and no drawer.
  await db.custodyPeriod.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, scope: "STOCK",
    participants: { create: { userId: fx.manager.id, role: "PRIMARY" } },
  } });
  const before = await preview(fx, fx.cashier);
  assert.equal(before.status, 200, before.text);
  assert.equal(before.body.openingBlocker, null);
  // The preview wrote nothing: the period is still the employee's.
  assert.equal(await db.custodyPeriod.count({ where: { branchId: fx.branchId, status: "OPEN", holderType: "USER" } }), 1);
  const opened = await open(fx, fx.cashier);
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.body.shift.custodyGateReason, "AWAITING_OPENING_VERIFICATION");
});

test("an employee stock custody someone is still trading on is not orphaned", async () => {
  const fx = await fixture();
  const holder = await open(fx, fx.manager);
  assert.equal(holder.status, 201, holder.text);
  // The holder's drawer gone (historical shape): the stock is still answered for.
  await db.custodyPeriod.updateMany({ where: { branchId: fx.branchId, scope: "CASH" }, data: { status: "CLOSED", endedAt: new Date() } });
  const seen = await preview(fx, fx.cashier);
  assert.deepEqual(seen.body.openingBlocker, { code: "STOCK_WITHOUT_CASH" });
  const refused = await open(fx, fx.cashier);
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(JSON.parse(refused.text).openingBlocker, { code: "STOCK_WITHOUT_CASH" });
});

test("a one-sided drawer custody is still announced, and the open still refuses it", async () => {
  const fx = await fixture();
  await db.custodyPeriod.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, scope: "CASH",
    participants: { create: { userId: fx.manager.id, role: "PRIMARY" } },
  } });
  const seen = await preview(fx, fx.cashier);
  assert.deepEqual(seen.body.openingBlocker, { code: "CASH_WITHOUT_STOCK" });
  const refused = await open(fx, fx.cashier);
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(JSON.parse(refused.text).openingBlocker, { code: "CASH_WITHOUT_STOCK" });
});
