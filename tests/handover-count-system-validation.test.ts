import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tag, assertTestDatabase, teardownTaggedCafe } from './helpers/db';
import { recordCountLine, submitCountSession, createCountCorrection, confirmCountSession } from '@/lib/stock-count';
import { lockHandoverCount, systemValidationIsCurrent } from '@/lib/handover-count-validation';

const cafes:string[]=[];
after(async()=>{await db.handoverStockAcknowledgement.deleteMany({where:{handover:{cafeId:{in:cafes}}}});await teardownTaggedCafe(cafes);await db.$disconnect();});
async function fixture(quantities=[10], mode:'SELECTED'|'FULL'='SELECTED') {
 await assertTestDatabase(); const marker=tag('HNDMATCH');
 const cafe=await db.cafe.create({data:{name:marker,slug:marker.toLowerCase(),settings:{create:{recountRequiredOutsideTolerance:false}},branches:{create:{name:marker}}},include:{branches:true}});cafes.push(cafe.id);
 const branch=cafe.branches[0];
 const actor=await db.user.create({data:{cafeId:cafe.id,branchId:branch.id,email:`${marker}@test.invalid`,name:marker,passwordHash:'synthetic-no-login',role:'CASHIER'}});
 const shift=await db.shift.create({data:{cafeId:cafe.id,branchId:branch.id,cashierId:actor.id,shiftNumber:1,status:'AWAITING_HANDOVER',financiallyClosedAt:new Date(),openingCashAmount:0,expectedCashAmount:0}});
 const custody=await db.custodyPeriod.create({data:{cafeId:cafe.id,branchId:branch.id,scope:'STOCK',responsibleShiftId:shift.id}});
 const items=await Promise.all(quantities.map((stock,i)=>db.inventoryItem.create({data:{cafeId:cafe.id,branchId:branch.id,name:`${marker}-${i}`,unit:'KG',currentStock:stock,costPerUnit:0}})));
 const handover=await db.handoverSession.create({data:{cafeId:cafe.id,branchId:branch.id,outgoingUserId:actor.id,outgoingShiftId:shift.id,outgoingStockCustodyId:custody.id,target:'SHIFT_TO_SHIFT',stockMode:mode,requiredItemTrigger:mode==='FULL'?'PERIODIC_DAILY':'REGULAR_MODE',requiredItemCount:items.length,
 requiredItems:{create:items.map(i=>({inventoryItemId:i.id,itemNameSnapshot:i.name,unitSnapshot:i.unit,isCriticalSnapshot:false}))}}});
 await db.inventoryFreeze.create({data:{cafeId:cafe.id,branchId:branch.id,handoverId:handover.id,startedById:actor.id}});
 const session=await db.stockCountSession.create({data:{cafeId:cafe.id,branchId:branch.id,shiftId:shift.id,custodyPeriodId:custody.id,handoverId:handover.id,accountabilityContext:'HANDOVER',initiatedById:actor.id,type:mode==='FULL'?'FULL':'CRITICAL',scopeDerivation:mode==='FULL'?'ALL_ELIGIBLE':'CRITICAL_ONLY',lines:{create:items.map(i=>({inventoryItemId:i.id,unit:i.unit}))}},include:{lines:{orderBy:{inventoryItem:{name:'asc'}}}}});
 await db.handoverSession.update({where:{id:handover.id},data:{stockCountSessionId:session.id}});
 await db.toleranceRule.create({data:{cafeId:cafe.id,branchId:branch.id,scope:'BRANCH',quantityTolerance:1}});
 const capture=(index:number,quantity:number,expectedCountedAt?:string|null)=>recordCountLine({sessionId:session.id,lineId:session.lines[index].id,countedQuantity:quantity,counterId:actor.id,cafeId:cafe.id,viewerBranchId:branch.id,expectedCountedAt});
 const submit=()=>submitCountSession({sessionId:session.id,submittedById:actor.id,cafeId:cafe.id,viewerBranchId:branch.id});
 return {cafe,branch,actor,items,session,handover,capture,submit};
}
test('complete matching selected and scheduled full counts get truthful exactly-once system validation',async()=>{
 for(const mode of ['SELECTED','FULL'] as const){const fx=await fixture([0,1.234],mode);await fx.capture(0,0,null);await fx.capture(1,1.234,null);
 const results=await Promise.all([fx.submit(),fx.submit()]);assert.ok(results.every(r=>r.status==='CONFIRMED'&&r.systemValidated));
 const session=await db.stockCountSession.findUniqueOrThrow({where:{id:fx.session.id}});assert.equal(session.confirmedById,null);
 const audits=await db.auditLog.findMany({where:{entityId:fx.session.id,action:'COUNT_SYSTEM_VALIDATED'}});assert.equal(audits.length,1);assert.equal(audits[0].userId,fx.actor.id);
 assert.equal((audits[0].details as {validation:string}).validation,'SYSTEM_MATCHING_QUANTITIES');
 assert.equal(await db.$transaction(async tx=>{await lockHandoverCount(tx,fx.session.id);return systemValidationIsCurrent(tx,fx.session.id);}),true,'persisted jsonb evidence validates on the next transaction');
 }});
