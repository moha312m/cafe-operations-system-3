import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

type ShiftRow = Record<string, unknown> & { id: string; cashierId: string };

let fx: CountCafe;

before(async () => {
  await requireServer();
  fx = await countCafe("SHIFT008-TWO-SESSIONS");
  await db.branch.update({
    where: { id: fx.branchId },
    data: { stockCountPolicyOverride: "NO_SHIFT_COUNT" },
  });
});

after(async () => {
  await teardownTaggedCafe(fx?.cafeId, [], { disconnect: true });
});

test("owner and cashier use separate sessions and separate concurrent shifts", async () => {
  const ownerOpen = await as<{ shift: ShiftRow }>(fx.owner.email, "/api/shifts", {
    method: "POST",
    body: JSON.stringify({ branchId: fx.branchId, openingCashAmount: 120 }),
  });
  assert.equal(ownerOpen.status, 201, ownerOpen.text);
  const cashierOpen = await as<{ shift: ShiftRow }>(fx.cashier.email, "/api/shifts", {
    method: "POST",
    body: JSON.stringify({ branchId: fx.branchId, openingCashAmount: 80 }),
  });
  assert.equal(cashierOpen.status, 201, cashierOpen.text);
  assert.notEqual(ownerOpen.body.shift.id, cashierOpen.body.shift.id);
  assert.equal(ownerOpen.body.shift.cashierId, fx.owner.id);
  assert.equal(cashierOpen.body.shift.cashierId, fx.cashier.id);

  const cashierList = await as<{ shifts: ShiftRow[] }>(fx.cashier.email, "/api/shifts?status=OPEN");
  assert.equal(cashierList.status, 200, cashierList.text);
  assert.deepEqual(cashierList.body.shifts.map((s) => s.id), [cashierOpen.body.shift.id]);
  assert.equal("expectedCashAmount" in cashierList.body.shifts[0], false);
  assert.equal("totalSales" in cashierList.body.shifts[0], false);

  const ownerList = await as<{ shifts: ShiftRow[] }>(fx.owner.email, "/api/shifts?status=OPEN");
  assert.equal(ownerList.status, 200, ownerList.text);
  assert.deepEqual(
    new Set(ownerList.body.shifts.map((s) => s.id)),
    new Set([ownerOpen.body.shift.id, cashierOpen.body.shift.id]),
  );
  assert.equal(
    Number(ownerList.body.shifts.find((s) => s.id === cashierOpen.body.shift.id)?.expectedCashAmount),
    80,
  );

  const cashierReportPage = await as(fx.cashier.email, "/shifts");
  assert.equal(cashierReportPage.status, 200, cashierReportPage.text);
  assert.match(cashierReportPage.text, /ليس لديك صلاحية لعرض تقارير الشيفتات/);
  const ownerReportPage = await as(fx.owner.email, "/shifts");
  assert.equal(ownerReportPage.status, 200, ownerReportPage.text);
  assert.doesNotMatch(ownerReportPage.text, /ليس لديك صلاحية لعرض تقارير الشيفتات/);

  const cashierClose = await as<{ shift: ShiftRow }>(
    fx.cashier.email, `/api/shifts/${cashierOpen.body.shift.id}/close`, {
      method: "POST",
      body: JSON.stringify({ actualCashAmount: 80 }),
    },
  );
  assert.equal(cashierClose.status, 200, cashierClose.text);
  assert.equal(Number(cashierClose.body.shift.actualCashAmount), 80);
  assert.equal("cashDifference" in cashierClose.body.shift, false);
  assert.equal(
    (await as(fx.cashier.email, `/api/shifts/${cashierOpen.body.shift.id}/report`)).status,
    403,
  );
  assert.equal(
    (await as(fx.owner.email, `/api/shifts/${cashierOpen.body.shift.id}/report`)).status,
    200,
  );

  const stillOpen = await as<{ shifts: ShiftRow[] }>(fx.owner.email, "/api/shifts?status=OPEN");
  assert.equal(stillOpen.status, 200, stillOpen.text);
  assert.ok(stillOpen.body.shifts.some((s) => s.id === ownerOpen.body.shift.id));
});
