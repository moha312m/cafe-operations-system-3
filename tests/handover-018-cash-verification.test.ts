import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tag, assertTestDatabase, teardownTaggedCafe } from './helpers/db';
const marker=tag('CASHHANDOVER');
let cafeId:string, branchId:string, outgoingId:string, incomingId:string, reasonCodeId:string;
before(async()=>{
  await assertTestDatabase();
  cafeId=(await db.cafe.create({data:{name:marker,slug:marker.toLowerCase(),settings:{create:{}}}})).id;
  branchId=(await db.branch.create({data:{cafeId,name:marker}})).id;
  outgoingId=(await db.user.create({data:{cafeId,branchId,role:'CASHIER',name:'Outgoing',email:marker+'a@example.invalid',passwordHash:'unused'}})).id;
  incomingId=(await db.user.create({data:{cafeId,branchId,role:'CASHIER',name:'Incoming',email:marker+'b@example.invalid',passwordHash:'unused'}})).id;
  reasonCodeId=(await db.reasonCode.create({data:{cafeId,domain:'HANDOVER',code:marker,label:'Cash received short',isActive:true}})).id;
});
after(async()=>teardownTaggedCafe(cafeId,[],{disconnect:true}));
let number=0;
async function fixture(){
  await db.handoverSession.updateMany({where:{branchId},data:{status:'COMPLETED',completedAt:new Date()}});
  await db.shift.updateMany({where:{branchId,status:'OPEN'},data:{status:'CLOSED',closedAt:new Date()}});
  const outgoing=await db.shift.create({data:{cafeId,branchId,cashierId:outgoingId,shiftNumber:++number,status:'AWAITING_HANDOVER',openingCashAmount:500,expectedCashAmount:693.8,actualCashAmount:668.8,financiallyClosedAt:new Date()}});
  const incoming=await db.shift.create({data:{cafeId,branchId,cashierId:incomingId,shiftNumber:++number,openingCashAmount:638.8,expectedCashAmount:638.8,custodyGateReason:'AWAITING_CUSTODY_TRANSFER'}});
  const h=await db.handoverSession.create({data:{cafeId,branchId,outgoingShiftId:outgoing.id,outgoingUserId:outgoingId,status:'INCOMING_REVIEW',target:'SHIFT_TO_SHIFT'}});
  return {h,incoming};
}
async function record(handoverId:string,incomingShiftId:string,extra={}){
  const lib=await import('@/lib/cash-handover').catch(()=>null);
  assert.ok(lib?.recordCashHandover,'cash handover verification must exist');
  return db.$transaction(tx=>lib.recordCashHandover(tx,{handoverId,incomingShiftId,incomingUserId:incomingId,at:new Date(),...extra}));
}
test('cash mismatch refuses acceptance without a reason and leaves no partial record',async()=>{
  const {h,incoming}=await fixture();
  const lib=await import('@/lib/cash-handover').catch(()=>null);
  assert.ok(lib?.recordCashHandover,'cash handover verification must exist');
  await assert.rejects(()=>record(h.id,incoming.id),(err:{status?:number,message?:string})=>{assert.equal(err.status,400);assert.match(err.message??'',/سبب/);return true;});
  const actual=await db.handoverSession.findUniqueOrThrow({where:{id:h.id}});
  assert.equal(actual.cashVarianceAmount,null);
});
test('cash shortage is recorded separately with both observations and no automatic responsibility',async()=>{
  const {h,incoming}=await fixture();
  const result=await record(h.id,incoming.id,{cashReasonCodeId:reasonCodeId,cashReasonNote:'30 missing at receipt'});
  assert.equal(result.counted,638.8);
  const actual=await db.handoverSession.findUniqueOrThrow({where:{id:h.id}});
  assert.equal(Number(actual.proposedOpeningCash),668.8);
  assert.equal(Number(actual.countedOpeningCash),638.8);
  assert.equal(Number(actual.cashVarianceAmount),-30);
  assert.equal(actual.cashVerifiedById,incomingId);
  const c=await db.varianceCase.findFirstOrThrow({where:{acceptedHandoverId:h.id,type:'OPENING_EXCEPTION'}});
  assert.equal(Number(c.amountVariance),-30);
  assert.equal(c.assignedResponsibilityUserId,null);
  assert.equal((await db.openingException.findUniqueOrThrow({where:{id:c.openingExceptionId!}})).note,'30 missing at receipt');
});
test('explicit incoming count aligns shift opening and zero mismatch opens no variance case',async()=>{
  const {h,incoming}=await fixture();
  await record(h.id,incoming.id,{countedOpeningCash:668.8});
  const shift=await db.shift.findUniqueOrThrow({where:{id:incoming.id}});
  assert.equal(Number(shift.openingCashAmount),668.8);
  assert.equal(Number(shift.expectedCashAmount),668.8);
  assert.equal(await db.varianceCase.count({where:{acceptedHandoverId:h.id}}),0);
});
