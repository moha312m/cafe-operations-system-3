// RELEASE-007: staged recipe additions must not become unaccepted finished
// goods after catalog drift. The feature gate remains false throughout.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { stageAmendment, commitAmendment, cancelAmendment, beginAmendmentSettlement, observeAmendmentSettlement, type AmendmentInput } from "../src/lib/order-amendments";
import { planOrderConsumption } from "../src/lib/sale-consumption";
import type { SessionUser } from "../src/lib/auth";
import { assertIntegrationDatabase } from "./helpers/integration-guard";

test.before(async () => { await assertIntegrationDatabase(db); });
test.after(() => db.$disconnect());

async function fixture() {
  const marker = "REL007-" + randomUUID();
  const cafe = await db.cafe.create({ data: { name: marker, slug: marker.toLowerCase() } });
  const branch = await db.branch.create({ data: { cafeId: cafe.id, name: marker + " branch" } });
  const owner = await db.user.create({ data: { cafeId: cafe.id, branchId: branch.id, email: marker.toLowerCase() + "@example.invalid", name: marker + " owner", passwordHash: "NO_LOGIN", role: "CAFE_OWNER" } });
  const actor = { id: owner.id, cafeId: cafe.id, branchId: branch.id, email: owner.email, name: owner.name, role: "CAFE_OWNER" } as SessionUser;
  await db.cafeSettings.create({ data: { cafeId: cafe.id, inventoryEnforcementMode: "STRICT", inventoryEnabled: true, finishedGoodsSalesEnabled: false } });
  await db.ownerActionSettings.create({ data: { cafeId: cafe.id, ownerId: owner.id } });
  const shift = await db.shift.create({ data: { cafeId: cafe.id, branchId: branch.id, cashierId: owner.id, shiftNumber: 1, openingCashAmount: 0 } });
  const category = await db.menuCategory.create({ data: { cafeId: cafe.id, name: marker } });
  const original = await db.product.create({ data: { cafeId: cafe.id, categoryId: category.id, name: marker + " original", basePrice: 15, stockMode: "RECIPE" } });
  const added = await db.product.create({ data: { cafeId: cafe.id, categoryId: category.id, name: marker + " addition", basePrice: 15, stockMode: "RECIPE" } });
  const ingredient = await db.inventoryItem.create({ data: { cafeId: cafe.id, branchId: branch.id, name: marker + " ingredient", unit: "KG", currentStock: 10, costPerUnit: 50 } });
  const finished = await db.inventoryItem.create({ data: { cafeId: cafe.id, branchId: branch.id, name: marker + " finished", unit: "PIECE", currentStock: 10, costPerUnit: 5 } });
  for (const product of [original, added]) await db.recipe.create({ data: { cafeId: cafe.id, productId: product.id, items: { create: { inventoryItemId: ingredient.id, quantity: 200, unit: "GRAM" } } } });
  const order = await db.order.create({ data: {
    cafeId: cafe.id, branchId: branch.id, orderNumber: 1, type: "TAKEAWAY", status: "CONFIRMED", subtotal: 15, total: 15,
    paidAmount: 0, remainingAmount: 15, paymentStatus: "UNPAID", createdById: owner.id, saleShiftId: shift.id,
    taxRateSnapshot: 0, serviceRateSnapshot: 0, inventoryEnforcementMode: "STRICT",
    items: { create: { productId: original.id, productName: original.name, unitPrice: 15, quantity: 1, lineTotal: 15, kitchenStatus: "NEW", stockModeSnapshot: "RECIPE", stockProductIdSnapshot: original.id, stockAcceptedAt: new Date() } },
  }, include: { items: true } });
  const newLineId = "new-" + randomUUID();
  const input: AmendmentInput = { baseRevision: 0, reason: marker + " unpaid same-total substitution", invoiceDiscount: { type: "NONE", value: "0" }, items: [
    { id: order.items[0].id, quantity: 0, discount: { type: "NONE", value: "0" } },
    { id: newLineId, productId: added.id, quantity: 1, discount: { type: "NONE", value: "0" } },
  ] };
  return { marker, cafe, branch, actor, original, added, ingredient, finished, order, input, newLineId };
}

