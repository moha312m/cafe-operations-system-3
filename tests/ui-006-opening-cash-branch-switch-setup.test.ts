// Fixture setup for the UI-006 browser interaction test (opening cash panel +
// branch opening settings card branch switching). Creates an owned café with a
// pending night-cash declaration in EACH branch, with deliberately distinctive
// drawer labels and amounts so stale cross-branch rendering is unambiguous in
// the UI. The browser steps are driven externally; this file only builds the
// world they observe and records it for the matching teardown file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./helpers/db";
import { countCafe, COUNT_PASSWORD } from "./helpers/count";
import { as } from "./helpers/http";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_FILE = path.join(
  root,
  "artifacts/commercial-readiness/2026-10-06-stage1-gates/takeover-ui006-fixture.json"
);

test("UI-006 setup: café with pending night-cash storage in both branches", async () => {
  const fx = await countCafe("UI006");

  async function pendingStorage(
    branchId: string,
    actor: { id: string },
    drawerLabel: string,
    amount: number
  ) {
    const outgoing = await db.shift.create({
      data: {
        cafeId: fx.cafeId, branchId, cashierId: actor.id, shiftNumber: 1,
        status: "CLOSED", openingCashAmount: amount, expectedCashAmount: amount,
        actualCashAmount: amount, closedAt: new Date(),
      },
    });
    const handover = await db.handoverSession.create({
      data: {
        cafeId: fx.cafeId, branchId, outgoingShiftId: outgoing.id,
        outgoingUserId: actor.id, target: "BRANCH_CUSTODY",
        resolvedTarget: "BRANCH_CUSTODY", status: "COMPLETED", completedAt: new Date(),
      },
    });
    const storage = await db.cashStorage.create({
      data: {
        cafeId: fx.cafeId, branchId, outgoingShiftId: outgoing.id,
        handoverId: handover.id, closingAmount: amount, leftInDrawer: amount,
        toTreasury: 0, drawerLabel, declaredById: actor.id,
      },
    });
    const incoming = await db.shift.create({
      data: {
        cafeId: fx.cafeId, branchId, cashierId: actor.id, shiftNumber: 2,
        openingCashAmount: 0, expectedCashAmount: 0,
      },
    });
    await db.openingCashReceipt.create({
      data: {
        cafeId: fx.cafeId, branchId, storageId: storage.id,
        incomingShiftId: incoming.id, claimantId: actor.id, expectedAmount: amount,
      },
    });
    return storage;
  }

  await pendingStorage(fx.branchId, fx.cashier, "UI006 drawer A-main", 7777.25);
  await pendingStorage(fx.otherBranchId, fx.manager, "UI006 drawer B-annex", 111.5);

  // Distinctive per-branch drawer labels for the opening-settings card.
  for (const [branchId, drawerLabel] of [
    [fx.branchId, "UI006-DRW-A"],
    [fx.otherBranchId, "UI006-DRW-B"],
  ] as const) {
    const r = await as(fx.owner.email, `/api/branches/${branchId}/opening-settings`, {
      method: "PATCH",
      body: JSON.stringify({ drawerLabel }),
    });
    assert.equal(r.status, 200, r.text);
  }

  const pendingA = await as<{ storages: Array<{ drawerLabel: string; expectedAmount: number }> }>(
    fx.owner.email, `/api/cash-storage/pending?branchId=${fx.branchId}`
  );
  const pendingB = await as<{ storages: Array<{ drawerLabel: string; expectedAmount: number }> }>(
    fx.owner.email, `/api/cash-storage/pending?branchId=${fx.otherBranchId}`
  );
  assert.equal(pendingA.body.storages[0]?.drawerLabel, "UI006 drawer A-main");
  assert.equal(pendingA.body.storages[0]?.expectedAmount, 7777.25);
  assert.equal(pendingB.body.storages[0]?.drawerLabel, "UI006 drawer B-annex");
  assert.equal(pendingB.body.storages[0]?.expectedAmount, 111.5);

  writeFileSync(
    FIXTURE_FILE,
    JSON.stringify(
      {
        cafeId: fx.cafeId,
        branchId: fx.branchId,
        otherBranchId: fx.otherBranchId,
        marker: fx.marker,
        ownerEmail: fx.owner.email,
        waiterEmail: fx.waiter.email,
        password: COUNT_PASSWORD,
      },
      null,
      2
    )
  );
  console.log(`UI006 fixture ready: ${FIXTURE_FILE}`);
});
