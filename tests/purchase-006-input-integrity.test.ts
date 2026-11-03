import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db } from "./helpers/db";
import { countCafe, countItem, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";
import { purchaseLineFromForm, purchaseSubtotal } from "@/lib/purchase-arithmetic";

let fx: CountCafe;
before(async () => { await requireServer(); fx = await countCafe("ACC01B-PURCHASE006"); });
// ACC-01B keeps the café and its invoices as evidence; the run journals it instead of purging.
after(async () => {
  const dir = process.env.ACC01B_EVIDENCE_DIR;
  if (dir && fx) fs.appendFileSync(path.join(dir, "retained-fixtures.jsonl"), JSON.stringify({ at: new Date().toISOString(), suite: "purchase-006", marker: fx.marker, cafeId: fx.cafeId }) + "\n");
  await db.$disconnect();
});
const create = (body: Record<string, unknown>) => as<{ id: string; error?: string }>(fx.owner.email, "/api/purchases", { method: "POST", body: JSON.stringify({ branchId: fx.branchId, ...body }) });
const patch = (id: string, body: Record<string, unknown>) => as(fx.owner.email, "/api/purchases/" + id, { method: "PATCH", body: JSON.stringify(body) });
const confirm = (id: string) => as(fx.owner.email, "/api/purchases/" + id + "/confirm", { method: "POST", body: "{}" });
const lines = (itemId: string, quantity = 1, unitCost = 1) => [{ inventoryItemId: itemId, quantity, unitCost }];
async function invoice(id: string) {
  return db.purchaseInvoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { id: "asc" } }, payments: true } });
}
async function state(id: string, itemIds: string[]) {
  return {
    invoice: await invoice(id),
    items: await db.inventoryItem.findMany({ where: { id: { in: itemIds } }, orderBy: { id: "asc" } }),
    ledger: await db.inventoryTransaction.findMany({ where: { inventoryItemId: { in: itemIds } }, orderBy: { id: "asc" } }),
    audits: await db.auditLog.findMany({ where: { cafeId: fx.cafeId }, orderBy: { id: "asc" } }),
  };
}
async function counts() {
  return Promise.all([db.purchaseInvoice.count({ where: { cafeId: fx.cafeId } }), db.purchaseInvoiceItem.count({ where: { cafeId: fx.cafeId } }), db.purchasePayment.count({ where: { cafeId: fx.cafeId } }), db.auditLog.count({ where: { cafeId: fx.cafeId } })]);
}
function bad(status: number, body: unknown) {
  assert.equal(status, 400, JSON.stringify(body));
  assert.match(String((body as { error?: string }).error), /[\u0600-\u06ff]/, "clear Arabic validation");
}

