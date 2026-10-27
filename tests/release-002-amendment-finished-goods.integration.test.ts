// RELEASE-002: Sales amendments (candidate lineage) meet finished-goods sales (root lineage).
//
// A finished-good order line carries an accepted stock snapshot (item, unit, quantity). An
// amendment that changes that line's quantity, or adds a new finished-good line, leaves the
// snapshot out of step with the line, and serving the order then fails (or, outside STRICT,
// sells without deducting). Until amendments maintain the snapshot, they must refuse such
// changes and leave the order untouched; price/discount-only edits stay allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {db} from '../src/lib/db';
import {stageAmendment} from '../src/lib/order-amendments';
import {planOrderConsumption} from '../src/lib/sale-consumption';
import type {SessionUser} from '../src/lib/auth';
import {assertIntegrationDatabase} from './helpers/integration-guard';

test.before(async()=>{await assertIntegrationDatabase(db);});
test.after(()=>db.$disconnect());

async function fixture(){
 const tag=crypto.randomUUID().slice(0,12);
 const cafe=await db.cafe.create({data:{name:'R10 finished amendment '+tag,slug:'r10fa-'+tag}});
 const branch=await db.branch.create({data:{cafeId:cafe.id,name:'Synthetic branch'}});
 const owner=await db.user.create({data:{cafeId:cafe.id,branchId:branch.id,email:`owner-${tag}@example.invalid`,name:'Synthetic owner',passwordHash:'NO_LOGIN',role:'CAFE_OWNER'}});
 const actor={id:owner.id,cafeId:cafe.id,branchId:branch.id,name:owner.name,email:owner.email,role:'CAFE_OWNER'} as SessionUser;
 await db.cafeSettings.create({data:{cafeId:cafe.id,inventoryEnforcementMode:'STRICT',finishedGoodsSalesEnabled:true,inventoryEnabled:true}});
 await db.ownerActionSettings.create({data:{cafeId:cafe.id,ownerId:owner.id}});
 const shift=await db.shift.create({data:{cafeId:cafe.id,branchId:branch.id,cashierId:owner.id,shiftNumber:1,openingCashAmount:0}});
 const category=await db.menuCategory.create({data:{cafeId:cafe.id,name:'Synthetic'}});
 const stock=await db.inventoryItem.create({data:{cafeId:cafe.id,branchId:branch.id,name:'Bottled water '+tag,unit:'PIECE',currentStock:10,costPerUnit:5}});
 const product=await db.product.create({data:{cafeId:cafe.id,categoryId:category.id,name:'Water '+tag,basePrice:15,stockMode:'FINISHED_GOOD'}});
 await db.productStockBinding.create({data:{cafeId:cafe.id,branchId:branch.id,productId:product.id,inventoryItemId:stock.id,unit:'PIECE'}});
 const now=new Date();
 const order=await db.order.create({data:{cafeId:cafe.id,branchId:branch.id,orderNumber:1,type:'TAKEAWAY',status:'CONFIRMED',subtotal:15,total:15,paidAmount:0,remainingAmount:15,paymentStatus:'UNPAID',createdById:owner.id,saleShiftId:shift.id,taxRateSnapshot:0,serviceRateSnapshot:0,inventoryEnforcementMode:'STRICT',
  items:{create:{productId:product.id,productName:product.name,unitPrice:15,quantity:1,lineTotal:15,
   stockModeSnapshot:'FINISHED_GOOD',stockProductIdSnapshot:product.id,stockAcceptedAt:now,finishedStockCafeId:cafe.id,finishedStockBranchId:branch.id,finishedStockItemId:stock.id,finishedStockUnit:'PIECE',finishedStockQuantity:1}}},include:{items:true}});
 return {actor,order,product,line:order.items[0]};
}
const input=(f:Awaited<ReturnType<typeof fixture>>,items:{id:string;quantity:number;productId?:string;unitPrice?:string}[])=>({baseRevision:0,reason:'Synthetic correction',invoiceDiscount:{type:'NONE' as const,value:'0'},items:items.map(i=>({...i,discount:{type:'NONE' as const,value:'0'}}))});
async function servePlanStillValid(orderId:string){return db.$transaction(tx=>planOrderConsumption(tx,orderId,'SERVE')).then(()=>true,(e:Error)=>e.message);}

test('changing the quantity of a finished-good line is refused and leaves the order servable',async()=>{
 const f=await fixture();
 await assert.rejects(stageAmendment(f.actor,f.order.id,input(f,[{id:f.line.id,quantity:2}]),crypto.randomUUID()),(e:Error&{status?:number})=>e.status===409);
 assert.equal(await db.orderAmendment.count({where:{orderId:f.order.id}}),0);
 assert.equal(await servePlanStillValid(f.order.id),true);
});
test('removing a finished-good line is refused',async()=>{
 const f=await fixture();
 const extra=await db.orderItem.create({data:{orderId:f.order.id,productName:'Tea',unitPrice:10,quantity:1,lineTotal:10}});
 await assert.rejects(stageAmendment(f.actor,f.order.id,input(f,[{id:f.line.id,quantity:0},{id:extra.id,quantity:1}]),crypto.randomUUID()),(e:Error&{status?:number})=>e.status===409);
});
test('adding a new finished-good line is refused',async()=>{
 const f=await fixture();
 await assert.rejects(stageAmendment(f.actor,f.order.id,input(f,[{id:f.line.id,quantity:1},{id:'new-1',productId:f.product.id,quantity:1}]),crypto.randomUUID()),(e:Error&{status?:number})=>e.status===409);
 assert.equal(await db.orderAmendment.count({where:{orderId:f.order.id}}),0);
});
test('a price-only correction on a finished-good line is still allowed',async()=>{
 const f=await fixture();
 const a=await stageAmendment(f.actor,f.order.id,input(f,[{id:f.line.id,quantity:1,unitPrice:'12'}]),crypto.randomUUID());
 assert.ok(a.id);
 assert.equal(await servePlanStillValid(f.order.id),true);
});
