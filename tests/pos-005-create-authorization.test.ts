import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {db,policyProduct,teardownTaggedCafe} from "./helpers/db";
import {countCafe,type CountCafe} from "./helpers/count";
import {as,requireServer} from "./helpers/http";

let fx:CountCafe,productId:string;
before(async()=>{
  await requireServer();fx=await countCafe("POS005");
  await db.menuCategory.create({data:{cafeId:fx.cafeId,name:"POS permission fixture"}});
  productId=(await policyProduct({cafeId:fx.cafeId,branchId:fx.branchId,productId:"",unitPrice:75},"POS005")).id;
  // A waiter can take an unpaid order without owning a cash shift.
  await sale(crypto.randomUUID());
});
after(async()=>{
  if(fx){await db.idempotencyKey.deleteMany({where:{scope:{startsWith:fx.cafeId+":"}}});await teardownTaggedCafe(fx.cafeId);}
  await db.$disconnect();
});
async function sale(key:string){return as(fx.waiter.email,"/api/orders",{method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify({branchId:fx.branchId,type:"TAKEAWAY",collectionMode:"PENDING",items:[{productId,quantity:1}]})});}
async function state(){return {orders:await db.order.findMany({where:{cafeId:fx.cafeId},include:{items:true},orderBy:{id:"asc"}}),payments:await db.payment.findMany({where:{cafeId:fx.cafeId}}),customers:await db.customer.findMany({where:{cafeId:fx.cafeId}}),stock:await db.inventoryTransaction.findMany({where:{cafeId:fx.cafeId}}),keys:await db.idempotencyKey.findMany({where:{scope:{startsWith:fx.cafeId+":"}},orderBy:{id:"asc"}})};}
async function denyCreate(){return db.userPermissionOverride.create({data:{userId:fx.waiter.id,permissionKey:"pos.create_order",allowed:false}});}

test("pos.view cannot substitute for a revoked create permission on an existing session",async()=>{
  const override=await denyCreate();
  try{const before_=await state();const r=await sale(crypto.randomUUID());assert.equal(r.status,403,r.text);assert.deepEqual(await state(),before_);}
  finally{await db.userPermissionOverride.delete({where:{id:override.id}});}
});
test("creation revocation also rejects completed replay; restoring permission reuses the original order",async()=>{
  const key=crypto.randomUUID(),first=await sale(key);assert.equal(first.status,201,first.text);
  const override=await denyCreate();
  try{const before_=await state();const denied=await sale(key);assert.equal(denied.status,403,denied.text);assert.deepEqual(await state(),before_);}
  finally{await db.userPermissionOverride.delete({where:{id:override.id}});}
  const restored=await sale(key);assert.equal(restored.status,201,restored.text);assert.deepEqual(restored.body,first.body);
});
