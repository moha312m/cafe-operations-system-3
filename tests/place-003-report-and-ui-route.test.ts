import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as } from "./helpers/http";

let fx: CountCafe;
const at = new Date("2026-10-04T07:00:00.000Z");
before(async () => {
  fx = await countCafe("PLACE003");
  const asset = await db.placeAsset.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name: "Grinder", createdById: fx.owner.id } });
  const checkpoint = await db.placeCheckPoint.create({ data: { assetId: asset.id, label: "Burr condition", required: true, critical: true } });
  const shift = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: 1, status: "CLOSED", openedAt: at, closedAt: at } });
  const receipt = await db.shiftPlaceReceipt.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, incomingShiftId: shift.id, assignedUserId: fx.storekeeper.id, createdById: fx.manager.id, snapshot: [{ id: asset.id, name: asset.name, area: "Bar", checkpoints: [{ id: checkpoint.id, label: checkpoint.label, required: true, critical: true }] }], status: "OVERRIDDEN", acceptedById: fx.manager.id, acceptedAt: at, overriddenById: fx.manager.id, overrideReason: "Use backup grinder pending repair" } });
  const observation = await db.placeObservation.create({ data: { receiptId: receipt.id, assetId: asset.id, checkpointId: checkpoint.id, side: "INCOMING", condition: "FAULT", note: "Burr vibration", actorId: fx.storekeeper.id, createdAt: at } });
  await db.placeIncident.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, receiptId: receipt.id, observationId: observation.id, assetId: asset.id, reportedById: fx.storekeeper.id, createdAt: at } });
});
after(async () => { if (fx) await teardownTaggedCafe(fx.cafeId); await db.$disconnect(); });

test("opening report keeps place, cash and stock acceptance independent and shows unresolved equipment faults", async () => {
  const report = await as<{ rows: Array<{ incomingEmployee: { id: string } | null; placeStatus: string; placeInspector: { id: string } | null; placeAcceptedBy: { id: string } | null; placeFaults: number; placeOpenIncidents: number; cashStatus: string; stockStatus: string }> }>(fx.owner.email, "/api/reports/opening-receipts?range=custom_day&date=2026-10-04");
  assert.equal(report.status, 200, report.text);
  const row = report.body.rows[0];
  assert.ok(row);
  assert.equal(row.incomingEmployee?.id, fx.cashier.id);
  assert.equal(row.placeStatus, "OVERRIDDEN");
  assert.equal(row.placeInspector?.id, fx.storekeeper.id);
  assert.equal(row.placeAcceptedBy?.id, fx.manager.id);
  assert.equal(row.placeFaults, 1);
  assert.equal(row.placeOpenIncidents, 1);
  assert.equal(row.cashStatus, "NOT_DECLARED");
  assert.equal(row.stockStatus, "NOT_RECORDED");

  const filtered = await as<{ rows: unknown[] }>(fx.owner.email, "/api/reports/opening-receipts?range=custom_day&date=2026-10-04&employeeId=" + fx.storekeeper.id);
  assert.equal(filtered.status, 200, filtered.text);
  assert.equal(filtered.body.rows.length, 1);
});

test("opening receipt page serves readable Arabic to the owner", async () => {
  const page = await as(fx.owner.email, "/reports/opening-receipts");
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /تقرير استلام الكاش والخامات والمكان/);
  assert.match(page.text, /يعرض التقرير المبلغ المعلن عند إقفال الشيفت/);
  assert.doesNotMatch(page.text, /Ø|Ù|Fault recorded|Inspector:/);
});
