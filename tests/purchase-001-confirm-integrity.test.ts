import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem, COUNT_PASSWORD } from "./helpers/count";
import { as, login, requireServer } from "./helpers/http";

after(async () => { await db.$disconnect(); });

test("concurrent purchase confirmations add stock once", { timeout: 20000 }, async () => {
  await requireServer();
  const fx = await countCafe("PURCHASE001");
  let release!: () => void;
  let blocker: Promise<unknown> | undefined;
  let requests: Promise<unknown> | undefined;
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const item = await countItem(fx, "beans", { stock: 10 });
    const draft = await as<{ id: string }>(fx.owner.email, "/api/purchases", {
      method: "POST", body: JSON.stringify({ branchId: fx.branchId, invoiceNumber: fx.marker, items: [{ inventoryItemId: item.id, quantity: 2, unitCost: 100 }] }),
    });
    assert.equal(draft.status, 201, draft.text);
    let locked!: () => void;
    const entered = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${item.id} FOR UPDATE`;
      locked(); await gate;
    }, { timeout: 15000 });
    await entered;
    const results = Promise.all([1, 2].map(() => as(fx.owner.email, `/api/purchases/${draft.body.id}/confirm`, { method: "POST", body: "{}" })));
    requests = results;
    let waiting = false;
    for (let n = 0; n < 150; n++) {
      const [state] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%InventoryItem%' OR query LIKE '%PurchaseInvoice%')`;
      if (state.count >= 2) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    release(); await blocker;
    const responses = await results;
    assert.ok(waiting, "both requests reached the protected mutation boundary");
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock), 12, "duplicate confirmation must not add twice");
    assert.equal(await db.inventoryTransaction.count({ where: { inventoryItemId: item.id, type: "PURCHASE" } }), 1);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
    assert.equal((await as(fx.owner.email, `/api/purchases/${draft.body.id}/confirm`, { method: "POST", body: "{}" })).status, 400);
  } finally {
    release?.(); await blocker; await requests;
    await teardownTaggedCafe(fx.cafeId);
  }
});

test("purchase line failure rolls back confirmation and stock then retries safely", async () => {
  const fx = await countCafe("PURCHASE001ROLLBACK");
  const fn = "ph1_purchase001_fail", trigger = fn + "_trg";
  try {
    await login(fx.owner.email, COUNT_PASSWORD);
    const first = await countItem(fx, "first", { stock: 10 }), second = await countItem(fx, "second", { stock: 20 });
    const draft = await as<{ id: string }>(fx.owner.email, "/api/purchases", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, items: [first, second].map(i => ({ inventoryItemId: i.id, quantity: 0.018, unitCost: 100 })) }) });
    assert.equal(draft.status, 201, draft.text);
    await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger AS $f$ BEGIN IF NEW."inventoryItemId" = '${second.id}' THEN RAISE EXCEPTION 'owned purchase line failure'; END IF; RETURN NEW; END; $f$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON "InventoryTransaction" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const failed = await as(fx.owner.email, `/api/purchases/${draft.body.id}/confirm`, { method: "POST", body: "{}" });
    assert.ok(failed.status >= 400);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: first.id } })).currentStock), 10);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: second.id } })).currentStock), 20);
    assert.equal(await db.inventoryTransaction.count({ where: { cafeId: fx.cafeId } }), 0);
    const invoice = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: draft.body.id } });
    assert.equal(invoice.status, "DRAFT"); assert.equal(invoice.confirmedAt, null);
    await db.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "InventoryTransaction"`);
    const retry = await as(fx.owner.email, `/api/purchases/${draft.body.id}/confirm`, { method: "POST", body: "{}" });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: first.id } })).currentStock), 10.018);
    assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: second.id } })).currentStock), 20.018);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON "InventoryTransaction"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    await teardownTaggedCafe(fx.cafeId);
  }
});
