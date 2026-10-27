import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { db, teardownTaggedCafe } from './helpers/db';
import { countCafe, countItem, type CountCafe } from './helpers/count';
import { as } from './helpers/http';
import { observeTransactionSql } from './helpers/phase2-lock-trace';

const fixtures: CountCafe[] = [];
after(async () => { for (const fx of fixtures) await teardownTaggedCafe(fx.cafeId); await db.$disconnect(); });
async function setup(amount: number) {
  const fx = await countCafe('OVERNIGHT001'); fixtures.push(fx);
  await db.cafeSettings.update({where:{cafeId:fx.cafeId},data:{stockCountPolicy:'HYBRID',handoverCountType:'CRITICAL',periodicFullCountSchedule:'MANUAL_ONLY'}});
  await countItem(fx,'beans',{stock:10,isCritical:true});
  const shift = await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.cashier.id,shiftNumber:1,openingCashAmount:amount,expectedCashAmount:amount}});
  const {ensureCustodyForShift} = await import('@/lib/custody');
  await db.$transaction(tx=>ensureCustodyForShift(tx,{cafeId:fx.cafeId,branchId:fx.branchId,shiftId:shift.id,userId:fx.cashier.id,openingCashAmount:amount}));
  return {fx,shift};
}
async function close(fx: CountCafe, shiftId: string, actualCash: number, leftInDrawer: number, toTreasury: number, target: 'BRANCH_CUSTODY'|'SHIFT_TO_SHIFT'='BRANCH_CUSTODY') {
  const {closeShiftWithSettlement} = await import('@/lib/cash-close');
  return closeShiftWithSettlement({shiftId,actualCash,actorId:fx.owner.id,closedByManager:true,handoverTarget:target,grants:{handoverSubmit:true,handoverException:true},...{cashDisposition:{leftInDrawer,toTreasury,note:'Night count'}}});
}
const refusal = (code: number) => (e: unknown) => (e as {status?:number}).status === code;
test('invalid night allocation refuses and keeps the financial shift OPEN',async()=>{
  const {fx,shift}=await setup(800);
  await assert.rejects(close(fx,shift.id,800,500,301),refusal(400));
  assert.equal((await db.shift.findUniqueOrThrow({where:{id:shift.id}})).status,'OPEN');
  assert.equal(await db.handoverSession.count({where:{outgoingShiftId:shift.id}}),0);
});
test('800 counted, 500 drawer, 300 treasury records one declaration and no expense',async()=>{
  const {fx,shift}=await setup(800); const result=await close(fx,shift.id,800,500,300);
  const rows=await db.$queryRaw<Array<{leftInDrawer:unknown;toTreasury:unknown;declaredById:string;handoverId:string}>>`SELECT * FROM "CashStorage" WHERE "outgoingShiftId"=${shift.id}`;
  assert.equal(rows.length,1); assert.equal(Number(rows[0].leftInDrawer),500); assert.equal(Number(rows[0].toTreasury),300);
  assert.equal(rows[0].declaredById,fx.owner.id); assert.equal(rows[0].handoverId,result.handoverId);
  assert.equal(await db.payment.count({where:{shiftId:shift.id}}),0);
  await assert.rejects(close(fx,shift.id,800,500,300),refusal(400));
  assert.equal((await db.$queryRaw<Array<{n:bigint}>>`SELECT count(*) AS n FROM "CashStorage" WHERE "outgoingShiftId"=${shift.id}`)[0].n,BigInt(1));
});
test('zero is an explicit declaration, not missing historical data',async()=>{
  const {fx,shift}=await setup(0); await close(fx,shift.id,0,0,0);
  const rows=await db.$queryRaw<Array<{leftInDrawer:unknown}>>`SELECT * FROM "CashStorage" WHERE "outgoingShiftId"=${shift.id}`;
  assert.equal(rows.length,1); assert.equal(Number(rows[0].leftInDrawer),0);
});
test('direct employee handover cannot masquerade as drawer storage',async()=>{
  const {fx,shift}=await setup(800); await assert.rejects(close(fx,shift.id,800,500,300,'SHIFT_TO_SHIFT'),refusal(400));
});
test('another cafe and a cashier cannot move night drawer funds',async()=>{
  const {fx,shift}=await setup(800); await close(fx,shift.id,800,500,300);
  const rows=await db.$queryRaw<Array<{id:string}>>`SELECT id FROM "CashStorage" WHERE "outgoingShiftId"=${shift.id}`;
  const other=await countCafe('OVERNIGHT001-OTHER'); fixtures.push(other);
  for(const email of [other.owner.email,fx.cashier.email]) {
    const response=await as(email,`/api/cash-storage/${rows[0].id}/movements`,{method:'POST',body:JSON.stringify({amount:-10,reason:'Treasury withdrawal'})});
    assert.equal(response.status,403);
  }
});
test('night cash declaration requires the branch operational drawer to be closed for all staff',async()=>{
  const {fx,shift}=await setup(800);
  await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.manager.id,shiftNumber:2,openingCashAmount:0,expectedCashAmount:0}});
  await assert.rejects(close(fx,shift.id,800,500,300),refusal(409));
  assert.equal((await db.shift.findUniqueOrThrow({where:{id:shift.id}})).status,'OPEN');
});
test('stored cash movement initializes timeouts and locks scoped Branch before storage',async()=>{
  const {fx,shift}=await setup(800);await close(fx,shift.id,800,500,300);
  const storage=await db.cashStorage.findUniqueOrThrow({where:{outgoingShiftId:shift.id}});
  const {moveStoredCash}=await import('@/lib/overnight-cash');
  const {sql,traces}=await observeTransactionSql(()=>moveStoredCash({storageId:storage.id,actor:{...fx.owner,role:'CAFE_OWNER',cafeId:fx.cafeId,branchId:null},amount:-0.29,reason:'Treasury movement',idempotencyKey:'timeout-scope'}));
  assert.match(sql[0],/SET LOCAL lock_timeout/);assert.match(sql[1],/SET LOCAL statement_timeout/);
  const branch=sql.findIndex(q=>/FROM "Branch"/.test(q)&&/FOR NO KEY UPDATE/.test(q));
  const cash=sql.findIndex(q=>/FROM "CashStorage"/.test(q)&&/FOR UPDATE/.test(q));
  assert.ok(branch>=0&&branch<cash,JSON.stringify(sql));
  assert.match(sql[cash],/"cafeId"/);assert.match(sql[cash],/"branchId"/);
  assert.equal((await db.cashStorageMovement.findFirstOrThrow({where:{storageId:storage.id}})).amount.toString(),'-0.29');
  console.log('PHASE2_SQL_TRACE '+JSON.stringify({operation:'stored-cash',sql,traces}));
});
test('temporary branch cashier can declare night cash in the effective closing branch',async()=>{
  const {fx,shift}=await setup(0);
  const home=await db.branch.create({data:{cafeId:fx.cafeId,name:'Home branch'}});
  await db.user.update({where:{id:fx.cashier.id},data:{branchId:home.id,temporaryBranchId:fx.branchId,temporaryBranchUntil:new Date(Date.now()+3600000),temporaryBranchStartedAt:new Date()}});
  const {closeShiftWithSettlement}=await import('@/lib/cash-close');
  const result=await closeShiftWithSettlement({shiftId:shift.id,actualCash:0,actorId:fx.cashier.id,closedByManager:false,actor:{...fx.cashier,role:'CASHIER',cafeId:fx.cafeId,branchId:fx.branchId},handoverTarget:'BRANCH_CUSTODY',grants:{handoverSubmit:true,handoverException:true},cashDisposition:{leftInDrawer:0,toTreasury:0}});
  assert.equal(result.status,'AWAITING_HANDOVER');
  assert.equal((await db.cashStorage.findUniqueOrThrow({where:{outgoingShiftId:shift.id}})).branchId,fx.branchId);
});
