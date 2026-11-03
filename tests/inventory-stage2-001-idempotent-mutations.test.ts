import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { InventoryUnit, Prisma } from "@prisma/client";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

// Stock transfers and manual movements get the guarantees POS collections
// already have. A retried request must move stock once, a lost response must
// be recoverable with the same key, and the ledger rows, the audit row and the
// stored success response must commit together or not at all. Every case is
// asserted on persisted balances, ledger rows and audit rows, through the real
// routes on the isolated test server.

const TRANSFER = "/api/inventory/transfer";
const movement = (id: string) => `/api/inventory/${id}/movement`;
const STOCK_AUDITS = [
  "INVENTORY_TRANSFERRED", "INVENTORY_STOCK_ADDED", "INVENTORY_STOCK_USED",
  "INVENTORY_WASTE_RECORDED", "INVENTORY_ADJUSTED",
];

let fx: CountCafe;
let other: CountCafe;
let thirdBranchId: string;
let handovers = 0;

before(async () => {
  await requireServer();
  fx = await countCafe("INVSTAGE2");
  other = await countCafe("INVSTAGE2OTHER");
  thirdBranchId = (await db.branch.create({ data: { cafeId: fx.cafeId, name: `${fx.marker} third` } })).id;
  // Compile both routes with requests every version rejects at validation,
  // so `next dev` compilation cannot eat into a lock timeout below.
  assert.equal((await post(fx.owner.email, TRANSFER, { inventoryItemId: "x", toBranchId: "y", quantity: 0 })).status, 400);
  assert.equal((await post(fx.owner.email, movement("x"), { type: "WASTE", quantity: "x" })).status, 400);
});

after(async () => {
  const cafes = [fx?.cafeId, other?.cafeId].filter((id): id is string => !!id);
  await teardownTaggedCafe(cafes, cafes.map((cafeId) => () =>
    // Idempotency receipts carry the café only inside their scope string.
    db.idempotencyKey.deleteMany({ where: { scope: { startsWith: `${cafeId}:` } } })
  ), { disconnect: true });
});