test("catalog drift to FINISHED_GOOD refuses a staged recipe addition before commit", async t => {
  const f = await fixture();
  const amendment = await stageAmendment(f.actor, f.order.id, f.input, randomUUID());
  const staged = await db.orderAmendment.findUniqueOrThrow({ where: { id: amendment.id } });
  assert.equal(staged.status, "READY");
  assert.equal((staged.proposed as { settlement: { direction: string } }).settlement.direction, "NONE");
  await db.product.update({ where: { id: f.added.id }, data: { stockMode: "FINISHED_GOOD" } });
  await db.productStockBinding.create({ data: { cafeId: f.cafe.id, branchId: f.branch.id, productId: f.added.id, inventoryItemId: f.finished.id, unit: "PIECE" } });
  let commitError: unknown;
  try { await commitAmendment(f.actor, amendment.id); } catch (error) { commitError = error; }
  const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id }, include: { items: true } });
  const saved = order.items.find(line => line.id === f.newLineId);
  const plan = await db.$transaction(tx => planOrderConsumption(tx, f.order.id, "SERVE"));
  const evidence = {
    cafeId: f.cafe.id, orderId: order.id, amendmentId: amendment.id, productId: f.added.id,
    refusedStatus: (commitError as { status?: number } | undefined)?.status ?? null,
    gate: (await db.cafeSettings.findUniqueOrThrow({ where: { cafeId: f.cafe.id } })).finishedGoodsSalesEnabled,
    catalogMode: (await db.product.findUniqueOrThrow({ where: { id: f.added.id } })).stockMode,
    amendmentStatus: (await db.orderAmendment.findUniqueOrThrow({ where: { id: amendment.id } })).status,
    orderStatus: order.status, revision: order.revision, paymentStatus: order.paymentStatus,
    addedLine: saved ? { id: saved.id, productId: saved.productId, stockModeSnapshot: saved.stockModeSnapshot, stockAcceptedAt: saved.stockAcceptedAt, finishedStockItemId: saved.finishedStockItemId, finishedStockQuantity: saved.finishedStockQuantity } : null,
    consumptionPlan: plan.demands.map(row => ({ inventoryItemId: row.inventoryItemId, quantity: row.quantity, finishedAllocations: row.finishedAllocations })),
    ingredientItemId: f.ingredient.id, finishedItemId: f.finished.id,
    ingredientStock: Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: f.ingredient.id } })).currentStock),
    finishedStock: Number((await db.inventoryItem.findUniqueOrThrow({ where: { id: f.finished.id } })).currentStock),
    payments: await db.payment.count({ where: { orderId: order.id } }),
    settlements: await db.amendmentSettlement.count({ where: { amendmentId: amendment.id } }),
    stockMovements: await db.inventoryTransaction.count({ where: { orderId: order.id } }),
  };
  t.diagnostic(JSON.stringify(evidence));
  assert.equal(evidence.gate, false, "the finished-goods sales gate stays off");
  assert.equal(evidence.payments, 0);
  assert.equal(evidence.settlements, 0);
  assert.equal(evidence.stockMovements, 0);
  assert.equal(evidence.ingredientStock, 10);
  assert.equal(evidence.finishedStock, 10);
  assert.equal(evidence.refusedStatus, 409, "catalog drift must be refused instead of creating an unsnapshotted finished-good sale");
  assert.equal(order.revision, 0);
  assert.equal(saved, undefined);
  // Retain this precisely tagged fixture and immutable trace as RED evidence.
});

import { assertNoPendingRecipeAmendments } from "../src/lib/amendment-product-modes";
import { collectOrderPayment } from "../src/lib/payments";

