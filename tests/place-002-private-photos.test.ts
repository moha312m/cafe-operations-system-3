import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as } from "./helpers/http";

let fx: CountCafe, foreign: CountCafe, assetId: string;
before(async () => {
  fx = await countCafe("PLACE002");
  foreign = await countCafe("PLACE002-FOREIGN");
  const asset = await db.placeAsset.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name: "Espresso machine", createdById: fx.owner.id } });
  assetId = asset.id;
});
after(async () => {
  if (fx) await teardownTaggedCafe(fx.cafeId);
  if (foreign) await teardownTaggedCafe(foreign.cafeId);
  await db.$disconnect();
});

function upload(file: Blob, name: string, fields: Record<string, string>) {
  const form = new FormData();
  form.set("file", file, name);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

test("private photo upload re-encodes supported images and rejects malformed or cross-cafe targets", async () => {
  const png = await sharp({ create: { width: 8, height: 5, channels: 3, background: "#204060" } }).png().toBuffer();
  const form = upload(new Blob([Uint8Array.from(png).buffer as ArrayBuffer], { type: "image/png" }), "machine.png", { assetId });
  const stored = await as<{ photo: { id: string; mime: string; byteCount: number; width: number; height: number } }>(fx.storekeeper.email, "/api/place-photos", { method: "POST", body: form });
  assert.equal(stored.status, 201, stored.text);
  assert.equal(stored.body.photo.mime, "image/webp");
  assert.equal(stored.body.photo.width, 8);
  assert.equal(stored.body.photo.height, 5);
  assert.ok(stored.body.photo.byteCount > 0);

  const fetched = await as(fx.owner.email, "/api/place-photos/" + stored.body.photo.id);
  assert.equal(fetched.status, 200, fetched.text);
  assert.equal(fetched.headers.get("content-type"), "image/webp");
  assert.match(fetched.headers.get("cache-control") ?? "", /private/);
  const crossCafe = await as(foreign.owner.email, "/api/place-photos/" + stored.body.photo.id);
  assert.equal(crossCafe.status, 404, crossCafe.text);

  const countBefore = await db.placePhoto.count({ where: { cafeId: fx.cafeId } });
  const svg = upload(new Blob(["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"], { type: "image/svg+xml" }), "machine.svg", { assetId });
  const rejected = await as(fx.storekeeper.email, "/api/place-photos", { method: "POST", body: svg });
  assert.equal(rejected.status, 400, rejected.text);
  const bothTargets = upload(new Blob([Uint8Array.from(png).buffer as ArrayBuffer], { type: "image/png" }), "machine.png", { assetId, observationId: "foreign-observation" });
  const targetRejected = await as(fx.storekeeper.email, "/api/place-photos", { method: "POST", body: bothTargets });
  assert.equal(targetRejected.status, 400, targetRejected.text);
  assert.equal(await db.placePhoto.count({ where: { cafeId: fx.cafeId } }), countBefore);
});

test("reference and fault evidence photos stay attached to separate private targets and return with receipt history", async () => {
  const shift = await db.shift.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, cashierId: fx.cashier.id, shiftNumber: 92, status: "CLOSED", closedAt: new Date() } });
  const checkpoint = await db.placeCheckPoint.create({ data: { assetId, label: "Pressure", required: true, critical: true } });
  const receipt = await db.shiftPlaceReceipt.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, incomingShiftId: shift.id, assignedUserId: fx.storekeeper.id, createdById: fx.owner.id, snapshot: [{ id: assetId, name: "Espresso machine", area: null, checkpoints: [{ id: checkpoint.id, label: checkpoint.label, required: true, critical: true }] }] } });
  const observation = await db.placeObservation.create({ data: { receiptId: receipt.id, assetId, checkpointId: checkpoint.id, side: "INCOMING", condition: "FAULT", note: "Pressure gauge fluctuates", actorId: fx.storekeeper.id } });
  const png = await sharp({ create: { width: 10, height: 6, channels: 3, background: "#a02020" } }).png().toBuffer();
  const form = upload(new Blob([Uint8Array.from(png).buffer as ArrayBuffer], { type: "image/png" }), "fault.png", { observationId: observation.id });
  const stored = await as<{ photo: { id: string } }>(fx.storekeeper.email, "/api/place-photos", { method: "POST", body: form });
  assert.equal(stored.status, 201, stored.text);

  const history = await as<{ receipt: { observations: Array<{ id: string; photos: Array<{ id: string }> }> } }>(fx.owner.email, "/api/place-receipts/" + receipt.id);
  assert.equal(history.status, 200, history.text);
  const evidence = history.body.receipt.observations.find((item) => item.id === observation.id)?.photos;
  assert.deepEqual(evidence?.map((photo) => photo.id), [stored.body.photo.id]);
  const fetched = await as(fx.owner.email, "/api/place-photos/" + stored.body.photo.id);
  assert.equal(fetched.status, 200, fetched.text);
  assert.equal(fetched.headers.get("content-type"), "image/webp");
});