function post(email: string, path: string, body: unknown, key: string | null = randomUUID()) {
  return as<Record<string, unknown>>(email, path, {
    method: "POST",
    headers: key === null ? {} : { "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

const replayed = (r: { headers: Headers }) => r.headers.get("Idempotency-Replayed") === "true";

async function stockOf(id: string) {
  return Number((await db.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock);
}

async function ledger(itemIds: string[]) {
  const rows = await db.inventoryTransaction.findMany({
    where: { inventoryItemId: { in: itemIds } }, orderBy: { itemVersion: "asc" },
  });
  const audits = await db.auditLog.findMany({
    where: { entityId: { in: itemIds }, action: { in: STOCK_AUDITS } }, orderBy: { createdAt: "asc" },
  });
  return { rows, audits };
}

function destinations(source: { name: string; unit: InventoryUnit }, branchId = fx.otherBranchId) {
  return db.inventoryItem.findMany({ where: { cafeId: fx.cafeId, branchId, name: source.name, unit: source.unit } });
}

async function receipt(key: string) {
  return db.idempotencyKey.findMany({ where: { key } });
}

// Holds rows so every request reaches its write boundary before any of them
// may proceed — the window a plain read-then-write cannot close.
async function hold(lock: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let locked!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { locked = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = db.$transaction(async (tx) => { await lock(tx); locked(); await gate; }, { timeout: 15_000 });
  await entered;
  return { release, blocker };
}

const holdItems = (ids: string[]) => hold((tx) =>
  tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`);

async function lockWaiters(count: number) {
  for (let n = 0; n < 100; n++) {
    const [state] = await db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
    if (state.count >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// Lets an in-flight duplicate answer while the first request still waits on
// the held row, without outliving the protected transaction's lock timeout.
async function settleOne(requests: Promise<unknown>[], ms = 700) {
  await Promise.race([...requests, new Promise((resolve) => setTimeout(resolve, ms))]);
}

async function handover(branchId: string) {
  handovers += 1;
  const shift = await db.shift.create({
    data: {
      cafeId: fx.cafeId, branchId, cashierId: fx.owner.id, shiftNumber: 930000 + handovers,
      status: "CLOSED", closedAt: new Date(), openingCashAmount: 0, expectedCashAmount: 0,
    },
  });
  return (await db.handoverSession.create({
    data: {
      cafeId: fx.cafeId, branchId, outgoingShiftId: shift.id, outgoingUserId: fx.owner.id,
      status: "COMPLETED", completedAt: new Date(),
    },
  })).id;
}

async function frozen<T>(branchId: string, run: () => Promise<T>) {
  const { acquireInventoryFreeze, releaseInventoryFreeze } = await import("@/lib/inventory-freeze");
  const handoverId = await handover(branchId);
  await db.$transaction((tx) => acquireInventoryFreeze(tx, { cafeId: fx.cafeId, branchId, handoverId, startedById: fx.owner.id }));
  try { return await run(); } finally {
    await db.$transaction((tx) => releaseInventoryFreeze(tx, { handoverId, actorId: fx.owner.id }));
  }
}

async function failingAudit<T>(action: string, entityId: string, run: () => Promise<T>) {
  const fn = "ph1_invstage2_audit_" + randomUUID().replaceAll("-", ""), trigger = fn + "_trg";
  await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger AS $f$ BEGIN IF NEW."entityId" = '${entityId}' AND NEW."action" = '${action}' THEN RAISE EXCEPTION 'owned audit failure'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`);
  try {
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try { return await run(); } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "AuditLog"`); }
  } finally {
    await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
  }
}

// ── transfers ──

test("a transfer without an Idempotency-Key is refused and moves nothing", async () => {
  const source = await countItem(fx, "t-nokey", { stock: 10 });
  const r = await post(fx.owner.email, TRANSFER, { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 4 }, null);
  assert.equal(r.status, 400, r.text);
  assert.equal(await stockOf(source.id), 10);
  assert.equal((await destinations(source)).length, 0);
  assert.deepEqual((await ledger([source.id])).rows, []);
});

test("a replayed transfer returns the stored success once; a new key is a new transfer", async () => {
  const source = await countItem(fx, "t-replay", { stock: 10, costPerUnit: 12.5 });
  const body = { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 4, note: "shelf" };
  const key = randomUUID();
  const first = await post(fx.owner.email, TRANSFER, body, key);
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body, { ok: true });
  const again = await post(fx.owner.email, TRANSFER, body, key);
  assert.equal(again.status, 200, again.text);
  assert.ok(replayed(again), "the second response is the stored one");
  assert.deepEqual(again.body, first.body);

  const [dest] = await destinations(source);
  assert.ok(dest, "the destination item exists");
  assert.equal(await stockOf(source.id), 6);
  assert.equal(await stockOf(dest.id), 4);
  let { rows, audits } = await ledger([source.id, dest.id]);
  assert.deepEqual(rows.map((r) => [r.type, Number(r.quantity), Number(r.unitCost), Number(r.totalCost)]).sort(),
    [["TRANSFER_IN", 4, 12.5, 50], ["TRANSFER_OUT", -4, 12.5, 50]]);
  assert.equal(audits.length, 1, "one transfer, one audit row");
  const details = audits[0].details as Record<string, unknown>;
  assert.equal(details.quantity, 4);
  assert.equal(details.fromBranchId, fx.branchId);
  assert.equal(details.toBranchId, fx.otherBranchId);
  assert.equal(details.sourceStockBefore, 10);
  assert.equal(details.sourceStockAfter, 6);
  assert.equal(details.destinationStockAfter, 4);
  assert.equal((await receipt(key))[0]?.status, "COMPLETED");

  const intentional = await post(fx.owner.email, TRANSFER, body);
  assert.equal(intentional.status, 200, intentional.text);
  assert.ok(!replayed(intentional));
  assert.equal(await stockOf(source.id), 2);
  assert.equal(await stockOf(dest.id), 8);
  ({ rows, audits } = await ledger([source.id, dest.id]));
  assert.equal(rows.length, 4);
  assert.equal(audits.length, 2);
});

test("concurrent same-key transfers move stock once, then replay", { timeout: 30_000 }, async () => {
  const source = await countItem(fx, "t-concurrent", { stock: 10 });
  const body = { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 3 };
  const key = randomUUID();
  const held = await holdItems([source.id]);
  const requests = [1, 2].map(() => post(fx.owner.email, TRANSFER, body, key));
  try {
    assert.ok(await lockWaiters(1), "a transfer reached the source row");
    await settleOne(requests);
  } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  for (const r of responses) assert.ok(r.status === 200 || r.status === 409, r.text);
  assert.equal(responses.filter((r) => r.status === 200 && !replayed(r)).length, 1, responses.map((r) => r.text).join(" | "));
  const replay = await post(fx.owner.email, TRANSFER, body, key);
  assert.equal(replay.status, 200, replay.text);
  assert.ok(replayed(replay));
  const [dest] = await destinations(source);
  assert.equal(await stockOf(source.id), 7);
  assert.equal(await stockOf(dest.id), 3);
  const { rows, audits } = await ledger([source.id, dest.id]);
  assert.equal(rows.length, 2);
  assert.equal(audits.length, 1);
});

test("a changed transfer under the same key is refused with 409 and no further effect", async () => {
  const source = await countItem(fx, "t-changed", { stock: 10 });
  const key = randomUUID();
  const first = await post(fx.owner.email, TRANSFER, { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 2 }, key);
  assert.equal(first.status, 200, first.text);
  const changed = await post(fx.owner.email, TRANSFER, { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 3 }, key);
  assert.equal(changed.status, 409, changed.text);
  const [dest] = await destinations(source);
  assert.equal(await stockOf(source.id), 8);
  assert.equal(await stockOf(dest.id), 2);
  assert.equal((await ledger([source.id, dest.id])).rows.length, 2);
});

test("a transfer that emptied the source still replays its stored success", async () => {
  const source = await countItem(fx, "t-exhausted", { stock: 5 });
  const body = { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 5 };
  const key = randomUUID();
  assert.equal((await post(fx.owner.email, TRANSFER, body, key)).status, 200);
  const replay = await post(fx.owner.email, TRANSFER, body, key);
  assert.equal(replay.status, 200, replay.text);
  assert.ok(replayed(replay), "a lost response is recoverable after the balance it consumed is gone");
  assert.equal(await stockOf(source.id), 0);
  const [dest] = await destinations(source);
  assert.equal((await ledger([source.id, dest.id])).rows.length, 2);
});

test("a stored transfer is not replayed after permission or branch access is revoked", async () => {
  const source = await countItem(fx, "t-revoked", { stock: 10 });
  const body = { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 1 };
  const key = randomUUID();
  assert.equal((await post(fx.manager.email, TRANSFER, body, key)).status, 200);
  const override = await db.userPermissionOverride.create({
    data: { userId: fx.manager.id, permissionKey: "inventory.transactions", allowed: false },
  });
  try {
    const denied = await post(fx.manager.email, TRANSFER, body, key);
    assert.equal(denied.status, 403, denied.text);
    assert.ok(!replayed(denied));
    assert.deepEqual(Object.keys(denied.body), ["error"]);
  } finally { await db.userPermissionOverride.delete({ where: { id: override.id } }); }
  await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.otherBranchId } });
  try {
    const moved = await post(fx.manager.email, TRANSFER, body, key);
    assert.equal(moved.status, 403, moved.text);
    assert.ok(!replayed(moved));
  } finally { await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.branchId } }); }
  const restored = await post(fx.manager.email, TRANSFER, body, key);
  assert.equal(restored.status, 200, restored.text);
  assert.ok(replayed(restored), "restored access replays the one stored transfer");
  const [dest] = await destinations(source);
  assert.equal(await stockOf(source.id), 9);
  assert.equal((await ledger([source.id, dest.id])).rows.length, 2);
});

test("transfers stay inside the actor's café and source branch", async () => {
  const source = await countItem(fx, "t-scope", { stock: 10 });
  const annex = await countItem(fx, "t-scope-annex", { stock: 10, branchId: fx.otherBranchId });
  const foreignCafe = await post(other.owner.email, TRANSFER, { inventoryItemId: source.id, toBranchId: other.otherBranchId, quantity: 1 });
  assert.equal(foreignCafe.status, 404, foreignCafe.text);
  const foreignSource = await post(fx.manager.email, TRANSFER, { inventoryItemId: annex.id, toBranchId: fx.branchId, quantity: 1 });
  assert.equal(foreignSource.status, 403, foreignSource.text);
  const foreignDestination = await post(fx.owner.email, TRANSFER, { inventoryItemId: source.id, toBranchId: other.branchId, quantity: 1 });
  assert.equal(foreignDestination.status, 400, foreignDestination.text);
  const sameBranch = await post(fx.owner.email, TRANSFER, { inventoryItemId: source.id, toBranchId: fx.branchId, quantity: 1 });
  assert.equal(sameBranch.status, 400, sameBranch.text);
  assert.equal(await stockOf(source.id), 10);
  assert.equal(await stockOf(annex.id), 10);
  assert.deepEqual((await ledger([source.id, annex.id])).rows, []);
  assert.equal(await db.inventoryItem.count({ where: { cafeId: other.cafeId, name: source.name } }), 0);
});

test("a frozen source or destination refuses the whole transfer; the same key succeeds after release", { timeout: 30_000 }, async () => {
  for (const side of ["source", "destination"] as const) {
    const source = await countItem(fx, `t-frozen-${side}`, { stock: 10 });
    const body = { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 2 };
    const key = randomUUID();
    const refused = await frozen(side === "source" ? fx.branchId : fx.otherBranchId, () => post(fx.owner.email, TRANSFER, body, key));
    assert.equal(refused.status, 409, `${side}: ${refused.text}`);
    assert.equal(await stockOf(source.id), 10);
    assert.equal((await destinations(source)).length, 0, `${side}: no destination half survives`);
    assert.deepEqual((await ledger([source.id])).rows, []);
    const retry = await post(fx.owner.email, TRANSFER, body, key);
    assert.equal(retry.status, 200, `${side}: ${retry.text}`);
    assert.ok(!replayed(retry), "the refused attempt stored no success");
    assert.equal(await stockOf(source.id), 8);
    const dest = await destinations(source);
    assert.equal(dest.length, 1);
    assert.equal((await ledger([source.id, dest[0].id])).rows.length, 2);
  }
});

test("competing transfers cannot overspend the source", { timeout: 30_000 }, async () => {
  const source = await countItem(fx, "t-overspend", { stock: 10 });
  const body = { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 7 };
  const held = await holdItems([source.id]);
  const requests = [1, 2].map(() => post(fx.owner.email, TRANSFER, body));
  try {
    assert.ok(await lockWaiters(2), "both transfers reached the source row");
  } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400], responses.map((r) => r.text).join(" | "));
  const [dest] = await destinations(source);
  assert.equal(await stockOf(source.id), 3);
  assert.equal(await stockOf(dest.id), 7);
  const { rows, audits } = await ledger([source.id, dest.id]);
  assert.equal(rows.length, 2);
  assert.equal(audits.length, 1);
});

test("opposite-direction transfers lock both rows in one order and both settle", { timeout: 30_000 }, async () => {
  const main = await countItem(fx, "t-opposite", { stock: 20 });
  const annex = await db.inventoryItem.create({
    data: { cafeId: fx.cafeId, branchId: fx.otherBranchId, name: main.name, unit: main.unit, costPerUnit: 450, currentStock: "20" },
  });
  const held = await holdItems([main.id, annex.id]);
  const requests = [
    post(fx.owner.email, TRANSFER, { inventoryItemId: main.id, toBranchId: fx.otherBranchId, quantity: 2 }),
    post(fx.owner.email, TRANSFER, { inventoryItemId: annex.id, toBranchId: fx.branchId, quantity: 3 }),
  ];
  try {
    assert.ok(await lockWaiters(2), "both transfers reached their first row");
  } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((r) => r.status), [200, 200], responses.map((r) => r.text).join(" | "));
  assert.equal(await stockOf(main.id), 21);
  assert.equal(await stockOf(annex.id), 19);
  const { rows, audits } = await ledger([main.id, annex.id]);
  assert.equal(rows.length, 4);
  assert.equal(audits.length, 2);
});

test("first transfers from two branches create one destination item", { timeout: 30_000 }, async () => {
  const name = `${fx.marker} t-first-dest-${randomUUID().slice(0, 6)}`;
  const fromMain = await db.inventoryItem.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, name, unit: "KG", costPerUnit: 450, currentStock: "10" } });
  const fromThird = await db.inventoryItem.create({ data: { cafeId: fx.cafeId, branchId: thirdBranchId, name, unit: "KG", costPerUnit: 450, currentStock: "10" } });
  // Holding the destination branch row blocks every way an item can be
  // created there, so both requests have looked for the destination first.
  const held = await hold((tx) => tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${fx.otherBranchId} FOR UPDATE`);
  const requests = [
    post(fx.owner.email, TRANSFER, { inventoryItemId: fromMain.id, toBranchId: fx.otherBranchId, quantity: 1 }),
    post(fx.owner.email, TRANSFER, { inventoryItemId: fromThird.id, toBranchId: fx.otherBranchId, quantity: 2 }),
  ];
  try {
    assert.ok(await lockWaiters(2), "both transfers reached the destination branch");
  } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((r) => r.status), [200, 200], responses.map((r) => r.text).join(" | "));
  const dest = await destinations(fromMain);
  assert.equal(dest.length, 1, "one destination item, not two");
  assert.equal(Number(dest[0].currentStock), 3);
  assert.equal((await ledger([dest[0].id])).rows.length, 2);
});

test("a failed transfer audit rolls back both halves and a new destination; the same key then succeeds", { timeout: 30_000 }, async () => {
  const source = await countItem(fx, "t-audit", { stock: 10 });
  const body = { inventoryItemId: source.id, toBranchId: fx.otherBranchId, quantity: 4 };
  const key = randomUUID();
  const failed = await failingAudit("INVENTORY_TRANSFERRED", source.id, () => post(fx.owner.email, TRANSFER, body, key));
  assert.ok(failed.status >= 400, failed.text);
  assert.equal(await stockOf(source.id), 10);
  assert.equal((await destinations(source)).length, 0, "the destination created for this transfer rolled back too");
  assert.deepEqual((await ledger([source.id])).rows, []);
  assert.notEqual((await receipt(key))[0]?.status, "COMPLETED");
  const retry = await post(fx.owner.email, TRANSFER, body, key);
  assert.equal(retry.status, 200, retry.text);
  assert.ok(!replayed(retry));
  const [dest] = await destinations(source);
  assert.equal(await stockOf(source.id), 6);
  assert.equal(await stockOf(dest.id), 4);
  const { rows, audits } = await ledger([source.id, dest.id]);
  assert.equal(rows.length, 2);
  assert.equal(audits.length, 1);
});

// ── manual movements ──

test("a manual movement without an Idempotency-Key is refused and moves nothing", async () => {
  const item = await countItem(fx, "m-nokey", { stock: 10 });
  const r = await post(fx.owner.email, movement(item.id), { type: "WASTE", quantity: 1 }, null);
  assert.equal(r.status, 400, r.text);
  assert.equal(await stockOf(item.id), 10);
  assert.deepEqual((await ledger([item.id])).rows, []);
});

test("a replayed purchase movement applies once and keeps its valuation and last price", async () => {
  const item = await countItem(fx, "m-replay", { stock: 2, costPerUnit: 10 });
  const body = { type: "PURCHASE", quantity: 3, unitCost: 12, note: "delivery" };
  const key = randomUUID();
  const first = await post(fx.owner.email, movement(item.id), body, key);
  assert.equal(first.status, 200, first.text);
  const again = await post(fx.owner.email, movement(item.id), body, key);
  assert.equal(again.status, 200, again.text);
  assert.ok(replayed(again));
  assert.deepEqual(again.body, first.body);
  assert.equal(Number((first.body.item as { currentStock: unknown }).currentStock), 5);
  const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(Number(after.currentStock), 5);
  assert.equal(Number(after.costPerUnit), 12, "a manual purchase still refreshes the reference cost");
  let { rows, audits } = await ledger([item.id]);
  assert.deepEqual(rows.map((r) => [r.type, Number(r.quantity), Number(r.unitCost), Number(r.totalCost)]), [["PURCHASE", 3, 12, 36]]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "INVENTORY_STOCK_ADDED");
  assert.deepEqual(
    [(audits[0].details as Record<string, unknown>).oldStock, (audits[0].details as Record<string, unknown>).newStock],
    [2, 5],
  );
  const intentional = await post(fx.owner.email, movement(item.id), body);
  assert.equal(intentional.status, 200, intentional.text);
  assert.equal(await stockOf(item.id), 8);
  ({ rows, audits } = await ledger([item.id]));
  assert.equal(rows.length, 2);
  assert.equal(audits.length, 2);
});

test("concurrent same-key movements apply once, then replay", { timeout: 30_000 }, async () => {
  const item = await countItem(fx, "m-concurrent", { stock: 10 });
  const body = { type: "WASTE", quantity: 2 };
  const key = randomUUID();
  const held = await holdItems([item.id]);
  const requests = [1, 2].map(() => post(fx.owner.email, movement(item.id), body, key));
  try {
    assert.ok(await lockWaiters(1), "a movement reached the item row");
    await settleOne(requests);
  } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  for (const r of responses) assert.ok(r.status === 200 || r.status === 409, r.text);
  assert.equal(responses.filter((r) => r.status === 200 && !replayed(r)).length, 1, responses.map((r) => r.text).join(" | "));
  const replay = await post(fx.owner.email, movement(item.id), body, key);
  assert.equal(replay.status, 200, replay.text);
  assert.ok(replayed(replay));
  assert.equal(await stockOf(item.id), 8);
  const { rows, audits } = await ledger([item.id]);
  assert.equal(rows.length, 1);
  assert.equal(audits.length, 1);
});

test("a changed movement under the same key is refused with 409 and no further effect", async () => {
  const item = await countItem(fx, "m-changed", { stock: 10 });
  const key = randomUUID();
  assert.equal((await post(fx.owner.email, movement(item.id), { type: "WASTE", quantity: 1 }, key)).status, 200);
  const changed = await post(fx.owner.email, movement(item.id), { type: "WASTE", quantity: 2 }, key);
  assert.equal(changed.status, 409, changed.text);
  assert.equal(await stockOf(item.id), 9);
  assert.equal((await ledger([item.id])).rows.length, 1);
});

test("a movement that emptied the item still replays its stored success", async () => {
  const item = await countItem(fx, "m-exhausted", { stock: 5 });
  const body = { type: "USAGE", quantity: 5 };
  const key = randomUUID();
  const first = await post(fx.owner.email, movement(item.id), body, key);
  assert.equal(first.status, 200, first.text);
  const replay = await post(fx.owner.email, movement(item.id), body, key);
  assert.equal(replay.status, 200, replay.text);
  assert.ok(replayed(replay));
  assert.deepEqual(replay.body, first.body);
  assert.equal(await stockOf(item.id), 0);
  assert.equal((await ledger([item.id])).rows.length, 1);
});

test("a stored movement is not replayed after permission or branch access is revoked", async () => {
  const item = await countItem(fx, "m-revoked", { stock: 10 });
  const body = { type: "ADJUSTMENT", quantity: -1 };
  const key = randomUUID();
  assert.equal((await post(fx.manager.email, movement(item.id), body, key)).status, 200);
  const override = await db.userPermissionOverride.create({
    data: { userId: fx.manager.id, permissionKey: "inventory.transactions", allowed: false },
  });
  try {
    const denied = await post(fx.manager.email, movement(item.id), body, key);
    assert.equal(denied.status, 403, denied.text);
    assert.deepEqual(Object.keys(denied.body), ["error"], "no stored item is disclosed");
  } finally { await db.userPermissionOverride.delete({ where: { id: override.id } }); }
  await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.otherBranchId } });
  try {
    const moved = await post(fx.manager.email, movement(item.id), body, key);
    assert.equal(moved.status, 403, moved.text);
    assert.deepEqual(Object.keys(moved.body), ["error"]);
  } finally { await db.user.update({ where: { id: fx.manager.id }, data: { branchId: fx.branchId } }); }
  const restored = await post(fx.manager.email, movement(item.id), body, key);
  assert.equal(restored.status, 200, restored.text);
  assert.ok(replayed(restored));
  assert.equal(await stockOf(item.id), 9);
  assert.equal((await ledger([item.id])).rows.length, 1);
});