test("pending recipe amendment blocks catalog transition under the product update lock", async () => {
 const f=await fixture();
 const a=await stageAmendment(f.actor,f.order.id,f.input,randomUUID());
 const change=()=>db.$transaction(async tx=>{
  await tx.$queryRawUnsafe('SELECT "id" FROM "Product" WHERE "id"=$1 FOR UPDATE',f.added.id);
  await assertNoPendingRecipeAmendments(tx,f.cafe.id,f.added.id);
  return tx.product.update({where:{id:f.added.id},data:{stockMode:"FINISHED_GOOD"}});
 });
 await assert.rejects(change(),(e:unknown)=>Boolean(e&&typeof e==="object"&&"status" in e&&e.status===409));
 assert.equal((await db.product.findUniqueOrThrow({where:{id:f.added.id}})).stockMode,"RECIPE");
 await cancelAmendment(f.actor,a.id);await change();
 assert.equal((await db.product.findUniqueOrThrow({where:{id:f.added.id}})).stockMode,"FINISHED_GOOD");
});
test("accepted recipe quantity refuses partial edit before settlement while price-only remains available",async()=>{
 const f=await fixture();
 const partial={...f.input,items:[{id:f.order.items[0].id,quantity:2,discount:{type:"NONE" as const,value:"0"}}]};
 await assert.rejects(stageAmendment(f.actor,f.order.id,partial,randomUUID()),(e:unknown)=>Boolean(e&&typeof e==="object"&&"status" in e&&e.status===409));
 assert.equal(await db.orderAmendment.count({where:{orderId:f.order.id}}),0);
 const priceOnly={...f.input,items:[{id:f.order.items[0].id,quantity:1,unitPrice:"14",discount:{type:"NONE" as const,value:"0"}}]};
 assert.ok((await stageAmendment(f.actor,f.order.id,priceOnly,randomUUID())).id);
 assert.equal(await db.payment.count({where:{orderId:f.order.id}}),0);
});
test("committed additions retain accepted recipe identity after later catalog changes",async()=>{
 const f=await fixture();const a=await stageAmendment(f.actor,f.order.id,f.input,randomUUID());
 await commitAmendment(f.actor,a.id);
 const saved=await db.orderItem.findUniqueOrThrow({where:{id:f.newLineId}});
 assert.equal(saved.stockModeSnapshot,"RECIPE");assert.ok(saved.stockAcceptedAt);
 assert.equal(saved.stockProductIdSnapshot,f.added.id);
 await db.product.update({where:{id:f.added.id},data:{stockMode:"FINISHED_GOOD"}});
 const plan=await db.$transaction(tx=>planOrderConsumption(tx,f.order.id,"SERVE"));
 assert.equal(plan.demands.length,1);assert.equal(plan.demands[0].inventoryItemId,f.ingredient.id);
 assert.equal(plan.demands[0].finishedAllocations.length,0);
});
test("drift refuses settlement before money and preserves observed money evidence for safe retry",async()=>{
 const f=await fixture();
 await collectOrderPayment({session:f.actor,orderId:f.order.id,branchId:f.branch.id,splits:[{method:"CARD",amount:15}]});
 const addition={...f.input,items:[{id:f.order.items[0].id,quantity:1,discount:{type:"NONE" as const,value:"0"}},f.input.items[1]]};
 const a=await stageAmendment(f.actor,f.order.id,addition,randomUUID());
 await db.product.update({where:{id:f.added.id},data:{stockMode:"FINISHED_GOOD"}});
 await assert.rejects(beginAmendmentSettlement(f.actor,a.id,randomUUID(),"CARD"),(e:unknown)=>Boolean(e&&typeof e==="object"&&"status" in e&&e.status===409));
 assert.equal(await db.amendmentSettlement.count({where:{amendmentId:a.id}}),0);
 await db.product.update({where:{id:f.added.id},data:{stockMode:"RECIPE"}});
 const attempt=await beginAmendmentSettlement(f.actor,a.id,randomUUID(),"CARD");
 await observeAmendmentSettlement(f.actor,a.id,attempt.id,"CONFIRMED",{confirmed:true,reference:"Synthetic verified card observation",note:"No external integration called"});
 await db.product.update({where:{id:f.added.id},data:{stockMode:"FINISHED_GOOD"}});
 await assert.rejects(commitAmendment(f.actor,a.id),(e:unknown)=>Boolean(e&&typeof e==="object"&&"status" in e&&e.status===409));
 assert.equal((await db.amendmentSettlement.findUniqueOrThrow({where:{id:attempt.id}})).status,"OBSERVED");
 assert.equal(await db.payment.count({where:{orderId:f.order.id}}),1);
 await db.product.update({where:{id:f.added.id},data:{stockMode:"RECIPE"}});
 await commitAmendment(f.actor,a.id);await commitAmendment(f.actor,a.id);
 assert.equal((await db.amendmentSettlement.findUniqueOrThrow({where:{id:attempt.id}})).status,"CONFIRMED");
 assert.equal(await db.payment.count({where:{orderId:f.order.id}}),2);
});
test("concurrent staging and catalog transition cannot both admit incompatible stock modes",async()=>{
 const f=await fixture();
 const outcomes=await Promise.allSettled([
  stageAmendment(f.actor,f.order.id,f.input,randomUUID()),
  db.$transaction(async tx=>{
   await tx.$queryRawUnsafe('SELECT "id" FROM "Product" WHERE "id"=$1 FOR UPDATE',f.added.id);
   await assertNoPendingRecipeAmendments(tx,f.cafe.id,f.added.id);
   return tx.product.update({where:{id:f.added.id},data:{stockMode:"FINISHED_GOOD"}});
  })
 ]);
 assert.equal(outcomes.filter(o=>o.status==="fulfilled").length,1);
 const mode=(await db.product.findUniqueOrThrow({where:{id:f.added.id}})).stockMode;
 assert.equal(mode,outcomes[0].status==="fulfilled"?"RECIPE":"FINISHED_GOOD");
 assert.equal(await db.payment.count({where:{orderId:f.order.id}}),0);
 assert.equal(await db.inventoryTransaction.count({where:{orderId:f.order.id}}),0);
});
