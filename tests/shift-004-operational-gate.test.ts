import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { db, fixture, sessionFor, tag } from "./helpers/db";
import { as, login, requireServer } from "./helpers/http";
import { getActiveShift, requireOperationalShift } from "@/lib/shifts";

const MARKER = tag("SHIFT004");
let cafeId = "";
let branchId = "";
let userId = "";
let ownerId = "";
const branchIds: string[] = [];
before(async () => {
  const fx = await fixture();
  cafeId = fx.cafeId;
  branchId = fx.branchId;
  userId = (await sessionFor("cashier@demo.com")).id;
  ownerId = (await sessionFor("owner@demo.com")).id;
  await requireServer();
  await login("owner@demo.com", "owner1234");
});
after(async () => {
  if (branchIds.length) await db.branch.deleteMany({ where: { id: { in: branchIds } } });
});

describe("SHIFT-004 operational custody gate", () => {
  test("only custodyGateReason prevents an OPEN shift from being active", async () => {
    const branch = await db.branch.create({ data: { cafeId, name: MARKER } });
    branchIds.push(branch.id);
    const legacy = await db.shift.create({ data: { cafeId, branchId: branch.id, cashierId: userId, shiftNumber: 1 } });
    assert.equal((await getActiveShift(branch.id, userId, db))?.id, legacy.id);
    await db.shift.update({ where: { id: legacy.id }, data: { custodyGateReason: "AWAITING_CUSTODY_TRANSFER" } });
    assert.equal(await getActiveShift(branch.id, userId, db), null);
    await assert.rejects(() => requireOperationalShift(branch.id, userId, db), /AWAITING_CUSTODY_TRANSFER/);
  });

  test("ready evidence is not an authorization predicate", async () => {
    const branch = await db.branch.create({ data: { cafeId, name: `${MARKER}-ready` } });
    branchIds.push(branch.id);
    const legacy = await db.shift.create({ data: { cafeId, branchId: branch.id, cashierId: userId, shiftNumber: 1 } });
    assert.equal((await getActiveShift(branch.id, userId, db))?.id, legacy.id);
  });

  test("database rejects a gate reason paired with readiness evidence", async () => {
    const branch = await db.branch.create({ data: { cafeId, name: `${MARKER}-check` } });
    branchIds.push(branch.id);
    const shift = await db.shift.create({ data: { cafeId, branchId: branch.id, cashierId: userId, shiftNumber: 1 } });
    await assert.rejects(
      () => db.shift.update({ where: { id: shift.id }, data: { custodyGateReason: "AWAITING_CUSTODY_TRANSFER", custodyReadyAt: new Date() } }),
      /check constraint|Shift_custody_gate_ready_consistent/i
    );
    const acceptedShape = await db.shift.update({
      where: { id: shift.id },
      data: { custodyGateReason: null, custodyReadyAt: new Date() },
    });
    assert.equal(acceptedShape.custodyGateReason, null);
    assert.ok(acceptedShape.custodyReadyAt);
  });

  test("active endpoint returns legacy open shifts but excludes both custody gates", async () => {
    const branch = await db.branch.create({ data: { cafeId, name: `${MARKER}-active-api` } });
    branchIds.push(branch.id);
    const shift = await db.shift.create({ data: { cafeId, branchId: branch.id, cashierId: ownerId, shiftNumber: 1 } });
    const active = await as<{ shift: { id: string } | null }>(
      "owner@demo.com", `/api/shifts/active?branchId=${branch.id}`
    );
    assert.equal(active.body.shift?.id, shift.id, "legacy NULL/NULL shift must stay operational");

    for (const custodyGateReason of ["AWAITING_CUSTODY_TRANSFER", "AWAITING_OPENING_VERIFICATION"] as const) {
      await db.shift.update({ where: { id: shift.id }, data: { custodyGateReason } });
      const gated = await as<{ shift: { id: string } | null }>(
        "owner@demo.com", `/api/shifts/active?branchId=${branch.id}`
      );
      assert.equal(gated.body.shift, null, `${custodyGateReason} shift must not be operational`);
    }
  });
});