test("movements stay inside the actor's café and branch", async () => {
  const item = await countItem(fx, "m-scope", { stock: 10 });
  const annex = await countItem(fx, "m-scope-annex", { stock: 10, branchId: fx.otherBranchId });
  const foreignCafe = await post(other.owner.email, movement(item.id), { type: "WASTE", quantity: 1 });
  assert.equal(foreignCafe.status, 403, foreignCafe.text);
  const foreignBranch = await post(fx.manager.email, movement(annex.id), { type: "WASTE", quantity: 1 });
  assert.equal(foreignBranch.status, 403, foreignBranch.text);
  assert.equal(await stockOf(item.id), 10);
  assert.equal(await stockOf(annex.id), 10);
  assert.deepEqual((await ledger([item.id, annex.id])).rows, []);
});

test("a frozen branch refuses a movement; the same key succeeds after release", { timeout: 30_000 }, async () => {
  const item = await countItem(fx, "m-frozen", { stock: 10 });
  const body = { type: "WASTE", quantity: 1 };
  const key = randomUUID();
  const refused = await frozen(fx.branchId, () => post(fx.owner.email, movement(item.id), body, key));
  assert.equal(refused.status, 409, refused.text);
  assert.equal(await stockOf(item.id), 10);
  assert.deepEqual((await ledger([item.id])).rows, []);
  const retry = await post(fx.owner.email, movement(item.id), body, key);
  assert.equal(retry.status, 200, retry.text);
  assert.ok(!replayed(retry));
  assert.equal(await stockOf(item.id), 9);
});

