// Removing the granular discount guard must let the first denial test fail.
// Expected money is hand-derived from a 90.00 menu price, without tax.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { db, openShift, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";

let fx: CountCafe;
let foreign: CountCafe;
let productId: string;
before(async () => {
  await requireServer();
  fx = await countCafe("REL001");
  foreign = await countCafe("REL001foreign");
  await db.cafeSettings.update({where:{cafeId:fx.cafeId},data:{inventoryEnforcementMode:"OVERRIDE_ALL"}});
  const category = await db.menuCategory.create({data:{cafeId:fx.cafeId,name:"Release drinks"}});
  productId = (await db.product.create({data:{cafeId:fx.cafeId,categoryId:category.id,name:"Release coffee",basePrice:90}})).id;
});
after(() => teardownTaggedCafe([fx?.cafeId, foreign?.cafeId].filter(Boolean), [], {disconnect:true}));
function payload(extra: Record<string, unknown> = {}) {
  return {branchId:fx.branchId,type:"TAKEAWAY",collectionMode:"PENDING",discountAmount:10,
    items:[{productId,quantity:1}],...extra};
}
function sale(email: string, extra: Record<string,unknown> = {}, key?: string) {
  return as<{order?:{id:string,total:string,discountAmount:string,items:{unitPrice:string}[]}}>(email,"/api/orders",{
    method:"POST",body:JSON.stringify(payload(extra)),...(key?{headers:{"Idempotency-Key":key}}:{})});
}
async function override(userId: string, allowed: boolean) {
  await db.userPermissionOverride.upsert({where:{userId_permissionKey:{userId,permissionKey:"pos.apply_discount"}},
    create:{userId,permissionKey:"pos.apply_discount",allowed},update:{allowed}});
}
async function businessState() {
  const where={cafeId:fx.cafeId};
  return {orders:await db.order.count({where}),payments:await db.payment.count({where}),
    customers:await db.customer.count({where}),ledger:await db.inventoryTransaction.count({where}),
    inventory:await db.inventoryItem.findMany({where,select:{id:true,currentStock:true,ledgerVersion:true},orderBy:{id:"asc"}})};
}
test("actor with create permission but no discount permission is rejected without business mutations",async()=>{
  await override(fx.waiter.id,false);
  const before=await businessState();
  const r=await sale(fx.waiter.email,{customerPhone:"01012345678"});
  assert.equal(r.status,403,JSON.stringify(r.body));
  assert.deepEqual(await businessState(),before);
  assert.equal(await db.auditLog.count({where:{cafeId:fx.cafeId,userId:fx.waiter.id,action:"ORDER_DISCOUNT_REFUSED"}}),1);
});
test("explicit grant works, exact totals and sensitive audit persist, retry creates one order",async()=>{
  await override(fx.waiter.id,true);
  // Merged policy: staff also need a per-user discount limit (Sales lineage). The grant alone is refused.
  assert.equal((await sale(fx.waiter.email)).status,403,"grant without a configured limit");
  await db.salesDiscountLimit.upsert({where:{userId:fx.waiter.id},create:{userId:fx.waiter.id,cafeId:fx.cafeId,maxPercent:20,maxAmount:20,updatedById:fx.owner.id},update:{maxPercent:20,maxAmount:20}});
  const key=crypto.randomUUID();
  const first=await sale(fx.waiter.email,{},key);
  assert.equal(first.status,201,JSON.stringify(first.body));
  assert.equal(Number(first.body.order!.total),80);
  const replay=await sale(fx.waiter.email,{},key);
  assert.equal(replay.status,201);
  assert.equal(replay.body.order!.id,first.body.order!.id);
  assert.equal(await db.auditLog.count({where:{entityId:first.body.order!.id,action:"ORDER_DISCOUNT_APPLIED"}}),1);
  await override(fx.waiter.id,false);
  const deniedReplay=await sale(fx.waiter.email,{},key);
  assert.equal(deniedReplay.status,403,"revocation also applies before replay, with the existing cookie");
  assert.equal(await db.order.count({where:{id:first.body.order!.id}}),1);
});
test("explicit owner denial wins over root defaults and zero-discount sales still work",async()=>{
  await override(fx.owner.id,false);
  const before=await businessState();
  assert.equal((await sale(fx.owner.email)).status,403);
  assert.deepEqual(await businessState(),before);
  const zero=await sale(fx.owner.email,{discountAmount:0});
  assert.equal(zero.status,201,JSON.stringify(zero.body));
  assert.equal(Number(zero.body.order!.total),90);
  await db.userPermissionOverride.deleteMany({where:{userId:fx.owner.id}});
});
test("manager retains discounts; excessive and fractional-cent amounts are rejected before customer creation",async()=>{
  assert.equal((await sale(fx.manager.email)).status,201);
  for(const discountAmount of [90.01,-1,0.001,100000000]) {
    const before=await businessState();
    const r=await sale(fx.manager.email,{discountAmount,customerPhone:"01087654321"});
    assert.equal(r.status,400,JSON.stringify(r.body));
    assert.deepEqual(await businessState(),before);
  }
});
test("alternate payload prices and promotion flags cannot authorize a manual discount",async()=>{
  const before=await businessState();
  assert.equal((await sale(fx.waiter.email,{promotionId:"fake",isAutomatic:true})).status,403);
  assert.deepEqual(await businessState(),before);
  const r=await sale(fx.waiter.email,{discountAmount:0,total:1,unitPrice:1,lineDiscount:89,
    items:[{productId,quantity:1,unitPrice:1,discountAmount:89}]});
  assert.equal(r.status,201,JSON.stringify(r.body));
  assert.equal(Number(r.body.order!.total),90);
  assert.equal(Number(r.body.order!.items[0].unitPrice),90);
});
test("cross branch and foreign cafe targets cannot create discounted orders",async()=>{
  const before=await businessState();
  assert.equal((await sale(fx.manager.email,{branchId:fx.otherBranchId})).status,403);
  assert.equal((await sale(fx.owner.email,{branchId:foreign.branchId,cafeId:foreign.cafeId})).status,404);
  assert.deepEqual(await businessState(),before);
});
test("a custom create-only role does not gain manual discount authority",async()=>{
  await db.userPermissionOverride.deleteMany({where:{userId:fx.waiter.id}});
  const role=await db.cafeRole.create({data:{cafeId:fx.cafeId,name:"Create only",code:"RELEASE_CREATE_ONLY",
    permissions:{create:[{permissionKey:"pos.create_order"},{permissionKey:"pos.view"}]}}});
  await db.user.update({where:{id:fx.waiter.id},data:{cafeRoleId:role.id}});
  const before=await businessState();
  assert.equal((await sale(fx.waiter.email)).status,403);
  assert.deepEqual(await businessState(),before);
  assert.equal((await sale(fx.waiter.email,{discountAmount:0})).status,201);
});
test("server-validated loyalty redemption survives a manual-discount denial and cannot be spoofed",async()=>{
  await override(fx.manager.id,false);
  await openShift({cafeId:fx.cafeId,branchId:fx.branchId,productId,unitPrice:90},fx.manager.id,0);
  await db.loyaltySettings.create({data:{cafeId:fx.cafeId,enabled:true,minPointsToRedeem:1,pointValueAmount:1,earnPointsPerAmount:0}});
  const customer=await db.customer.create({data:{cafeId:fx.cafeId,phone:"01011223344",normalizedPhone:"01011223344",loyaltyPointsBalance:10}});
  const key=crypto.randomUUID();
  const extra={discountAmount:0,collectionMode:"NOW",method:"CASH",customerPhone:"01011223344",loyaltyPointsToRedeem:10,
    loyaltyDiscountAmount:89,promotionId:"fake"};
  const r=await sale(fx.manager.email,extra,key);
  assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(Number(r.body.order!.total),80);
  assert.equal(Number(r.body.order!.discountAmount),10);
  assert.equal((await sale(fx.manager.email,extra,key)).body.order!.id,r.body.order!.id);
  assert.equal((await db.customer.findUniqueOrThrow({where:{id:customer.id}})).loyaltyPointsBalance,0);
  assert.equal(await db.payment.count({where:{orderId:r.body.order!.id}}),1);
  const before=await businessState();
  assert.equal((await sale(fx.manager.email,extra)).status,400);
  assert.deepEqual(await businessState(),before);
});
