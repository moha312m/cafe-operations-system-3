import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";
import { assertIntegrationDatabase } from "./helpers/integration-guard";

let fx: CountCafe;
before(async () => {
  await assertIntegrationDatabase(db);
  await requireServer();
  fx = await countCafe("REL005");
  await db.cafeSettings.update({ where: { cafeId: fx.cafeId }, data: { inventoryEnabled: true } });
  for (const [userId, canEdit] of [[fx.manager.id, false], [fx.storekeeper.id, true]] as const) {
    for (const [permissionKey, allowed] of [["inventory.view", true], ["inventory.edit", canEdit]] as const) {
      await db.userPermissionOverride.upsert({
        where: { userId_permissionKey: { userId, permissionKey } },
        create: { userId, permissionKey, allowed }, update: { allowed },
      });
    }
  }
});
after(async () => {
  if (fx) await teardownTaggedCafe(fx.cafeId);
  await db.$disconnect();
});

function item(suffix: string) {
  return db.inventoryItem.create({ data: {
    cafeId: fx.cafeId, branchId: fx.branchId, name: fx.marker + suffix,
    unit: "PIECE", currentStock: 10, minimumStock: 2, costPerUnit: 3,
  } });
}

test("inventory viewer with explicit edit denial cannot PATCH item metadata or archive", async () => {
  const saved = await item(" denied patch");
  const response = await as(fx.manager.email, `/api/inventory/${saved.id}`, {
    method: "PATCH", body: JSON.stringify({ name: "unauthorized", costPerUnit: 1, archived: true }),
  });
  assert.equal(response.status, 403, response.text);
  assert.deepEqual(await db.inventoryItem.findUniqueOrThrow({ where: { id: saved.id } }), saved);
});

test("inventory viewer with explicit edit denial cannot DELETE archive an item", async () => {
  const saved = await item(" denied delete");
  const response = await as(fx.manager.email, `/api/inventory/${saved.id}`, { method: "DELETE" });
  assert.equal(response.status, 403, response.text);
  assert.deepEqual(await db.inventoryItem.findUniqueOrThrow({ where: { id: saved.id } }), saved);
});

test("explicit inventory editor can PATCH metadata and DELETE archive without changing stock", async () => {
  const saved = await item(" authorized");
  const changed = await as(fx.storekeeper.email, `/api/inventory/${saved.id}`, {
    method: "PATCH", body: JSON.stringify({ name: fx.marker + " edited", minimumStock: 4 }),
  });
  assert.equal(changed.status, 200, changed.text);
  const patched = await db.inventoryItem.findUniqueOrThrow({ where: { id: saved.id } });
  assert.equal(patched.name, fx.marker + " edited");
  assert.equal(Number(patched.minimumStock), 4);
  assert.equal(Number(patched.currentStock), 10);
  assert.equal(Number(patched.costPerUnit), 3);
  const archived = await as(fx.storekeeper.email, `/api/inventory/${saved.id}`, { method: "DELETE" });
  assert.equal(archived.status, 200, archived.text);
  const final = await db.inventoryItem.findUniqueOrThrow({ where: { id: saved.id } });
  assert.ok(final.archivedAt);
  assert.equal(final.isActive, false);
  assert.equal(Number(final.currentStock), 10);
});