test("competing movements cannot take an item below zero", { timeout: 30_000 }, async () => {
  const item = await countItem(fx, "m-overspend", { stock: 10 });
  const held = await holdItems([item.id]);
  const requests = [1, 2].map(() => post(fx.owner.email, movement(item.id), { type: "WASTE", quantity: 7 }));
  try {
    assert.ok(await lockWaiters(2), "both movements reached the item row");
  } finally { held.release(); await held.blocker; }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400], responses.map((r) => r.text).join(" | "));
  assert.equal(await stockOf(item.id), 3);
  const { rows, audits } = await ledger([item.id]);
  assert.equal(rows.length, 1);
  assert.equal(audits.length, 1);
});

test("a failed movement audit rolls the movement back; the same key then succeeds", { timeout: 30_000 }, async () => {
  const item = await countItem(fx, "m-audit", { stock: 10 });
  const body = { type: "WASTE", quantity: 2 };
  const key = randomUUID();
  const failed = await failingAudit("INVENTORY_WASTE_RECORDED", item.id, () => post(fx.owner.email, movement(item.id), body, key));
  assert.ok(failed.status >= 400, failed.text);
  assert.equal(await stockOf(item.id), 10);
  assert.deepEqual((await ledger([item.id])).rows, []);
  assert.notEqual((await receipt(key))[0]?.status, "COMPLETED");
  const retry = await post(fx.owner.email, movement(item.id), body, key);
  assert.equal(retry.status, 200, retry.text);
  assert.equal(await stockOf(item.id), 8);
  const { rows, audits } = await ledger([item.id]);
  assert.equal(rows.length, 1);
  assert.equal(audits.length, 1);
});
