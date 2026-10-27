import { after, test } from "node:test";
import assert from "node:assert/strict";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, countItem } from "./helpers/count";
import { as, BASE } from "./helpers/http";
import { ensureCustodyForShift } from "@/lib/custody";
import { closeShiftWithSettlement } from "@/lib/cash-close";
const cafes:string[]=[];
after(async()=>{await teardownTaggedCafe(cafes);await db.$disconnect();});
async function waitingForCustody(){const end=Date.now()+5000;while(Date.now()<end){const rows=await db.$queryRaw<{n:bigint}[]>`SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%CustodyPeriod%'`;if(Number(rows[0].n)>0)return;await new Promise(r=>setTimeout(r,30));}throw Error("serve did not reach the held custody row");}
test("serving and no-count close share one lock order without losing stock deduction",{timeout:30000},async()=>{
 const fx=await countCafe("SERVECLOSE007");cafes.push(fx.cafeId);await db.cafeSettings.update({where:{cafeId:fx.cafeId},data:{stockCountPolicy:"NO_SHIFT_COUNT"}});
 const item=await countItem(fx,"beans",{stock:10});const cat=await db.menuCategory.create({data:{cafeId:fx.cafeId,name:fx.marker}});const product=await db.product.create({data:{cafeId:fx.cafeId,categoryId:cat.id,name:fx.marker,basePrice:0}});await db.recipe.create({data:{cafeId:fx.cafeId,productId:product.id,items:{create:{inventoryItemId:item.id,unit:"KG",quantity:0.1}}}});
 const shift=await db.$transaction(async tx=>{const s=await tx.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.cashier.id,shiftNumber:1,openingCashAmount:100}});await ensureCustodyForShift(tx,{cafeId:fx.cafeId,branchId:fx.branchId,shiftId:s.id,userId:fx.cashier.id,openingCashAmount:100});return s;});
 const order=await db.order.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,orderNumber:1,type:"TAKEAWAY",status:"READY",source:"CASHIER_POS",subtotal:0,total:0,createdById:fx.cashier.id,items:{create:{productId:product.id,productName:product.name,quantity:1,unitPrice:0,lineTotal:0}}}});
 await fetch(BASE+"/api/orders/"+order.id+"/status");
 let release!:()=>void,ready!:()=>void;const mayRelease=new Promise<void>(r=>release=r),isHeld=new Promise<void>(r=>ready=r);
 const blocker=db.$transaction(async tx=>{await tx.$queryRaw`SELECT "id" FROM "CustodyPeriod" WHERE "branchId"=${fx.branchId} AND "scope"='STOCK' AND "status"='OPEN' FOR UPDATE`;ready();await mayRelease;},{timeout:15000});
 await isHeld;const served=as(fx.manager.email,"/api/orders/"+order.id+"/status",{method:"PATCH",body:JSON.stringify({status:"SERVED"})});
 try{await waitingForCustody();const closed=closeShiftWithSettlement({shiftId:shift.id,actualCash:100,actorId:fx.cashier.id,closedByManager:false});await new Promise(r=>setTimeout(r,200));release();await blocker;const [sale,result]=await Promise.all([served,closed]);assert.equal(sale.status,200,sale.text);assert.equal(result.status,"CLOSED");assert.equal(Number((await db.inventoryItem.findUniqueOrThrow({where:{id:item.id}})).currentStock),9.9);assert.equal(await db.inventoryTransaction.count({where:{orderId:order.id,type:"USAGE"}}),1);assert.equal(await db.custodyPeriod.count({where:{branchId:fx.branchId,status:"OPEN"}}),0);}finally{release();await blocker;}
});
