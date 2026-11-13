import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {db,teardownTaggedCafe} from './helpers/db';
import {countCafe,countItem,type CountCafe} from './helpers/count';
import {as} from './helpers/http';
import {ensureCustodyForShift} from '@/lib/custody';
import {closeShiftWithSettlement} from '@/lib/cash-close';
const cafes:string[]=[];
after(async()=>{for(const id of cafes){
 await db.handoverStockAcknowledgement.deleteMany({where:{handover:{cafeId:id}}});
 await db.handoverStockBoundary.deleteMany({where:{handover:{cafeId:id}}});
 await db.handoverRequiredItem.updateMany({where:{handover:{cafeId:id}},data:{satisfiedByLineId:null}});
 await db.handoverSession.updateMany({where:{cafeId:id},data:{stockCountSessionId:null,acceptedStockCountSessionId:null}});
 await db.stockCountSession.updateMany({where:{cafeId:id},data:{handoverId:null,lockedByHandoverId:null,accountabilityContext:'NONE'}});
 await db.stockCountRebase.deleteMany({where:{session:{cafeId:id}}});
 await db.stockVarianceSpanCustody.deleteMany({where:{span:{varianceCase:{cafeId:id}}}});
 await db.stockVarianceSpan.deleteMany({where:{varianceCase:{cafeId:id}}});
 await db.varianceCase.deleteMany({where:{cafeId:id}});
 await db.stockCountSession.deleteMany({where:{cafeId:id}});
 await db.inventoryFreeze.deleteMany({where:{cafeId:id}});
 // v2 (C1): a sheet dispute opens a review row, which must go before its handover.
 await db.stockHandoverReview.deleteMany({where:{cafeId:id}});
 await db.handoverSession.deleteMany({where:{cafeId:id}});
 await teardownTaggedCafe(id);
}await db.$disconnect();});
async function shift(fx:CountCafe,userId:string,n:number){const s=await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:userId,shiftNumber:n,openingCashAmount:100,expectedCashAmount:100}});await db.$transaction(tx=>ensureCustodyForShift(tx,{cafeId:fx.cafeId,branchId:fx.branchId,shiftId:s.id,userId,openingCashAmount:100}));return s;}
async function post<T=Record<string,unknown>>(email:string,path:string,body:unknown){const r=await as<T>(email,path,{method:'POST',body:JSON.stringify(body)});assert.equal(r.status,200,`${path}: ${r.text}`);return r.body;}
test('actual HTTP journeys: matching handover and recorded outgoing difference complete with distinct receiving evidence',async()=>{
for(const scenario of ["match","outgoing-difference","receiving-difference"]){
 const difference=scenario==="outgoing-difference"; const incomingDifference=scenario==="receiving-difference";
 const fx=await countCafe(difference?'HNDHTTPDIFF':'HNDHTTPMATCH');cafes.push(fx.cafeId);
 await db.cafeSettings.update({where:{cafeId:fx.cafeId},data:{stockCountPolicy:'HYBRID',handoverCountType:'CRITICAL',periodicFullCountSchedule:'MANUAL_ONLY',recountRequiredOutsideTolerance:false,varianceBlocksHandover:false}});
 await countItem(fx,'Alpha',{stock:10,isCritical:true});await countItem(fx,'Beta',{stock:0,isCritical:true});
 const outgoing=await shift(fx,fx.cashier.id,1);
 const closed=await closeShiftWithSettlement({shiftId:outgoing.id,actualCash:100,actorId:fx.cashier.id,closedByManager:false,handoverTarget:'SHIFT_TO_SHIFT',grants:{handoverSubmit:true,handoverException:true}});assert.ok(closed.handoverId);
 const hid=closed.handoverId!;
 const start=await post<{countSession:{id:string}}>(fx.cashier.email,'/api/handovers',{action:'start_count',handoverId:hid});const sid=start.countSession.id;
 const detail=await as<{session:{blind:boolean;lines:{id:string;inventoryItem:{name:string};expectedQuantity?:unknown}[]}}>(fx.cashier.email,`/api/stock-counts/${sid}`);assert.equal(detail.status,200);assert.equal(detail.body.session.blind,true);assert.ok(detail.body.session.lines.every(l=>!('expectedQuantity'in l)));
 for(const line of detail.body.session.lines){const q=line.inventoryItem.name.endsWith('Alpha')?(difference?9:10):0;const r=await as(fx.cashier.email,`/api/stock-counts/${sid}/lines/${line.id}`,{method:'PATCH',body:JSON.stringify({countedQuantity:q,expectedCountedAt:null})});assert.equal(r.status,200,r.text);}
 const submitted=await post<{status:string;systemValidated?:boolean}>(fx.cashier.email,`/api/stock-counts/${sid}/submit`,{});
 // HND-UX-004: the outgoing difference is recorded and continues with no
 // manager; it is never a system match and carries no signature. The cashier
 // still cannot use the manager confirm route.
 if(difference){assert.equal(submitted.status,'CONFIRMED');assert.equal(submitted.systemValidated,false);
  const no=await as(fx.cashier.email,`/api/stock-counts/${sid}/confirm`,{method:'POST',body:'{}'});assert.equal(no.status,403);
  const session=await db.stockCountSession.findUniqueOrThrow({where:{id:sid}});assert.equal(session.confirmedById,null);
  assert.equal(await db.auditLog.count({where:{entityId:sid,action:'COUNT_OUTGOING_DECLARED'}}),1);
 }else{assert.equal(submitted.status,'CONFIRMED');assert.equal(submitted.systemValidated,true);assert.equal((await db.stockCountSession.findUniqueOrThrow({where:{id:sid}})).confirmedById,null);}
 await post(fx.cashier.email,'/api/handovers',{action:'submit',handoverId:hid});
 // A fresh synthetic incoming employee, with the same cashier permissions.
 const incoming=await db.user.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,email:`incoming-${fx.marker.toLowerCase()}@example.invalid`,name:'Synthetic incoming',role:'CASHIER',passwordHash:(await db.user.findUniqueOrThrow({where:{id:fx.cashier.id}})).passwordHash}});
 const {login}=await import('./helpers/http');await login(incoming.email,'count-fixture-1234');await shift(fx,incoming.id,2);
 const view=await as<{handover:{count:{sessionId:string;countVersion:string;systemValidated:boolean;lines:{id:string;inventoryItem:{name:string}}[]}}}>(incoming.email,`/api/handovers/${hid}`);assert.equal(view.status,200,view.text);assert.equal(view.body.handover.count.systemValidated,!difference);
 const count=view.body.handover.count;const decisions=count.lines.map(l=>({stockCountLineId:l.id,incomingCountedQuantity:l.inventoryItem.name.endsWith('Alpha')?(incomingDifference?8:difference?9:10):null}));
 if(incomingDifference){const reason=await db.reasonCode.create({data:{cafeId:fx.cafeId,domain:'HANDOVER',code:'RECEIVING',label:'Synthetic receiving difference'}});for(const line of decisions)Object.assign(line,{disputeReasonCodeId:reason.id});}
 const body={countSessionId:sid,countVersion:count.countVersion,lines:decisions,idempotencyKey:crypto.randomUUID()};
 await post(incoming.email,`/api/handovers/${hid}/acknowledge`,body);await post(incoming.email,`/api/handovers/${hid}/acknowledge`,body);
 // v2 (Plan: "no signature / dispute ... refusal"): the disputed handover completes,
 // and the dispute itself reaches the v2 comparison, the notifications and the review.
 if(incomingDifference){const done=await post<{status:string}>(incoming.email,`/api/handovers/${hid}/accept`,{idempotencyKey:crypto.randomUUID(),countedOpeningCash:100});assert.equal(done.status,'COMPLETED');
  assert.equal((await db.handoverStockAcknowledgement.findMany({where:{handoverId:hid}})).filter(a=>a.decision==='DISPUTED').length,1,'the refusal is still recorded as a refusal');
  const cmp=await db.stockHandoverComparison.findFirst({where:{handoverId:hid},orderBy:{computedAt:'desc'}});assert.equal((cmp?.lines as {disputedCount?:number}|null)?.disputedCount,1,'the dispute reaches the v2 comparison');
  const told=await db.notification.findMany({where:{handoverId:hid,kind:'STOCK_HANDOVER_DISCREPANCY'}});assert.ok(told.some(n=>n.recipientId===fx.owner.id)&&told.some(n=>n.recipientId===fx.manager.id),'the owner and the manager are notified');
  assert.ok(await db.stockHandoverReview.findUnique({where:{handoverId:hid}}),'the dispute opens a review');
  assert.equal(Number((await db.inventoryItem.findFirstOrThrow({where:{branchId:fx.branchId,name:{endsWith:'Alpha'}}})).currentStock),10,'the disputed figure is never posted');
  console.log(`HTTP DISPUTE PASS: dispute reported, handover completed ${hid}`);continue;}
 const accepted=await post<{status:string}>(incoming.email,`/api/handovers/${hid}/accept`,{idempotencyKey:crypto.randomUUID(),countedOpeningCash:100});assert.equal(accepted.status,'COMPLETED');
 const end=await db.handoverSession.findUniqueOrThrow({where:{id:hid}});assert.equal(end.incomingUserId,incoming.id);assert.equal(await db.inventoryFreeze.count({where:{handoverId:hid,releasedAt:null}}),0);
 console.log(`HTTP JOURNEY PASS: ${difference?'recorded shortage':'system-validated match'} ${hid}`);
}
});
