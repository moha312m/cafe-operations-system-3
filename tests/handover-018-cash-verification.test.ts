import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tag, assertTestDatabase, teardownTaggedCafe } from './helpers/db';
const marker=tag('CASHHANDOVER');
let cafeId:string, branchId:string, outgoingId:string, incomingId:string, reasonCodeId:string, invalidReasonId:string;
before(async()=>{
  await assertTestDatabase();
  cafeId=(await db.cafe.create({data:{name:marker,slug:marker.toLowerCase(),settings:{create:{}}}})).id;
  branchId=(await db.branch.create({data:{cafeId,name:marker}})).id;
  outgoingId=(await db.user.create({data:{cafeId,branchId,role:'CASHIER',name:'Outgoing',email:marker+'a@example.invalid',passwordHash:'unused'}})).id;
  incomingId=(await db.user.create({data:{cafeId,branchId,role:'CASHIER',name:'Incoming',email:marker+'b@example.invalid',passwordHash:'unused'}})).id;
  reasonCodeId=(await db.reasonCode.create({data:{cafeId,domain:'HANDOVER',code:marker,label:'Cash received short',isActive:true}})).id;
  invalidReasonId=(await db.reasonCode.create({data:{cafeId,domain:'CASH',code:marker+'wrong',label:'Not a handover reason',isActive:true}})).id;
});
after(async()=>teardownTaggedCafe(cafeId,[],{disconnect:true}));
let number=0;
async function fixture(){
  await db.handoverSession.updateMany({where:{branchId},data:{status:'COMPLETED',completedAt:new Date()}});
  await db.shift.updateMany({where:{branchId,status:'OPEN'},data:{status:'CLOSED',closedAt:new Date()}});
  const outgoing=await db.shift.create({data:{cafeId,branchId,cashierId:outgoingId,shiftNumber:++number,status:'AWAITING_HANDOVER',openingCashAmount:500,expectedCashAmount:693.8,actualCashAmount:668.8,financiallyClosedAt:new Date()}});
  const incoming=await db.shift.create({data:{cafeId,branchId,cashierId:incomingId,shiftNumber:++number,openingCashAmount:638.8,expectedCashAmount:638.8,custodyGateReason:'AWAITING_CUSTODY_TRANSFER'}});
  const h=await db.handoverSession.create({data:{cafeId,branchId,outgoingShiftId:outgoing.id,outgoingUserId:outgoingId,incomingUserId:incomingId,status:'INCOMING_REVIEW',target:'SHIFT_TO_SHIFT'}});
  return {h,incoming,outgoing};
}
async function record(handoverId:string,incomingShiftId:string,extra={}){
  const lib=await import('@/lib/cash-handover');
  return db.$transaction(tx=>lib.recordCashHandover(tx,{handoverId,incomingShiftId,incomingUserId:incomingId,at:new Date(),...extra}));
}
test('cash shortage accepts no reason or note and keeps both observations plus an unresolved case',async()=>{
  const {h,incoming,outgoing}=await fixture();
  const result=await record(h.id,incoming.id);
  assert.deepEqual([result.proposed,result.counted,result.variance],[668.8,638.8,-30]);
  const actual=await db.handoverSession.findUniqueOrThrow({where:{id:h.id}});
  assert.equal(Number(actual.proposedOpeningCash),668.8);
  assert.equal(Number(actual.countedOpeningCash),638.8);
  assert.equal(Number(actual.cashVarianceAmount),-30);
  assert.equal(actual.cashVerifiedById,incomingId);
  const c=await db.varianceCase.findFirstOrThrow({where:{acceptedHandoverId:h.id,type:'OPENING_EXCEPTION'}});
  assert.equal(c.status,'OPEN');
  assert.equal(c.assignedResponsibilityUserId,null);
  assert.equal(Number(c.amountVariance),-30);
  const observation=await db.openingException.findUniqueOrThrow({where:{id:c.openingExceptionId!}});
  assert.equal(observation.reasonCodeId,null);
  assert.equal(observation.note,null);
  assert.equal(observation.authorizedById,incomingId);
  const opening=await db.shift.findUniqueOrThrow({where:{id:incoming.id}});
  assert.deepEqual([Number(opening.openingCashAmount),Number(opening.expectedCashAmount)],[638.8,638.8]);
  assert.equal(Number((await db.shift.findUniqueOrThrow({where:{id:outgoing.id}})).actualCashAmount),668.8);
  const {loadEmployeeVariances}=await import('@/lib/employee-variance-report');
  const report=await loadEmployeeVariances({cafeId,branchId,from:new Date(0),to:new Date(),handoverId:h.id});
  const row=report.rows.find(r=>r.id===c.id)!;
  assert.ok(row,'the unexplained receipt difference must remain reportable');
  assert.deepEqual([row.category,row.expected,row.actual,row.variance,row.reason],['HANDOVER_CASH',668.8,638.8,-30,null]);
  assert.equal(row.assignedResponsibility,null);
});
test('cash shortage preserves an optional reason and note without assigning responsibility',async()=>{
  const {h,incoming}=await fixture();
  await record(h.id,incoming.id,{cashReasonCodeId:reasonCodeId,cashReasonNote:'30 missing at receipt'});
  const c=await db.varianceCase.findFirstOrThrow({where:{acceptedHandoverId:h.id}});
  const observation=await db.openingException.findUniqueOrThrow({where:{id:c.openingExceptionId!}});
  assert.equal(observation.reasonCodeId,reasonCodeId);
  assert.equal(observation.note,'30 missing at receipt');
  assert.equal(c.assignedResponsibilityUserId,null);
});
test('matching receipt aligns opening cash and opens no variance case without a reason',async()=>{
  const {h,incoming}=await fixture();
  await record(h.id,incoming.id,{countedOpeningCash:668.8});
  const shift=await db.shift.findUniqueOrThrow({where:{id:incoming.id}});
  assert.deepEqual([Number(shift.openingCashAmount),Number(shift.expectedCashAmount)],[668.8,668.8]);
  assert.equal(await db.varianceCase.count({where:{acceptedHandoverId:h.id}}),0);
});
test('cash surplus is recorded without a reason or note',async()=>{
  const {h,incoming}=await fixture();
  const result=await record(h.id,incoming.id,{countedOpeningCash:700});
  assert.equal(result.variance,31.2);
  const c=await db.varianceCase.findUniqueOrThrow({where:{id:result.caseId!}});
  assert.equal(Number(c.amountVariance),31.2);
  assert.equal(c.status,'OPEN');
  assert.equal(c.assignedResponsibilityUserId,null);
});
test('a receipt note may be supplied without a reason code',async()=>{
  const {h,incoming}=await fixture();
  const result=await record(h.id,incoming.id,{cashReasonNote:'  counted twice  '});
  const c=await db.varianceCase.findUniqueOrThrow({where:{id:result.caseId!}});
  const observation=await db.openingException.findUniqueOrThrow({where:{id:c.openingExceptionId!}});
  assert.equal(observation.reasonCodeId,null);
  assert.equal(observation.note,'counted twice');
});
test('a receipt reason may be supplied without a note',async()=>{
  const {h,incoming}=await fixture();
  const result=await record(h.id,incoming.id,{cashReasonCodeId:reasonCodeId});
  const c=await db.varianceCase.findUniqueOrThrow({where:{id:result.caseId!}});
  const observation=await db.openingException.findUniqueOrThrow({where:{id:c.openingExceptionId!}});
  assert.equal(observation.reasonCodeId,reasonCodeId);
  assert.equal(observation.note,null);
});
test('a supplied invalid reason still refuses the receipt transaction without partial records',async()=>{
  const {h,incoming}=await fixture();
  await assert.rejects(()=>record(h.id,incoming.id,{cashReasonCodeId:invalidReasonId,cashReasonNote:'test'}),(err:{status?:number})=>err.status===400);
  assert.equal((await db.handoverSession.findUniqueOrThrow({where:{id:h.id}})).cashVerifiedAt,null);
  assert.equal(await db.varianceCase.count({where:{acceptedHandoverId:h.id}}),0);
  assert.equal(await db.openingException.count({where:{handoverId:h.id}}),0);
});
test('invalid counted currency still refuses the receipt without opening a case',async()=>{
  const {h,incoming}=await fixture();
  await assert.rejects(()=>record(h.id,incoming.id,{countedOpeningCash:638.801}),(err:{status?:number})=>err.status===400);
  assert.equal((await db.handoverSession.findUniqueOrThrow({where:{id:h.id}})).cashVerifiedAt,null);
  assert.equal(await db.varianceCase.count({where:{acceptedHandoverId:h.id}}),0);
});

test('other opening exception kinds still require a reason at the database boundary',async()=>{
  const {h}=await fixture();
  await assert.rejects(()=>db.$transaction(tx=>tx.openingException.create({data:{
    cafeId,branchId,handoverId:h.id,kind:'MANAGER_ADJUSTMENT',reasonCodeId:null,authorizedById:incomingId,
  }})));
  assert.equal(await db.openingException.count({where:{handoverId:h.id}}),0);
});
