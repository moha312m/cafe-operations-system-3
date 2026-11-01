import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { db, teardownTaggedCafe } from './helpers/db';
import { countCafe, type CountCafe } from './helpers/count';
import { observeTransactionSql } from './helpers/phase2-lock-trace';
const owned:CountCafe[]=[];
after(async()=>{for(const fx of owned)await teardownTaggedCafe(fx.cafeId);await db.$disconnect();});
const reject=(status:number)=>(e:unknown)=>(e as {status?:number}).status===status;
async function setup(options:{expected?:number;movement?:number;completed?:boolean;stockGate?:boolean}={}) {
  const fx=await countCafe('OVERNIGHT002');owned.push(fx);
  const outgoing=await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.manager.id,shiftNumber:1,status:'CLOSED',openingCashAmount:500,expectedCashAmount:500,actualCashAmount:500,closedAt:new Date()}});
  const handover=await db.handoverSession.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,outgoingShiftId:outgoing.id,outgoingUserId:fx.manager.id,target:'BRANCH_CUSTODY',resolvedTarget:'BRANCH_CUSTODY',status:options.completed===false?'DRAFT':'COMPLETED',completedAt:options.completed===false?null:new Date()}});
  const amount=options.expected??500;
  const storage=await db.cashStorage.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,outgoingShiftId:outgoing.id,handoverId:handover.id,closingAmount:amount,leftInDrawer:amount,toTreasury:0,drawerLabel:'Night drawer',declaredById:fx.manager.id}});
  if(options.movement)await db.cashStorageMovement.create({data:{cafeId:fx.cafeId,storageId:storage.id,amount:options.movement,actorId:fx.owner.id,reason:'Transfer to treasury'}});
  const incoming=await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.cashier.id,shiftNumber:2,openingCashAmount:0,expectedCashAmount:0,custodyGateReason:options.stockGate?'AWAITING_OPENING_VERIFICATION':null}});
  const cash=await db.custodyPeriod.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,scope:'CASH',holderType:'USER',openingCashAmount:0,openedById:fx.cashier.id,participants:{create:{userId:fx.cashier.id,role:'PRIMARY'}},shiftLinks:{create:{shiftId:incoming.id,scope:'CASH'}}}});
  const receipt=await db.openingCashReceipt.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,storageId:storage.id,incomingShiftId:incoming.id,claimantId:fx.cashier.id,expectedAmount:amount+(options.movement??0)}});
  const reason=await db.reasonCode.create({data:{cafeId:fx.cafeId,domain:'HANDOVER',code:'OVERNIGHT_SHORT',label:'Physical drawer difference'}});
  return {fx,outgoing,incoming,handover,storage,cash,receipt,reason};
}
test('pending cash blocks a financially operational shift even after stock acceptance',async()=>{
  const f=await setup();const shifts=await import('@/lib/shifts');
  assert.equal(await shifts.getActiveShift(f.fx.branchId,f.fx.cashier.id),null);
  await assert.rejects(shifts.requireCashCustody(f.fx.branchId,f.fx.cashier.id),reject(400));
});
test('matching count changes both opening records once and raises no shortage case',async()=>{
  const f=await setup();const lib=await import('@/lib/overnight-cash');
  const args={receiptId:f.receipt.id,actorId:f.fx.cashier.id,countedCash:500,idempotencyKey:'match'};
  const first=await lib.acceptOpeningCash(args);assert.equal(first.caseId,null);assert.equal(first.alreadyAccepted,false);
  const retry=await lib.acceptOpeningCash(args);assert.equal(retry.alreadyAccepted,true);
  assert.equal(Number((await db.shift.findUniqueOrThrow({where:{id:f.incoming.id}})).openingCashAmount),500);
  assert.equal(Number((await db.custodyPeriod.findUniqueOrThrow({where:{id:f.cash.id}})).openingCashAmount),500);
  assert.equal(await db.openingCashReceiptEvent.count({where:{receiptId:f.receipt.id,action:'ACCEPTED'}}),1);
  await assert.rejects(lib.acceptOpeningCash({...args,countedCash:450}),reject(409));
});
test('opening receipt sets local timeouts and takes Shift before Branch and storage',async()=>{
  const f=await setup();const lib=await import('@/lib/overnight-cash');
  const {sql,traces}=await observeTransactionSql(()=>lib.acceptOpeningCash({receiptId:f.receipt.id,actorId:f.fx.cashier.id,countedCash:500,idempotencyKey:'lock-trace'}));
  assert.match(sql[0],/SET LOCAL lock_timeout/);assert.match(sql[1],/SET LOCAL statement_timeout/);
  const shift=sql.findIndex(q=>/FROM "Shift"/.test(q)&&/FOR UPDATE/.test(q));
  const branch=sql.findIndex(q=>/FROM "Branch"/.test(q)&&/FOR NO KEY UPDATE/.test(q));
  const storage=sql.findIndex(q=>/FROM "CashStorage"/.test(q)&&/FOR UPDATE/.test(q));
  assert.ok(shift>=0&&shift<branch&&branch<storage,JSON.stringify(sql));
  console.log('PHASE2_SQL_TRACE '+JSON.stringify({operation:'opening-receipt',sql,traces}));
});
test('500/450 and 500/0 require reasons and produce unresolved receipt differences',async()=>{
  const lib=await import('@/lib/overnight-cash');
  for(const countedCash of [450,0]) {
    const f=await setup();const args={receiptId:f.receipt.id,actorId:f.fx.cashier.id,countedCash,idempotencyKey:'short'};
    await assert.rejects(lib.acceptOpeningCash(args),reject(400));
    assert.equal((await db.openingCashReceipt.findUniqueOrThrow({where:{id:f.receipt.id}})).status,'PENDING');
    const result=await lib.acceptOpeningCash({...args,reasonCodeId:f.reason.id,note:'Physical morning count'});
    const c=await db.varianceCase.findUniqueOrThrow({where:{id:result.caseId!}});
    assert.equal(Number(c.amountVariance),countedCash-500);assert.equal(c.shiftId,null);assert.equal(c.custodyPeriodId,null);assert.equal(c.assignedResponsibilityUserId,null);
    const report=await (await import('@/lib/employee-variance-report')).loadEmployeeVariances({cafeId:f.fx.cafeId,from:new Date(0),to:new Date(Date.now()+60000)});
    const row=report.rows.find(r=>r.id===c.id)!;assert.equal(row.category,'HANDOVER_CASH');assert.equal(row.employee,null);assert.equal(row.responsibility,'UNRESOLVED');
    assert.deepEqual(new Set(row.relatedEmployees.map(p=>p.id)),new Set([f.fx.manager.id,f.fx.cashier.id]));
  }
});
test('defer and dispute preserve independent events and keep operations blocked',async()=>{
  const f=await setup();const lib=await import('@/lib/overnight-cash');
  for(const action of ['DEFER','DISPUTE'] as const)await lib.updateOpeningCashReview({receiptId:f.receipt.id,actorId:f.fx.cashier.id,action,note:'Awaiting owner check'});
  assert.equal(await db.openingCashReceiptEvent.count({where:{receiptId:f.receipt.id}}),2);
  await assert.rejects((await import('@/lib/shifts')).requireOperationalShift(f.fx.branchId,f.fx.cashier.id),reject(400));
});
test('completed source and named claimant are mandatory; treasury movements change expected amount',async()=>{
  const lib=await import('@/lib/overnight-cash');const f=await setup({movement:-50,completed:false});
  const args={receiptId:f.receipt.id,actorId:f.fx.cashier.id,countedCash:450,idempotencyKey:'movement'};
  await assert.rejects(lib.acceptOpeningCash(args),reject(409));
  await db.handoverSession.update({where:{id:f.handover.id},data:{status:'COMPLETED',completedAt:new Date()}});
  await assert.rejects(lib.acceptOpeningCash({...args,actorId:f.fx.manager.id}),reject(403));
  const foreign=await countCafe('OVERNIGHT002-FOREIGN');owned.push(foreign);
  await assert.rejects(lib.acceptOpeningCash({...args,actorId:foreign.cashier.id}),reject(403));
  const result=await lib.acceptOpeningCash(args);assert.equal(result.caseId,null);
  assert.equal(Number((await db.openingCashReceipt.findUniqueOrThrow({where:{id:f.receipt.id}})).expectedAmount),450);
});
test('cash acceptance alone never clears the stock gate, either acceptance order works',async()=>{
  const lib=await import('@/lib/overnight-cash');const shifts=await import('@/lib/shifts');
  for(const cashFirst of [true,false]) {
    const f=await setup({stockGate:true});
    if(!cashFirst)await db.shift.update({where:{id:f.incoming.id},data:{custodyGateReason:null}});
    await lib.acceptOpeningCash({receiptId:f.receipt.id,actorId:f.fx.cashier.id,countedCash:500,idempotencyKey:'order'});
    if(cashFirst){assert.equal(await shifts.getActiveShift(f.fx.branchId,f.fx.cashier.id),null);await db.shift.update({where:{id:f.incoming.id},data:{custodyGateReason:null}});}
    assert.equal((await shifts.getActiveShift(f.fx.branchId,f.fx.cashier.id))?.id,f.incoming.id);
  }
});
test('two simultaneous acceptances create one case and one acceptance event',async()=>{
  const f=await setup();const lib=await import('@/lib/overnight-cash');
  const args={receiptId:f.receipt.id,actorId:f.fx.cashier.id,countedCash:450,reasonCodeId:f.reason.id,note:'Count',idempotencyKey:'race'};
  const results=await Promise.all([lib.acceptOpeningCash(args),lib.acceptOpeningCash(args)]);
  assert.equal(results.filter(r=>r.alreadyAccepted).length,1);assert.equal(results[0].caseId,results[1].caseId);
  assert.equal(await db.openingCashReceiptEvent.count({where:{receiptId:f.receipt.id,action:'ACCEPTED'}}),1);
});
test('two shifts cannot claim one drawer and a same-shift replay returns its receipt',async()=>{
  const f=await setup();await db.openingCashReceipt.delete({where:{id:f.receipt.id}});
  const other=await db.shift.create({data:{cafeId:f.fx.cafeId,branchId:f.fx.branchId,cashierId:f.fx.manager.id,shiftNumber:3,openingCashAmount:0,expectedCashAmount:0}});
  const lib=await import('@/lib/overnight-cash');
  const attempts=await Promise.allSettled([
    db.$transaction(tx=>lib.claimOpeningCash(tx,{shiftId:f.incoming.id,actorId:f.fx.cashier.id})),
    db.$transaction(tx=>lib.claimOpeningCash(tx,{shiftId:other.id,actorId:f.fx.manager.id})),
  ]);
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
  const rejected=attempts.find(a=>a.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.status,409);
  const receipt=await db.openingCashReceipt.findUniqueOrThrow({where:{storageId:f.storage.id}});
  const retry=await db.$transaction(tx=>lib.claimOpeningCash(tx,{shiftId:receipt.incomingShiftId,actorId:receipt.claimantId}));
  assert.equal(retry.receiptId,receipt.id);assert.equal(await db.openingCashReceiptEvent.count({where:{receiptId:receipt.id,action:'CLAIMED'}}),1);
});
test('failed acceptance audit rolls back both cash openings, the receipt and the variance case',async()=>{
  const f=await setup();const lib=await import('@/lib/overnight-cash');
  const name=`overnight_audit_${process.pid}`;assert.match(name,/^[a-z0-9_]+$/);assert.match(f.fx.cafeId,/^[a-z0-9]+$/);
  await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."cafeId"='${f.fx.cafeId}' AND NEW.action='OPENING_CASH_ACCEPTED' THEN RAISE EXCEPTION 'Owned audit failure fixture'; END IF; RETURN NEW; END $$`);
  try {
    await db.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    await assert.rejects(lib.acceptOpeningCash({receiptId:f.receipt.id,actorId:f.fx.cashier.id,countedCash:450,reasonCodeId:f.reason.id,note:'Count',idempotencyKey:'audit'}));
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "AuditLog"`);await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
  }
  assert.equal((await db.openingCashReceipt.findUniqueOrThrow({where:{id:f.receipt.id}})).status,'PENDING');
  assert.equal(Number((await db.shift.findUniqueOrThrow({where:{id:f.incoming.id}})).openingCashAmount),0);
  assert.equal(Number((await db.custodyPeriod.findUniqueOrThrow({where:{id:f.cash.id}})).openingCashAmount),0);
  assert.equal(await db.varianceCase.count({where:{cafeId:f.fx.cafeId}}),0);assert.equal(await db.openingException.count({where:{cafeId:f.fx.cafeId}}),0);
  assert.equal(await db.openingCashReceiptEvent.count({where:{receiptId:f.receipt.id}}),0);
});
test('a pending receipt cannot be abandoned by financially closing its incoming shift',async()=>{
  const f=await setup();await db.cafeSettings.update({where:{cafeId:f.fx.cafeId},data:{stockCountPolicy:'NO_SHIFT_COUNT'}});
  const {closeShiftWithSettlement}=await import('@/lib/cash-close');
  await assert.rejects(closeShiftWithSettlement({shiftId:f.incoming.id,actorId:f.fx.cashier.id,actualCash:0,closedByManager:false}),reject(400));
  assert.equal((await db.shift.findUniqueOrThrow({where:{id:f.incoming.id}})).status,'OPEN');
});
