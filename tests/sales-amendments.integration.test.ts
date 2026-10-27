import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {db} from '../src/lib/db';
import {stageAmendment,approveAmendment,beginAmendmentSettlement,observeAmendmentSettlement,commitAmendment,cancelAmendment,previewAmendment,revisionReceipt,serveAmendmentAdditions,type AmendmentInput} from '../src/lib/order-amendments';
import {refundOrder} from '../src/lib/refunds';
import {decideOwnerAction} from '../src/lib/owner-action-approvals';
import {saleDetail,listSales,listTracing} from '../src/lib/sales-query';
import {recognizedSales,contributionTotals,contributionItems} from '../src/lib/sales-recognition';
import {recomputeShiftTotals} from '../src/lib/shifts';
import {periodFinancials} from '../src/lib/reporting';
import type {SessionUser} from '../src/lib/auth';

async function guard(){
 assert.equal(process.env.DATABASE_URL,'postgresql://postgres@127.0.0.1:5434/cafe_ops_test_sales_20261024a?schema=public');
 const [id]=await db.$queryRawUnsafe<{name:string;host:string;port:number;system:string}[]>(`SELECT current_database() name,host(inet_server_addr()) host,inet_server_port() port,(SELECT system_identifier::text FROM pg_control_system()) system`);
 assert.deepEqual(id,{name:'cafe_ops_test_sales_20261024a',host:'127.0.0.1',port:5434,system:'7693368256609479860'});
}
test.before(guard);test.after(()=>db.$disconnect());
async function fixture(paid='100',method:'CASH'|'CARD'='CASH'){
 const tag=crypto.randomUUID().slice(0,12);
 const cafe=await db.cafe.create({data:{name:'Sales synthetic '+tag,slug:'sales-'+tag}});
 const branch=await db.branch.create({data:{cafeId:cafe.id,name:'Synthetic branch'}});
 const owner=await db.user.create({data:{cafeId:cafe.id,branchId:branch.id,email:`owner-${tag}@example.invalid`,name:'Original synthetic cashier',passwordHash:'NO_LOGIN',role:'CAFE_OWNER'}});
 const actor={id:owner.id,cafeId:cafe.id,branchId:branch.id,name:owner.name,email:owner.email,role:'CAFE_OWNER'} as SessionUser;
 await db.cafeSettings.create({data:{cafeId:cafe.id,inventoryEnforcementMode:'OVERRIDE_ALL'}});
 await db.ownerActionSettings.create({data:{cafeId:cafe.id,ownerId:owner.id}});
 const shift=await db.shift.create({data:{cafeId:cafe.id,branchId:branch.id,cashierId:owner.id,shiftNumber:1,openingCashAmount:0}});
 const order=await db.order.create({data:{cafeId:cafe.id,branchId:branch.id,orderNumber:1,type:'TAKEAWAY',status:'SERVED',subtotal:100,total:100,paidAmount:paid,remainingAmount:100-Number(paid),paymentStatus:paid==='100'?'PAID':paid==='0'?'UNPAID':'PARTIAL',createdById:owner.id,saleShiftId:shift.id,taxRateSnapshot:0,serviceRateSnapshot:0,inventoryEnforcementMode:'OVERRIDE_ALL',items:{create:{productName:'Tea',unitPrice:100,quantity:1,lineTotal:100,kitchenStatus:'SERVED'}}},include:{items:true}});
 if(Number(paid)>0)await db.payment.create({data:{cafeId:cafe.id,branchId:branch.id,orderId:order.id,shiftId:shift.id,receivedById:owner.id,cashierId:owner.id,amount:paid,method}});
 await recomputeShiftTotals(shift.id);
 const input=(total='100',discount={type:'NONE' as 'NONE'|'PERCENT'|'FIXED',value:'0'}):AmendmentInput=>({baseRevision:0,reason:'Synthetic correction',invoiceDiscount:discount,items:[{id:order.items[0].id,quantity:1,unitPrice:total,discount:{type:'NONE',value:'0'}}]});
 return {cafe,branch,actor,shift,order,input};
}
async function apply(f:Awaited<ReturnType<typeof fixture>>,input:AmendmentInput,method:'CASH'|'CARD'='CASH'){
 const a=await stageAmendment(f.actor,f.order.id,input,crypto.randomUUID());
 if(a.approvalRequired)await approveAmendment(f.actor,a.id);
 const s=(a.proposed as {settlement:{direction:string}}).settlement;
 if(s.direction!=='NONE'){
  const attempt=await beginAmendmentSettlement(f.actor,a.id,crypto.randomUUID(),method);
  await observeAmendmentSettlement(f.actor,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'synthetic-verified-'+attempt.id,note:'Actual test confirmation'});
 }
 return {a,result:await commitAmendment(f.actor,a.id)};
}
test('unpaid 100 -> 90 creates no cash movement',async()=>{
 const f=await fixture('0');await apply(f,f.input('100',{type:'PERCENT',value:'10'}));
 const o=await db.order.findUniqueOrThrow({where:{id:f.order.id}});assert.equal(o.total.toString(),'90');assert.equal(o.remainingAmount.toString(),'90');assert.equal(await db.payment.count({where:{orderId:o.id}}),0);
});
for(const [total,type,amount] of [['120','COLLECTION','20'],['80','REFUND','20'],['100','NONE','0']])test(`paid cash 100 -> ${total} is exactly ${type} ${amount}`,async()=>{
 const f=await fixture();const {a}=await apply(f,f.input(total));
 const legs=await db.payment.findMany({where:{amendmentId:a.id}});assert.equal(legs.length,type==='NONE'?0:1);if(legs.length){assert.equal(legs[0].type,type);assert.equal(legs[0].amount.toString(),amount);}
 const fresh=await db.order.findUniqueOrThrow({where:{id:f.order.id}});assert.equal(fresh.createdById,f.actor.id);assert.equal(fresh.revision,1);assert.equal(fresh.paymentStatus,'PAID');
 const count=await db.payment.count({where:{orderId:f.order.id}});await commitAmendment(f.actor,a.id);assert.equal(await db.payment.count({where:{orderId:f.order.id}}),count);
 const shift=await db.shift.findUniqueOrThrow({where:{id:f.shift.id}});assert.equal(shift.totalCashSales.toString(),total);assert.equal(shift.orderCount,1);
});
test('paid 10% discount refunds10; report net is90 not80',async()=>{
 const f=await fixture();await apply(f,f.input('100',{type:'PERCENT',value:'10'}));
 const r=await periodFinancials({cafeId:f.cafe.id,branchId:f.branch.id,period:{gte:new Date('2020-01-01')}});assert.equal(r.netSales,90);assert.equal(r.netMoneyMovement,90);
});
test('card refund leaves cash drawer unchanged',async()=>{
 const f=await fixture('100','CARD');await apply(f,f.input('80'),'CARD');
 const shift=await db.shift.findUniqueOrThrow({where:{id:f.shift.id}});assert.equal(shift.totalCashSales.toString(),'0');assert.equal(shift.totalCardSales.toString(),'80');
});
test('simultaneous stale revisions cannot overwrite; duplicate stage returns same request',async()=>{
 const f=await fixture('0'),key=crypto.randomUUID();const a=await stageAmendment(f.actor,f.order.id,f.input('90'),key);const same=await stageAmendment(f.actor,f.order.id,f.input('90'),key);assert.equal(same.id,a.id);
 const b=await stageAmendment(f.actor,f.order.id,f.input('80'),crypto.randomUUID());
 const results=await Promise.allSettled([commitAmendment(f.actor,a.id),commitAmendment(f.actor,b.id)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('pending/failed/unknown settlement never changes financial records',async()=>{
 const f=await fixture();const a=await stageAmendment(f.actor,f.order.id,f.input('120'),crypto.randomUUID());const attempt=await beginAmendmentSettlement(f.actor,a.id,crypto.randomUUID(),'CASH');
 await assert.rejects(()=>commitAmendment(f.actor,a.id));assert.equal(await db.payment.count({where:{orderId:f.order.id}}),1);
 await observeAmendmentSettlement(f.actor,a.id,attempt.id,'UNKNOWN',{confirmed:false,reference:'',note:'Processor uncertain'});await assert.rejects(()=>beginAmendmentSettlement(f.actor,a.id,crypto.randomUUID(),'CASH'));
 await observeAmendmentSettlement(f.actor,a.id,attempt.id,'FAILED',{confirmed:false,reference:'',note:'Confirmed no funds moved'});assert.equal(await db.payment.count({where:{orderId:f.order.id}}),1);
});
test('revision and tracing evidence reject update and delete',async()=>{
 const f=await fixture('0');await apply(f,f.input('90'));const revision=await db.orderRevision.findFirstOrThrow({where:{orderId:f.order.id}});
 await assert.rejects(()=>db.orderRevision.update({where:{id:revision.id},data:{reason:'tamper'}}));await assert.rejects(()=>db.orderTrace.deleteMany({where:{orderId:f.order.id}}));
 assert.equal((revision.before as {total:string}).total,'100');assert.equal((revision.after as {total:string}).total,'90');
});

test('line then invoice percentages give81 and fixed discount removal restores100',async()=>{
 const f=await fixture('0'),input=f.input('100',{type:'PERCENT',value:'10'});input.items[0].discount={type:'PERCENT',value:'10'};
 await apply(f,input);assert.equal((await db.order.findUniqueOrThrow({where:{id:f.order.id}})).total.toString(),'81');
 const removal=f.input();removal.baseRevision=1;await apply(f,removal);assert.equal((await db.order.findUniqueOrThrow({where:{id:f.order.id}})).total.toString(),'100');
 const fixed=f.input('100',{type:'FIXED',value:'20'});fixed.baseRevision=2;await apply(f,fixed);assert.equal((await db.order.findUniqueOrThrow({where:{id:f.order.id}})).total.toString(),'80');
});
test('mixed paid refund respects original legs and previous partial refund',async()=>{
 const f=await fixture('100');const original=await db.payment.findFirstOrThrow({where:{orderId:f.order.id}});await db.payment.update({where:{id:original.id},data:{amount:60}});
 await db.payment.create({data:{cafeId:f.cafe.id,branchId:f.branch.id,orderId:f.order.id,shiftId:f.shift.id,receivedById:f.actor.id,amount:40,method:'CARD'}});
 await db.payment.create({data:{cafeId:f.cafe.id,branchId:f.branch.id,orderId:f.order.id,shiftId:f.shift.id,receivedById:f.actor.id,amount:10,method:'CASH',type:'REFUND',reversalOfPaymentId:original.id}});
 await db.order.update({where:{id:f.order.id},data:{paidAmount:90,remainingAmount:10,paymentStatus:'PARTIAL'}});
 const {a}=await apply(f,f.input('80'));const refunds=await db.payment.findMany({where:{amendmentId:a.id},orderBy:{method:'asc'}});assert.equal(refunds.length,2);assert.equal(refunds.reduce((s,r)=>s+Number(r.amount),0),10);assert.equal(refunds.find(r=>r.method==='CASH')!.amount.toString(),'5.56');assert.equal(refunds.find(r=>r.method==='CARD')!.amount.toString(),'4.44');
});
test('legacy full refund returns only remaining balance after amendment partial refund',async()=>{
 const f=await fixture();await apply(f,f.input('80'));await refundOrder(f.order.id,f.actor,'Synthetic remaining refund');
 const refunds=await db.payment.findMany({where:{orderId:f.order.id,type:'REFUND'}});assert.deepEqual(refunds.map(r=>Number(r.amount)).sort((a,b)=>a-b),[20,80]);assert.equal((await db.order.findUniqueOrThrow({where:{id:f.order.id}})).paymentStatus,'REFUNDED');
});
test('reprint original and revised snapshot never duplicates financial or stock rows',async()=>{
 const f=await fixture();await apply(f,f.input('80'));
 const before=[await db.order.count({where:{cafeId:f.cafe.id}}),await db.payment.count({where:{orderId:f.order.id}}),await db.inventoryTransaction.count({where:{orderId:f.order.id}})];
 const original=await revisionReceipt(f.actor,f.order.id,0,true),revised=await revisionReceipt(f.actor,f.order.id,1,true);await revisionReceipt(f.actor,f.order.id,1,true);
 assert.equal((original.snapshot as {total:string}).total,'100');assert.equal((revised.snapshot as {total:string}).total,'80');
 assert.deepEqual([await db.order.count({where:{cafeId:f.cafe.id}}),await db.payment.count({where:{orderId:f.order.id}}),await db.inventoryTransaction.count({where:{orderId:f.order.id}})],before);
 assert.equal(await db.orderTrace.count({where:{orderId:f.order.id,action:'RECEIPT_REPRINT_REQUESTED'}}),3);
});
async function cashier(f:Awaited<ReturnType<typeof fixture>>){
 const u=await db.user.create({data:{cafeId:f.cafe.id,branchId:f.branch.id,email:'cashier-'+crypto.randomUUID()+'@example.invalid',name:'Editing cashier',passwordHash:'NO_LOGIN',role:'CASHIER'}});
 await db.shift.create({data:{cafeId:f.cafe.id,branchId:f.branch.id,cashierId:u.id,shiftNumber:2,openingCashAmount:0}});
 return {...f.actor,id:u.id,email:u.email,name:u.name,role:'CASHIER'} as SessionUser;
}
test('zero-default cashier limits require actual manager approval, without changing original cashier',async()=>{
 const f=await fixture('0'),c=await cashier(f),a=await stageAmendment(c,f.order.id,f.input('100',{type:'PERCENT',value:'10'}),crypto.randomUUID());assert.equal(a.approvalRequired,true);
 await assert.rejects(()=>commitAmendment(c,a.id));await assert.rejects(()=>approveAmendment(c,a.id));await approveAmendment(f.actor,a.id);await commitAmendment(c,a.id);
 const o=await db.order.findUniqueOrThrow({where:{id:f.order.id}}),r=await db.orderRevision.findUniqueOrThrow({where:{amendmentId:a.id}});assert.equal(o.createdById,f.actor.id);assert.equal(r.actorId,c.id);assert.equal(r.approverId,f.actor.id);
});
test('cashier within both configured limits can apply unpaid discount',async()=>{
 const f=await fixture('0'),c=await cashier(f);await db.salesDiscountLimit.create({data:{userId:c.id,cafeId:f.cafe.id,maxAmount:20,maxPercent:20,updatedById:f.actor.id}});
 const a=await stageAmendment(c,f.order.id,f.input('100',{type:'PERCENT',value:'10'}),crypto.randomUUID());assert.equal(a.approvalRequired,false);await commitAmendment(c,a.id);
});
test('cashier refund cannot bypass configured owner request; manager discount approval is insufficient',async()=>{
 const f=await fixture(),c=await cashier(f),a=await stageAmendment(c,f.order.id,f.input('100',{type:'PERCENT',value:'10'}),crypto.randomUUID());assert(a.ownerRequestId);await approveAmendment(f.actor,a.id);
 await assert.rejects(()=>beginAmendmentSettlement(c,a.id,crypto.randomUUID(),'CASH'));
 await decideOwnerAction({actor:f.actor,requestId:a.ownerRequestId,decision:'ACCEPT'});
 const attempt=await beginAmendmentSettlement(c,a.id,crypto.randomUUID(),'CASH');await observeAmendmentSettlement(c,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',note:'cash returned'});await commitAmendment(c,a.id);
});
test('cross-branch view/edit/trace denied and permission override fails closed',async()=>{
 const f=await fixture('0'),branch=await db.branch.create({data:{cafeId:f.cafe.id,name:'Other synthetic branch'}}),c=await cashier(f),other={...c,branchId:branch.id};
 await assert.rejects(()=>saleDetail(other,f.order.id));await assert.rejects(()=>stageAmendment(other,f.order.id,f.input(),crypto.randomUUID()));await assert.rejects(()=>listSales(c,new URLSearchParams({branchId:branch.id})));assert.equal((await listTracing(other,new URLSearchParams({q:f.order.id})).catch(()=>({records:[]}))).records.length,0);
 await db.userPermissionOverride.create({data:{userId:c.id,permissionKey:'sales.edit',allowed:false}});await assert.rejects(()=>previewAmendment(c,f.order.id,f.input()));
});
test('closed-shift correction posts to current shift, preserving closed shift snapshot',async()=>{
 const f=await fixture();await db.shift.update({where:{id:f.shift.id},data:{status:'CLOSED',closedAt:new Date()}});const before=await db.shift.findUniqueOrThrow({where:{id:f.shift.id}});
 const next=await db.shift.create({data:{cafeId:f.cafe.id,branchId:f.branch.id,cashierId:f.actor.id,shiftNumber:2,openingCashAmount:0}});
 const a=await stageAmendment(f.actor,f.order.id,f.input('80'),crypto.randomUUID());assert(a.originalShiftClosed);assert.equal(a.approverId,f.actor.id);
 const attempt=await beginAmendmentSettlement(f.actor,a.id,crypto.randomUUID(),'CASH');await observeAmendmentSettlement(f.actor,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',note:'Current period refund'});await commitAmendment(f.actor,a.id);
 assert.deepEqual(await db.shift.findUniqueOrThrow({where:{id:f.shift.id}}),before);const payment=await db.payment.findFirstOrThrow({where:{amendmentId:a.id}});assert.equal(payment.shiftId,next.id);
});
test('loyalty orders use owner-selected existing cancellation/refund workflow',async()=>{
 const f=await fixture();await db.order.update({where:{id:f.order.id},data:{loyaltyPointsAwardedAt:new Date()}});await assert.rejects(()=>previewAmendment(f.actor,f.order.id,f.input('90')),/ولاء/);
});

async function stockFixture(f:Awaited<ReturnType<typeof fixture>>,initial=9){
 await db.custodyPeriod.create({data:{cafeId:f.cafe.id,branchId:f.branch.id,scope:'STOCK',holderType:'USER',responsibleShiftId:f.shift.id,openedById:f.actor.id}});
 const category=await db.menuCategory.create({data:{cafeId:f.cafe.id,name:'Synthetic drinks'}});
 const product=await db.product.create({data:{cafeId:f.cafe.id,categoryId:category.id,name:'Tea',basePrice:100}});
 const ingredient=await db.inventoryItem.create({data:{cafeId:f.cafe.id,branchId:f.branch.id,name:'Synthetic tea portion',unit:'PIECE',currentStock:initial,costPerUnit:2}});
 await db.recipe.create({data:{cafeId:f.cafe.id,productId:product.id,items:{create:{inventoryItemId:ingredient.id,quantity:1,unit:'PIECE'}}}});
 await db.orderItem.update({where:{id:f.order.items[0].id},data:{productId:product.id}});
 return {product,ingredient};
}
test('served addition prepares/deducts only delta once; prepared removal does not restore stock',async()=>{
 const f=await fixture(),{ingredient}=await stockFixture(f);await db.order.update({where:{id:f.order.id},data:{stockDeductedAt:new Date()}});
 const input=f.input();input.items[0].quantity=2;const {a}=await apply(f,input);
 assert.equal((await db.inventoryItem.findUniqueOrThrow({where:{id:ingredient.id}})).currentStock.toString(),'9');assert.equal((await db.orderAmendment.findUniqueOrThrow({where:{id:a.id}})).kitchenStatus,'PENDING');
 await serveAmendmentAdditions(f.actor,a.id);await serveAmendmentAdditions(f.actor,a.id);
 assert.equal((await db.inventoryItem.findUniqueOrThrow({where:{id:ingredient.id}})).currentStock.toString(),'8');assert.equal(await db.inventoryTransaction.count({where:{orderId:f.order.id}}),1);
 const removal=f.input();removal.baseRevision=1;await apply(f,removal);
 assert.equal((await db.inventoryItem.findUniqueOrThrow({where:{id:ingredient.id}})).currentStock.toString(),'8');assert.equal(await db.inventoryTransaction.count({where:{orderId:f.order.id}}),1);
});
test('prepared quantity removed before normal deduction is recorded as wastage, not skipped or restored',async()=>{
 const f=await fixture('0'),{ingredient}=await stockFixture(f,10);await db.order.update({where:{id:f.order.id},data:{status:'PREPARING',subtotal:200,total:200,remainingAmount:200}});await db.orderItem.update({where:{id:f.order.items[0].id},data:{quantity:2,lineTotal:200,kitchenStatus:'PREPARING'}});
 await apply(f,f.input());const rows=await db.inventoryTransaction.findMany({where:{orderId:f.order.id}});assert.equal(rows.length,1);assert.equal(rows[0].type,'WASTE');assert.equal(rows[0].quantity.toString(),'-1');assert.equal((await db.inventoryItem.findUniqueOrThrow({where:{id:ingredient.id}})).currentStock.toString(),'9');
});
test('invalid price overrides, quantities and excessive discounts are rejected without writes',async()=>{
 const f=await fixture('0'),c=await cashier(f);
 await assert.rejects(()=>previewAmendment(c,f.order.id,f.input('90')),/السعر/);
 const bad=f.input();bad.items[0].quantity=-1;await assert.rejects(()=>stageAmendment(f.actor,f.order.id,bad,crypto.randomUUID()));
 const excess=f.input('100',{type:'PERCENT',value:'101'});await assert.rejects(()=>previewAmendment(f.actor,f.order.id,excess));assert.equal(await db.orderRevision.count({where:{orderId:f.order.id}}),0);
});
test('durably observed settlement can retry internal commit without another collection',async()=>{
 const f=await fixture(),a=await stageAmendment(f.actor,f.order.id,f.input('120'),crypto.randomUUID()),attempt=await beginAmendmentSettlement(f.actor,a.id,crypto.randomUUID(),'CARD');
 await assert.rejects(()=>observeAmendmentSettlement(f.actor,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',note:''}));
 await observeAmendmentSettlement(f.actor,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'provider-verified-123',note:''});
 await Promise.all([commitAmendment(f.actor,a.id),commitAmendment(f.actor,a.id)]).catch(()=>{});
 await commitAmendment(f.actor,a.id);assert.equal(await db.payment.count({where:{amendmentId:a.id}}),1);assert.equal((await db.amendmentSettlement.findUniqueOrThrow({where:{id:attempt.id}})).status,'CONFIRMED');
});

test('removing full discount on a settled zero-total invoice requires full collection',async()=>{
 const f=await fixture();await apply(f,f.input('100',{type:'PERCENT',value:'100'}));const second=f.input();second.baseRevision=1;
 const a=await stageAmendment(f.actor,f.order.id,second,crypto.randomUUID());assert.equal((a.proposed as {settlement:{amount:string;direction:string}}).settlement.amount,'100.00');await assert.rejects(()=>commitAmendment(f.actor,a.id));
});
test('shift closure after staging requires fresh manager approval',async()=>{
 const f=await fixture('0'),c=await cashier(f),a=await stageAmendment(c,f.order.id,f.input(),crypto.randomUUID());assert.equal(a.approvalRequired,false);
 await db.shift.update({where:{id:f.shift.id},data:{status:'CLOSED',closedAt:new Date()}});await assert.rejects(()=>commitAmendment(c,a.id),/الشيفت الأصلي/);await approveAmendment(f.actor,a.id);await commitAmendment(c,a.id);
});
test('effective owner-action denial blocks refund amendments despite edit/collection rights',async()=>{
 const f=await fixture(),c=await cashier(f);await db.userPermissionOverride.create({data:{userId:c.id,permissionKey:'orders.request_owner_action',allowed:false}});
 await assert.rejects(()=>stageAmendment(c,f.order.id,f.input('100',{type:'PERCENT',value:'10'}),crypto.randomUUID()),/صلاحية/);
});
test('uncertain cashier attempt requires a different manager to reconcile before commit',async()=>{
 const f=await fixture(),c=await cashier(f),input=f.input('100',{type:'PERCENT',value:'10'}),a=await stageAmendment(c,f.order.id,input,crypto.randomUUID());await approveAmendment(f.actor,a.id);await decideOwnerAction({actor:f.actor,requestId:a.ownerRequestId!,decision:'ACCEPT'});
 const attempt=await beginAmendmentSettlement(c,a.id,crypto.randomUUID(),'CASH');await observeAmendmentSettlement(c,a.id,attempt.id,'UNKNOWN',{confirmed:false,reference:'',note:'Need reconciliation'});
 await assert.rejects(()=>observeAmendmentSettlement(c,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',note:'Unverified'}),/المدير/);
 await observeAmendmentSettlement(f.actor,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',note:'Manager verified cash physically returned'});await commitAmendment(c,a.id);
});
test('stock delta refuses branch-held or missing custody without moving stock',async()=>{
 const f=await fixture(),{ingredient}=await stockFixture(f);await db.order.update({where:{id:f.order.id},data:{stockDeductedAt:new Date()}});const input=f.input();input.items[0].quantity=2;const {a}=await apply(f,input);
 await db.custodyPeriod.updateMany({where:{cafeId:f.cafe.id,scope:'STOCK'},data:{holderType:'BRANCH'}});await assert.rejects(()=>serveAmendmentAdditions(f.actor,a.id),/عهدة المخزون/);assert.equal((await db.inventoryItem.findUniqueOrThrow({where:{id:ingredient.id}})).currentStock.toString(),'9');
});
test('original period and adjustment period projections reconcile with financial headlines',async()=>{
 const f=await fixture();const originalDate=new Date('2026-10-20T12:00:00Z');await db.order.update({where:{id:f.order.id},data:{createdAt:originalDate}});await apply(f,f.input('120'));
 const oldScope={cafeId:f.cafe.id,branchId:f.branch.id,period:{gte:new Date('2026-10-20T00:00:00Z'),lt:new Date('2026-10-21T00:00:00Z')}};
 const revision=await db.orderRevision.findFirstOrThrow({where:{orderId:f.order.id}}),currentDay=new Date(revision.createdAt.toISOString().slice(0,10)+'T00:00:00Z');
 const currentScope={cafeId:f.cafe.id,branchId:f.branch.id,period:{gte:currentDay,lt:new Date(currentDay.getTime()+86400000)}};
 assert.equal(contributionTotals(await recognizedSales(oldScope)).revenue,100);assert.equal(contributionTotals(await recognizedSales(currentScope)).revenue,20);
 assert.equal((await periodFinancials(oldScope)).grossSales,100);assert.equal((await periodFinancials(currentScope)).grossSales,20);
 assert.equal(contributionItems(await recognizedSales(oldScope))[0].revenue,100);assert.equal(contributionItems(await recognizedSales(currentScope))[0].revenue,20);
});
test('refund before first service is not deducted twice when the order is eventually served',async()=>{
 const f=await fixture();await db.order.update({where:{id:f.order.id},data:{status:'CONFIRMED'}});await apply(f,f.input('80'));
 const scope={cafeId:f.cafe.id,branchId:f.branch.id,period:{gte:new Date('2020-01-01')}};
 assert.equal((await periodFinancials(scope)).grossSales,0);
 await db.order.update({where:{id:f.order.id},data:{status:'SERVED'}});
 const financial=await periodFinancials(scope);assert.equal(financial.grossSales,100);assert.equal(financial.refunds,20);assert.equal(financial.netSales,80);assert.equal(contributionTotals(await recognizedSales(scope)).revenue,100);
});
test('cancelled increase cannot restart a settlement',async()=>{
 const f=await fixture(),a=await stageAmendment(f.actor,f.order.id,f.input('120'),crypto.randomUUID());await cancelAmendment(f.actor,a.id);await assert.rejects(()=>beginAmendmentSettlement(f.actor,a.id,crypto.randomUUID(),'CASH'),/ملغي/);await assert.rejects(()=>commitAmendment(f.actor,a.id),/ملغي/);
});
test('concurrent cancel/commit leaves exactly one consistent terminal state',async()=>{
 const f=await fixture('0'),a=await stageAmendment(f.actor,f.order.id,f.input('90'),crypto.randomUUID());await Promise.allSettled([cancelAmendment(f.actor,a.id),commitAmendment(f.actor,a.id)]);
 const request=await db.orderAmendment.findUniqueOrThrow({where:{id:a.id}}),revisions=await db.orderRevision.count({where:{amendmentId:a.id}});assert.equal(revisions,request.status==='COMMITTED'?1:0);assert(['COMMITTED','CANCELLED'].includes(request.status));
});
test('within-limit cashier refund retains owner approval identity in revision evidence',async()=>{
 const f=await fixture(),c=await cashier(f);await db.salesDiscountLimit.create({data:{userId:c.id,cafeId:f.cafe.id,maxAmount:20,maxPercent:20,updatedById:f.actor.id}});
 const a=await stageAmendment(c,f.order.id,f.input('100',{type:'PERCENT',value:'10'}),crypto.randomUUID());assert.equal(a.approvalRequired,false);await decideOwnerAction({actor:f.actor,requestId:a.ownerRequestId!,decision:'ACCEPT'});
 const attempt=await beginAmendmentSettlement(c,a.id,crypto.randomUUID(),'CASH');await observeAmendmentSettlement(c,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',note:'Returned test cash'});await commitAmendment(c,a.id);
 const revision=await db.orderRevision.findUniqueOrThrow({where:{amendmentId:a.id}});assert.equal(revision.approverId,f.actor.id);
 const trace=await db.orderTrace.findFirstOrThrow({where:{amendmentId:a.id,action:'ORDER_AMENDED'}});assert.equal((trace.details as {authorization:{ownerApproverId:string}}).authorization.ownerApproverId,f.actor.id);
});
test('one external reference cannot confirm two amendments in the same cafe',async()=>{
 const f=await fixture('100','CARD'),a=await stageAmendment(f.actor,f.order.id,f.input('80'),crypto.randomUUID()),first=await beginAmendmentSettlement(f.actor,a.id,crypto.randomUUID(),'CARD');
 await observeAmendmentSettlement(f.actor,a.id,first.id,'CONFIRMED',{confirmed:true,reference:'same-provider-ref',note:''});await commitAmendment(f.actor,a.id);
 const next=f.input('60');next.baseRevision=1;const b=await stageAmendment(f.actor,f.order.id,next,crypto.randomUUID()),second=await beginAmendmentSettlement(f.actor,b.id,crypto.randomUUID(),'CARD');
 await assert.rejects(()=>observeAmendmentSettlement(f.actor,b.id,second.id,'CONFIRMED',{confirmed:true,reference:'same-provider-ref',note:''}),/مسجل/);assert.equal(await db.payment.count({where:{amendmentId:b.id}}),0);
});
test('card/wallet mixed refund requires separate confirmed references',async()=>{
 const f=await fixture('100','CARD'),original=await db.payment.findFirstOrThrow({where:{orderId:f.order.id}});await db.payment.update({where:{id:original.id},data:{amount:50}});await db.payment.create({data:{cafeId:f.cafe.id,branchId:f.branch.id,orderId:f.order.id,shiftId:f.shift.id,receivedById:f.actor.id,method:'WALLET',amount:50}});
 const a=await stageAmendment(f.actor,f.order.id,f.input('80'),crypto.randomUUID()),attempt=await beginAmendmentSettlement(f.actor,a.id,crypto.randomUUID(),'CARD');
 await assert.rejects(()=>observeAmendmentSettlement(f.actor,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'one-ref',note:''}),/مستقل/);
 await observeAmendmentSettlement(f.actor,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',references:{CARD:'card-ref',WALLET:'wallet-ref'},note:''});await commitAmendment(f.actor,a.id);assert.equal(await db.amendmentTenderReference.count({where:{attemptId:attempt.id}}),2);
});
test('manager can finish observed settlement after requester becomes inactive without new money',async()=>{
 const f=await fixture(),c=await cashier(f),a=await stageAmendment(c,f.order.id,f.input('100',{type:'PERCENT',value:'10'}),crypto.randomUUID());await approveAmendment(f.actor,a.id);await decideOwnerAction({actor:f.actor,requestId:a.ownerRequestId!,decision:'ACCEPT'});
 const attempt=await beginAmendmentSettlement(c,a.id,crypto.randomUUID(),'CASH');await observeAmendmentSettlement(c,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',note:'Returned test cash'});await db.user.update({where:{id:c.id},data:{isActive:false}});
 await commitAmendment(f.actor,a.id);await commitAmendment(f.actor,a.id);const movement=await db.payment.findFirstOrThrow({where:{amendmentId:a.id}});assert.equal(movement.receivedById,c.id);assert.equal(movement.shiftId,attempt.shiftId);assert.equal(await db.payment.count({where:{amendmentId:a.id}}),1);
});

test('authorized manager reconciles pending attempt for inactive cashier with evidence',async()=>{
 const f=await fixture(),c=await cashier(f),a=await stageAmendment(c,f.order.id,f.input('100',{type:'PERCENT',value:'10'}),crypto.randomUUID());await approveAmendment(f.actor,a.id);await decideOwnerAction({actor:f.actor,requestId:a.ownerRequestId!,decision:'ACCEPT'});
 const attempt=await beginAmendmentSettlement(c,a.id,crypto.randomUUID(),'CASH');await db.user.update({where:{id:c.id},data:{isActive:false}});
 await assert.rejects(()=>observeAmendmentSettlement(f.actor,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',note:''}));
 await observeAmendmentSettlement(f.actor,a.id,attempt.id,'CONFIRMED',{confirmed:true,reference:'',note:'Manager verified cash was returned; do not pay again'});await commitAmendment(f.actor,a.id);
 assert.equal(await db.payment.count({where:{amendmentId:a.id}}),1);const saved=await db.amendmentSettlement.findUniqueOrThrow({where:{id:attempt.id}});assert.equal((saved.evidence as {observingActorId:string}).observingActorId,f.actor.id);
});

test('revoked price override blocks staged unpaid commit and paid settlement start',async()=>{
 for(const paid of ['0','100']){const f=await fixture(paid),c=await cashier(f);await db.userPermissionOverride.create({data:{userId:c.id,permissionKey:'sales.override_price',allowed:true}});
 const a=await stageAmendment(c,f.order.id,f.input(paid==='0'?'1':'120'),crypto.randomUUID());await db.userPermissionOverride.update({where:{userId_permissionKey:{userId:c.id,permissionKey:'sales.override_price'}},data:{allowed:false}});
 await assert.rejects(()=>paid==='0'?commitAmendment(c,a.id):beginAmendmentSettlement(c,a.id,crypto.randomUUID(),'CASH'));assert.equal((await db.order.findUniqueOrThrow({where:{id:f.order.id}})).revision,0);assert.equal(await db.amendmentSettlement.count({where:{amendmentId:a.id}}),0);}
});

test('lowered discount limit requires fresh approval; revoked discount permission blocks commit',async()=>{
 const f=await fixture('0'),c=await cashier(f);await db.salesDiscountLimit.create({data:{userId:c.id,cafeId:f.cafe.id,maxAmount:20,maxPercent:20,updatedById:f.actor.id}});
 const a=await stageAmendment(c,f.order.id,f.input('100',{type:'PERCENT',value:'10'}),crypto.randomUUID());await db.salesDiscountLimit.update({where:{userId:c.id},data:{maxAmount:0,maxPercent:0}});await assert.rejects(()=>commitAmendment(c,a.id));await approveAmendment(f.actor,a.id);
 await db.userPermissionOverride.create({data:{userId:c.id,permissionKey:'pos.apply_discount',allowed:false}});await assert.rejects(()=>commitAmendment(c,a.id));assert.equal((await db.order.findUniqueOrThrow({where:{id:f.order.id}})).revision,0);
});
