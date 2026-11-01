import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { db, teardownTaggedCafe } from './helpers/db';
import { countCafe, countItem, type CountCafe } from './helpers/count';
import { as } from './helpers/http';
let fx:CountCafe,foreign:CountCafe;
const at=new Date('2026-10-04T07:00:00Z');
type Row={id:string;incomingEmployee:{id:string}|null;nightEmployee:{id:string}|null;expectedAmount:number|null;countedAmount:number|null;variance:number|null;cashStatus:string;events:Array<{action:string;actor:{id:string};at:string}>;stockStatus:string;placeStatus:string};
before(async()=>{
  fx=await countCafe('OVERNIGHT003');foreign=await countCafe('OVERNIGHT003-FOREIGN');
  await countItem(fx,'Required stock',{stock:10,isCritical:true});
  for(const [i,counted,status] of [[1,500,'ACCEPTED'],[2,450,'ACCEPTED'],[3,null,'DEFERRED']] as const){
    const outgoing=await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.manager.id,shiftNumber:i*2,status:'CLOSED',closedAt:at,openedAt:at,openingCashAmount:800,expectedCashAmount:800,actualCashAmount:800}});
    const h=await db.handoverSession.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,outgoingShiftId:outgoing.id,outgoingUserId:fx.manager.id,target:'BRANCH_CUSTODY',resolvedTarget:'BRANCH_CUSTODY',status:'COMPLETED',completedAt:at}});
    const storage=await db.cashStorage.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,outgoingShiftId:outgoing.id,handoverId:h.id,closingAmount:800,leftInDrawer:500,toTreasury:300,drawerLabel:'Night drawer',declaredById:fx.manager.id,declaredAt:at}});
    const incoming=await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.cashier.id,shiftNumber:i*2+1,status:'CLOSED',closedAt:at,openedAt:at,openingCashAmount:counted??0,expectedCashAmount:counted??0}});
    await db.openingCashReceipt.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,storageId:storage.id,incomingShiftId:incoming.id,claimantId:fx.cashier.id,status,expectedAmount:500,actualAmount:counted,varianceAmount:counted===null?null:counted-500,acceptedAt:counted===null?null:at,verifiedById:counted===null?null:fx.cashier.id,claimedAt:at,events:{create:{cafeId:fx.cafeId,actorId:fx.cashier.id,action:counted===null?'DEFER':'ACCEPTED',note:'Named receipt evidence',createdAt:at}}}});
  }
  await db.shift.createMany({data:Array.from({length:550},(_,i)=>({cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.cashier.id,shiftNumber:100+i,status:'CLOSED' as const,closedAt:at,openedAt:at,openingCashAmount:0,expectedCashAmount:0}))});
});
after(async()=>{if(fx)await teardownTaggedCafe(fx.cafeId);if(foreign)await teardownTaggedCafe(foreign.cafeId);await db.$disconnect();});
test('report includes matching, short and deferred cash receipts with named evidence',async()=>{
  const result=await as<{rows:Row[]}>(fx.owner.email,'/api/reports/opening-receipts?range=custom_day&date=2026-10-04');assert.equal(result.status,200,result.text);
  const receipts=result.body.rows.filter(r=>r.expectedAmount===500);assert.equal(receipts.length,3);
  assert.ok(receipts.some(r=>r.cashStatus==='ACCEPTED'&&r.variance===0&&r.countedAmount===500));
  assert.ok(receipts.some(r=>r.variance===-50&&r.countedAmount===450));
  const deferred=receipts.find(r=>r.cashStatus==='DEFERRED')!;assert.equal(deferred.countedAmount,null);assert.equal(deferred.events[0].action,'DEFER');assert.equal(deferred.events[0].actor.id,fx.cashier.id);
  for(const r of receipts){assert.equal(r.incomingEmployee?.id,fx.cashier.id);assert.equal(r.nightEmployee?.id,fx.manager.id);}
});
test('monthly report spans multiple batches and leaves missing historical declarations unknown',async()=>{
  const result=await as<{rows:Row[]}>(fx.owner.email,'/api/reports/opening-receipts?range=custom_range&from=2026-10-01&to=2026-10-31');assert.equal(result.status,200,result.text);
  const historical=result.body.rows.filter(r=>r.cashStatus==='NOT_DECLARED');assert.ok(historical.length>=550);
  for(const r of historical){assert.equal(r.expectedAmount,null);assert.equal(r.countedAmount,null);assert.equal(r.variance,null);assert.notEqual(r.placeStatus,'ACCEPTED');}
});
test('scope and Cairo date filters refuse foreign branches, employees and invalid dates',async()=>{
  const cross=await as(fx.manager.email,'/api/reports/opening-receipts?branchId='+fx.otherBranchId);assert.equal(cross.status,403,cross.text);
  const employee=await as(fx.owner.email,'/api/reports/opening-receipts?employeeId='+foreign.cashier.id);assert.equal(employee.status,400,employee.text);
  const other=await as<{rows:unknown[]}>(foreign.owner.email,'/api/reports/opening-receipts?range=custom_day&date=2026-10-04');assert.equal(other.status,200,other.text);assert.equal(other.body.rows.length,0);
  const prior=await as<{rows:unknown[]}>(fx.owner.email,'/api/reports/opening-receipts?range=custom_day&date=2026-10-03');assert.equal(prior.status,200,prior.text);assert.equal(prior.body.rows.length,0);
  const invalid=await as(fx.owner.email,'/api/reports/opening-receipts?range=custom_day&date=2026-02-31');assert.equal(invalid.status,400,invalid.text);
});
test('verified direct shift-to-shift cash acceptance appears as acceptance rather than missing history',async()=>{
  const outgoing=await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.manager.id,shiftNumber:900,status:'CLOSED',closedAt:at,openedAt:at,openingCashAmount:500,actualCashAmount:500}});
  const incoming=await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.cashier.id,shiftNumber:901,status:'CLOSED',closedAt:at,openedAt:at,openingCashAmount:500}});
  await db.handoverSession.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,outgoingShiftId:outgoing.id,outgoingUserId:fx.manager.id,incomingShiftId:incoming.id,incomingUserId:fx.cashier.id,target:'SHIFT_TO_SHIFT',resolvedTarget:'SHIFT_TO_SHIFT',status:'COMPLETED',completedAt:at,acceptedAt:at,cashVerifiedAt:at,cashVerifiedById:fx.cashier.id,proposedOpeningCash:500,countedOpeningCash:500,cashVarianceAmount:0}});
  const result=await as<{rows:Array<Row&{shift:{id:string}|null}>}>(fx.owner.email,'/api/reports/opening-receipts?range=custom_day&date=2026-10-04');assert.equal(result.status,200,result.text);
  const row=result.body.rows.find(r=>r.shift?.id===incoming.id)!;assert.equal(row.cashStatus,'ACCEPTED');assert.equal(row.countedAmount,500);assert.equal(row.variance,0);assert.equal(row.events[0].actor.id,fx.cashier.id);
});
test('only owner enables the branch drawer setting; cashier may read its operational requirement',async()=>{
  const route=`/api/branches/${fx.branchId}/opening-settings`;
  const denied=await as(fx.manager.email,route,{method:'PATCH',body:JSON.stringify({overnightCashEnabled:true,drawerLabel:'Night drawer'})});assert.equal(denied.status,403,denied.text);
  await db.cafeSettings.update({where:{cafeId:fx.cafeId},data:{stockCountPolicy:'HYBRID',handoverCountType:'CRITICAL',periodicFullCountSchedule:'MANUAL_ONLY'}});
  const owner=await as(fx.owner.email,route,{method:'PATCH',body:JSON.stringify({overnightCashEnabled:true,drawerLabel:'Night drawer'})});assert.equal(owner.status,200,owner.text);
  const cashier=await as<{settings:{overnightCashEnabled:boolean}}>(fx.cashier.email,route);assert.equal(cashier.status,200,cashier.text);assert.equal(cashier.body.settings.overnightCashEnabled,true);
  const foreignScope=await as(foreign.owner.email,route);assert.equal(foreignScope.status,403,foreignScope.text);
});