test("saved line sums match normalized previews and initial charge/payment stages", async () => {
  const item = await countItem(fx, "preview", { stock: 0 });
  const r = await create({ items: [...lines(item.id, 0.5, 2.01), ...lines(item.id, 1.2345, 10), ...lines(item.id, 0.5, 2.01)], discountAmount: 0.005, taxAmount: 0.004, payment: { amount: 0.005, method: "BANK_TRANSFER", fundingSource: "BANK" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const saved = await invoice(r.body.id);
  assert.deepEqual(saved.items.map(i => Number(i.totalCost)).sort((a,b) => a-b), [1.01, 1.01, 12.35]);
  assert.deepEqual(saved.items.map(i => Number(i.quantity)).sort((a,b) => a-b), [0.5, 0.5, 1.235]);
  assert.equal(Number(saved.subtotalAmount), 14.37);
  assert.equal(Number(saved.discountAmount), 0.01); assert.equal(Number(saved.taxAmount), 0);
  assert.equal(Number(saved.totalAmount), 14.36); assert.equal(Number(saved.paidAmount), 0.01);
  assert.equal(Number(saved.remainingAmount), 14.35); assert.equal(Number(saved.payments[0].amount), 0.01);
  const preview = purchaseSubtotal([purchaseLineFromForm("0.5", "2.01"), purchaseLineFromForm("1.2345", "10"), purchaseLineFromForm("0.5", "2.01")]);
  assert.equal(preview, 14.37); assert.equal(preview, Number(saved.subtotalAmount));
  assert.equal((await confirm(r.body.id)).status, 200);
  const movements = await db.inventoryTransaction.findMany({ where: { inventoryItemId: item.id }, orderBy: { itemVersion: "asc" } });
  assert.deepEqual(movements.map(i => Number(i.totalCost)).sort((a,b) => a-b), [1.01, 1.01, 12.35]);
  assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock), 2.235);
});

test("create rejects invalid costs, normalized-zero quantities and overflow without any writes", async () => {
  const item = await countItem(fx, "refused", { stock: 0 });
  const before = await counts();
  const invalid: Record<string, unknown>[] = [
    ...[0.004, 2.001, -1, 10000000000, "2.01", "", null].map(unitCost => ({ items: [{ inventoryItemId: item.id, quantity: 1, unitCost }] })),
    ...[0.0004, 0, -1, 1000000000, 999999999.9995].map(quantity => ({ items: lines(item.id, quantity) })),
    { items: lines(item.id, 2, 9999999999.99) },
    { items: [...lines(item.id, 1, 9999999999.99), ...lines(item.id, 1, 0.01)] },
    { items: lines(item.id, 1, 9999999999.99), taxAmount: 0.01 },
    { items: lines(item.id), discountAmount: 10000000000 },
    { items: lines(item.id), payment: { amount: 10000000000, method: "BANK_TRANSFER" } },
  ];
  for (const body of invalid) { const r=await create(body); bad(r.status,r.body); assert.deepEqual(await counts(),before); }
  for (const field of ["quantity", "unitCost"]) {
    const body = '{"branchId":"'+fx.branchId+'","items":[{"inventoryItemId":"'+item.id+'","quantity":1,"unitCost":1}]}';
    const raw = body.replace('"'+field+'":1', '"'+field+'":1e999');
    const r=await as(fx.owner.email,"/api/purchases",{method:"POST",body:raw}); bad(r.status,r.body); assert.deepEqual(await counts(),before);
  }
});

test("explicit zero persists, minimum quantity is normalized and initial payment still clamps", async () => {
  const item=await countItem(fx,"zero",{stock:0});
  const free=await create({items:lines(item.id,0.0005,0)}); assert.equal(free.status,201);
  const saved=await invoice(free.body.id); assert.equal(Number(saved.items[0].quantity),0.001); assert.equal(Number(saved.items[0].unitCost),0); assert.equal(Number(saved.totalAmount),0);
  const paid=await create({items:lines(item.id,0.5,2.01),payment:{amount:99.999,method:"BANK_TRANSFER",fundingSource:"BANK"}}); assert.equal(paid.status,201);
  const paidInvoice=await invoice(paid.body.id); assert.equal(Number(paidInvoice.paidAmount),1.01); assert.equal(Number(paidInvoice.remainingAmount),0); assert.equal(paidInvoice.paymentStatus,"PAID");
});

test("PATCH uses the same stages, preserves existing paid balance and atomically refuses invalid replacements", async () => {
  const item=await countItem(fx,"patch",{stock:0});
  const r=await create({items:lines(item.id,1,2),payment:{amount:2,method:"BANK_TRANSFER",fundingSource:"BANK"}}); assert.equal(r.status,201);
  const edited=await patch(r.body.id,{items:[...lines(item.id,0.5,2.01),...lines(item.id,0.5,2.01)],discountAmount:0.005,taxAmount:0.004}); assert.equal(edited.status,200);
  let saved=await invoice(r.body.id); assert.equal(Number(saved.subtotalAmount),2.02); assert.equal(Number(saved.totalAmount),2.01); assert.equal(Number(saved.remainingAmount),0.01); assert.equal(saved.paymentStatus,"PARTIAL");
  const charges=await patch(r.body.id,{discountAmount:1.005}); assert.equal(charges.status,200);
  saved=await invoice(r.body.id); assert.equal(Number(saved.discountAmount),1.01); assert.equal(Number(saved.totalAmount),1.01); assert.equal(Number(saved.paidAmount),2); assert.equal(Number(saved.remainingAmount),0); assert.equal(saved.paymentStatus,"PAID");
  const prior=await state(r.body.id,[item.id]);
  for(const replacement of [
    {items:[...lines(item.id,1,1),...lines(item.id,1,0.004)]},
    {items:lines(item.id,0.0004,1)},
    {items:lines(item.id,2,9999999999.99)},
    {taxAmount:10000000000},
    {discountAmount:10000000000},
  ]) { const refused=await patch(r.body.id,replacement); bad(refused.status,refused.body); assert.deepEqual(await state(r.body.id,[item.id]),prior); }
});

test("confirmation rejects later weighted-average overflow and rolls back every earlier effect", async () => {
  const first=await countItem(fx,"overflow first",{stock:1,costPerUnit:1});
  const second=await countItem(fx,"overflow second",{stock:-0.999,costPerUnit:9999999999.99});
  const r=await create({items:[...lines(first.id,1,1),...lines(second.id,1,0)]}); assert.equal(r.status,201);
  const prior=await state(r.body.id,[first.id,second.id]);
  const refused=await confirm(r.body.id); bad(refused.status,refused.body); assert.deepEqual(await state(r.body.id,[first.id,second.id]),prior);
});

test("confirmation refuses stock-column overflow as 400 with no partial writes", async () => {
  const item=await countItem(fx,"stock overflow",{stock:999999999.999,costPerUnit:0});
  const r=await create({items:lines(item.id,0.001,0)}); assert.equal(r.status,201);
  const prior=await state(r.body.id,[item.id]); const refused=await confirm(r.body.id); bad(refused.status,refused.body); assert.deepEqual(await state(r.body.id,[item.id]),prior);
});

test("confirmation uses invoice lines committed before it acquires the invoice lock", {timeout:20000}, async () => {
  const item=await countItem(fx,"locked edit",{stock:0,costPerUnit:1});
  const r=await create({items:lines(item.id,1,1)}); assert.equal(r.status,201);
  let entered!:()=>void, release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;}); const gate=new Promise<void>(resolve=>{release=resolve;});
  const blocker=db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "PurchaseInvoice" WHERE id = ${r.body.id} FOR UPDATE`;
    entered(); await gate;
    await tx.purchaseInvoiceItem.updateMany({where:{purchaseInvoiceId:r.body.id},data:{quantity:0.5,unitCost:2.01,totalCost:1.01}});
    await tx.purchaseInvoice.update({where:{id:r.body.id},data:{subtotalAmount:1.01,totalAmount:1.01,remainingAmount:1.01}});
  },{timeout:15000});
  await ready;
  const pending=confirm(r.body.id);
  try {
    let waiting=false;
    for(let n=0;n<100;n++) {
      const [s]=await db.$queryRaw<{count:number}[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%PurchaseInvoice%'`;
      if(s.count>0){waiting=true;break;} await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(waiting,"confirmation reached the invoice lock");
  } finally {release();await blocker;}
  const confirmed=await pending; assert.equal(confirmed.status,200);
  const saved=await db.inventoryItem.findUniqueOrThrow({where:{id:item.id}}); assert.equal(Number(saved.currentStock),0.5); assert.equal(Number(saved.costPerUnit),2.01);
  const movement=await db.inventoryTransaction.findFirstOrThrow({where:{inventoryItemId:item.id}}); assert.equal(Number(movement.quantity),0.5); assert.equal(Number(movement.totalCost),1.01);
});

test("purchase page renders with the shared browser-safe arithmetic module", async () => {
  const page = await as(fx.owner.email, "/purchases");
  assert.equal(page.status, 200, page.text.slice(0, 300));
  assert.ok(page.text.includes("فواتير المشتريات"), "purchase page rendered for the owned account");
});