// HND-UX-004 replaced "a difference waits for manager review": a complete,
// current count with differences is recorded as the outgoing declaration and
// continues. It is still never a match, and opposite differences are not netted.
test('shortage, surplus and opposite differences are recorded, never validated as matching, even inside tolerance and with zero cost',async()=>{
 for(const counts of [[9.999],[10.001],[9.5,10.5]]) {const fx=await fixture(counts.map(()=>10));for(let i=0;i<counts.length;i++)await fx.capture(i,counts[i],null);const result=await fx.submit();
  assert.equal(result.status,'CONFIRMED');assert.equal(result.systemValidated,false);assert.equal(result.recordedDifferences,counts.length);
  const session=await db.stockCountSession.findUniqueOrThrow({where:{id:fx.session.id},include:{lines:true}});assert.equal(session.confirmedById,null);
  assert.equal(await db.auditLog.count({where:{entityId:fx.session.id,action:'COUNT_SYSTEM_VALIDATED'}}),0);
  assert.equal(await db.auditLog.count({where:{entityId:fx.session.id,action:'COUNT_OUTGOING_DECLARED'}}),1);
  assert.deepEqual(session.lines.map(l=>Number(l.varianceQuantity)).sort((a,b)=>a-b),counts.map(c=>Math.round((c-10)*1000)/1000).sort((a,b)=>a-b),'each difference stays its own');}
});
test('missing count, stale cursor and pending corrections cannot be automatically validated',async()=>{
 const missing=await fixture([10,10]);await missing.capture(0,10,null);assert.notEqual((await missing.submit()).status,'CONFIRMED');
 const stale=await fixture();await stale.capture(0,10,null);await db.inventoryItem.update({where:{id:stale.items[0].id},data:{ledgerVersion:{increment:1}}});assert.notEqual((await stale.submit()).status,'CONFIRMED');
 const pending=await fixture();await pending.capture(0,10,null);const reason=await db.reasonCode.create({data:{cafeId:pending.cafe.id,domain:'STOCK',code:'TEST',label:'synthetic'}});
 await createCountCorrection({lineId:pending.session.lines[0].id,newCountedQuantity:11,reasonCodeId:reason.id,actorId:pending.actor.id,cafeId:pending.cafe.id});assert.notEqual((await pending.submit()).status,'CONFIRMED');
});
test('capture retries and concurrent stale edits preserve the latest observation without duplicate audit',async()=>{
 const fx=await fixture();const first=await fx.capture(0,9,null);const retry=await fx.capture(0,9,null);assert.equal(retry.countedAt.toISOString(),first.countedAt.toISOString());
 await assert.rejects(fx.capture(0,8,null),e=>(e as {status:number}).status===409);
 const outcomes=await Promise.allSettled([fx.capture(0,10,first.countedAt.toISOString()),fx.capture(0,11,first.countedAt.toISOString())]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(await db.auditLog.count({where:{entityId:fx.session.lines[0].id,action:'ITEM_COUNTED'}}),2);
});
test('current permission denial and branch/tenant scope prevent matching validation',async()=>{
 const fx=await fixture();await fx.capture(0,10,null);
 await assert.rejects(submitCountSession({sessionId:fx.session.id,submittedById:fx.actor.id,cafeId:'other-tenant'}),e=>(e as {status:number}).status===404);
 await assert.rejects(submitCountSession({sessionId:fx.session.id,submittedById:fx.actor.id,cafeId:fx.cafe.id,viewerBranchId:'other-branch'}),e=>(e as {status:number}).status===403);
 await db.userPermissionOverride.create({data:{userId:fx.actor.id,permissionKey:'stock_count.submit',allowed:false}});
 await assert.rejects(fx.submit(),e=>(e as {status:number}).status===403);
});

test('manager-only confirmation, disputed receipts and altered required snapshots never enter the matching shortcut',async()=>{
 const fx=await fixture();await fx.capture(0,10,null);
 await db.handoverStockAcknowledgement.create({data:{handoverId:fx.handover.id,stockCountLineId:fx.session.lines[0].id,incomingCountedQuantity:9,handedOverQuantity:10,varianceQuantity:-1,decision:'DISPUTED',acknowledgedById:fx.actor.id}});
 assert.notEqual((await fx.submit()).status,'CONFIRMED');
 const {confirmCountSession}=await import('@/lib/stock-count');
 await assert.rejects(confirmCountSession({sessionId:fx.session.id,confirmedById:fx.actor.id,idempotencyKey:'forbidden-test'}),e=>(e as {status:number}).status===403);
 const altered=await fixture();await altered.capture(0,10,null);await db.handoverSession.update({where:{id:altered.handover.id},data:{requiredItemCount:2}});assert.notEqual((await altered.submit()).status,'CONFIRMED');
});
test('a correction requested after automatic validation invalidates that active result',async()=>{
 const fx=await fixture();await fx.capture(0,10,null);assert.equal((await fx.submit()).status,'CONFIRMED');
 const reason=await db.reasonCode.create({data:{cafeId:fx.cafe.id,domain:'STOCK',code:'AFTER',label:'synthetic'}});
 await createCountCorrection({lineId:fx.session.lines[0].id,newCountedQuantity:9,reasonCodeId:reason.id,actorId:fx.actor.id,cafeId:fx.cafe.id});
 assert.equal((await db.stockCountSession.findUniqueOrThrow({where:{id:fx.session.id}})).status,'SUBMITTED');
 assert.notEqual((await fx.submit()).status,'CONFIRMED');
});

test('branchless staff cannot system-validate a handover count',async()=>{
 const fx=await fixture();await fx.capture(0,10,null);await db.user.update({where:{id:fx.actor.id},data:{branchId:null}});
 await assert.rejects(fx.submit(),e=>(e as {status:number}).status===403);
});
test('a signed current count must use a new recount round before correction',async()=>{
 const fx=await fixture();await fx.capture(0,10,null);await fx.submit();
 await db.handoverStockAcknowledgement.create({data:{handoverId:fx.handover.id,stockCountLineId:fx.session.lines[0].id,handedOverQuantity:10,decision:'ACCEPTED',acknowledgedById:fx.actor.id}});
 const reason=await db.reasonCode.create({data:{cafeId:fx.cafe.id,domain:'STOCK',code:'SIGNED',label:'synthetic'}});
 await assert.rejects(createCountCorrection({lineId:fx.session.lines[0].id,newCountedQuantity:9,reasonCodeId:reason.id,actorId:fx.actor.id,cafeId:fx.cafe.id}),e=>(e as {status:number}).status===409&&/إعادة الجرد/.test((e as Error).message));
 assert.equal(await db.stockCountCorrection.count({where:{lineId:fx.session.lines[0].id}}),0);
});

// HND-UX-004: a recorded difference carries no signature at all — not the
// counter's as a manager, and not a manager's added afterwards by a replayed
// confirmation. A gap (missing count) still waits for a manager.
test('a recorded quantity difference carries no manager signature, and a later confirm does not add one',async()=>{
 const fx=await fixture();await fx.capture(0,9.999,null);assert.equal((await fx.submit()).status,'CONFIRMED');
 const manager=await db.user.create({data:{cafeId:fx.cafe.id,branchId:fx.branch.id,name:'synthetic manager',email:`${fx.cafe.id}-manager@test.invalid`,passwordHash:'synthetic-no-login',role:'BRANCH_MANAGER'}});
 const replay=await confirmCountSession({sessionId:fx.session.id,confirmedById:manager.id,idempotencyKey:`test-manager-${fx.session.id}`,cafeId:fx.cafe.id,viewerBranchId:fx.branch.id});
 assert.equal(replay.alreadyConfirmed,true);
 const confirmed=await db.stockCountSession.findUniqueOrThrow({where:{id:fx.session.id}});assert.equal(confirmed.status,'CONFIRMED');assert.equal(confirmed.confirmedById,null);
 assert.equal(await db.auditLog.count({where:{entityId:fx.session.id,action:'COUNT_SYSTEM_VALIDATED'}}),0);
 const gap=await fixture([10,10]);await gap.capture(0,9,null);assert.notEqual((await gap.submit()).status,'CONFIRMED','a count with a gap is not a declaration');
});

test('submission replay rejects system evidence made stale after validation',async()=>{
 const fx=await fixture();await fx.capture(0,10,null);assert.equal((await fx.submit()).status,'CONFIRMED');
 await db.inventoryItem.update({where:{id:fx.items[0].id},data:{ledgerVersion:{increment:1}}});
 await assert.rejects(fx.submit(),e=>(e as {status:number}).status===409);
});
