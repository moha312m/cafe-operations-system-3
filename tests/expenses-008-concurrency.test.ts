import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, fixture, pay, receive, http, snapshot, locked, blockedOn, waitFor, journal } from "./helpers/expenses-runtime";
import { recomputeShiftTotals } from "@/lib/shifts";
import { ensureAccountingEntity } from "@/lib/accounting/chart";
import { openPeriod } from "@/lib/accounting/ledger";
import { closeCheckedPeriod, closeChecklist } from "@/lib/accounting/close-checklist";
import { shadowCoverage } from "@/lib/accounting/shadow-projection";
import { addDays,dateStrInTz,zonedDayStart } from "@/lib/date-range";
after(async()=>{await db.$disconnect()});

test("separate payout transactions competing for 100 cash cannot both spend 80",{timeout:120000},async()=>{
 const fx=await fixture("PAYOUT_RACE",100);
 const results=await locked(tx=>tx.$queryRaw`SELECT id FROM "Shift" WHERE id=${fx.shiftId} FOR UPDATE`.then(()=>{}),async release=>{
   const first=pay(fx,80),second=pay(fx,80);await waitFor(()=>blockedOn('Shift'),"two payout connections queued");release();return Promise.all([first,second]);
 });
 assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),1);assert.equal(String((await snapshot(fx)).expectedCashAmount),"20");
 journal("payout-race",{cafeId:fx.cafeId,statuses:results.map(r=>r.status),expected:20});
});
test("concurrent partial returns cannot exceed the original payout",{timeout:120000},async()=>{
 const fx=await fixture("RETURN_RACE");const paid=await pay(fx);assert.equal(paid.status,201);
 const results=await locked(tx=>tx.$queryRaw`SELECT id FROM "Shift" WHERE id=${fx.shiftId} FOR UPDATE`.then(()=>{}),async release=>{
  const a=receive(fx,paid.body.id,80),b=receive(fx,paid.body.id,80);await waitFor(()=>blockedOn('Shift'),"returns queued");release();return Promise.all([a,b]);
 });
 assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);const total=await db.operatingExpenseReturn.aggregate({where:{expenseId:paid.body.id},_sum:{amount:true}});assert.equal(String(total._sum.amount),"80");assert.equal(String((await snapshot(fx)).expectedCashAmount),"960");
});
for(const kind of ["payout","return"] as const)test(kind+" versus financial close has one serial outcome and preserves the closed snapshot",{timeout:120000},async()=>{
 const fx=await fixture("CLOSE_"+kind);const paid=kind==="return"?await pay(fx):null;if(paid)assert.equal(paid.status,201);
 const results=await locked(tx=>tx.$queryRaw`SELECT id FROM "Shift" WHERE id=${fx.shiftId} FOR UPDATE`.then(()=>{}),async release=>{
  const operation=kind==="payout"?pay(fx,80):receive(fx,paid!.body.id,20);
  const close=http(fx.manager,"/api/shifts/"+fx.shiftId+"/close","POST",{actualCashAmount:kind==="payout"?1000:880,reason:"controlled test race count"});
  await waitFor(()=>blockedOn('Shift'),"close/source queued");release();return Promise.all([operation,close]);
 });
 assert.equal(results[1].status,200,JSON.stringify(results[1].body));assert.ok([201,400,409].includes(results[0].status));
 const closed=await snapshot(fx);assert.equal(closed.status,"CLOSED");const expected=kind==="payout"?(results[0].status===201?920:1000):(results[0].status===201?900:880);assert.equal(String(closed.expectedCashAmount),String(expected));await recomputeShiftTotals(fx.shiftId);assert.equal(String((await snapshot(fx)).expectedCashAmount),String(expected));
 journal("source-versus-close",{kind,cafeId:fx.cafeId,statuses:results.map(r=>r.status),expected});
});
for(const change of ["explicit-deny","role-reassignment","inactive-account"] as const)test("committed "+change+" while a request waits revokes current payout authority",{timeout:120000},async()=>{
 const fx=await fixture("AUTH_"+change);
 const role=change==="role-reassignment"?await db.cafeRole.create({data:{cafeId:fx.cafeId,code:"READONLY",name:"read only",permissions:{create:{permissionKey:"expenses.view",allowed:true}}}}):null;
 const response=await locked(async tx=>{
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${fx.manager.id} FOR NO KEY UPDATE`;
  if(change==="explicit-deny")await tx.userPermissionOverride.upsert({where:{userId_permissionKey:{userId:fx.manager.id,permissionKey:"expenses.manage"}},create:{userId:fx.manager.id,permissionKey:"expenses.manage",allowed:false},update:{allowed:false}});
  if(change==="role-reassignment"){await tx.userPermissionOverride.deleteMany({where:{userId:fx.manager.id}});await tx.user.update({where:{id:fx.manager.id},data:{cafeRoleId:role!.id}});}
  if(change==="inactive-account")await tx.user.update({where:{id:fx.manager.id},data:{isActive:false}});
 },async release=>{const response=pay(fx,10);await waitFor(()=>blockedOn('User'),"authority row blocked");release();return response;});
 assert.equal(response.status,403,JSON.stringify(response.body));assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),0);assert.equal(String((await snapshot(fx)).expectedCashAmount),"1000");
});
test("custody changed under the Shift lock is reread before payout",{timeout:120000},async()=>{
 const fx=await fixture("CUSTODY_RACE");
 const response=await locked(async tx=>{await tx.$queryRaw`SELECT id FROM "Shift" WHERE id=${fx.shiftId} FOR UPDATE`;await tx.shift.update({where:{id:fx.shiftId},data:{cashierId:fx.owner.id}});},async release=>{const pending=pay(fx,10);await waitFor(()=>blockedOn('Shift'),"custody change blocks payout",4000);release();return pending;});
 assert.ok([400,409].includes(response.status));assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),0);
});
test("an actual AuditLog insert lock timeout rolls back payout, totals and response completion",{timeout:120000},async()=>{
 const fx=await fixture("AUDIT_ROLLBACK");const key=randomUUID();
 const response=await locked(tx=>tx.$executeRawUnsafe('LOCK TABLE "AuditLog" IN SHARE MODE').then(()=>{}),async()=>{const pending=pay(fx,120,key);await waitFor(()=>blockedOn('AuditLog'),"real audit insert blocked");return pending;});
 assert.ok(response.status >= 400,JSON.stringify(response.body));assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),0);assert.equal(await db.auditLog.count({where:{cafeId:fx.cafeId,action:"OPERATING_EXPENSE_PAID"}}),0);assert.equal(String((await snapshot(fx)).expectedCashAmount),"1000");
 const receipt=await db.idempotencyKey.findFirstOrThrow({where:{key}});assert.notEqual(receipt.status,"COMPLETED");journal("audit-rollback",{cafeId:fx.cafeId,key,reservationStatus:receipt.status,responseStatus:response.status});
});
for(const kind of ["payout","return"] as const)test("G1 close waits for the actual "+kind+" source transaction and refuses its unsupported event",{timeout:120000},async()=>{
 const fx=await fixture("GATE_"+kind);const day=addDays(dateStrInTz(new Date()),-1),at=new Date(zonedDayStart(day).getTime()+3600000);
 const entity=await db.$transaction(tx=>ensureAccountingEntity(tx,fx.cafeId));assert.ok(entity.id);
 const period=await db.$transaction(tx=>openPeriod(tx,{cafeId:fx.cafeId,startsOn:day,endsOn:day}));
 const data={cafeId:fx.cafeId,branchId:fx.branchId,shiftId:fx.shiftId,categoryId:fx.categoryId,categoryCodeSnapshot:"OPERATING",categoryNameSnapshot:"synthetic",amount:120,currency:"EGP",description:"past synthetic source",actorId:fx.manager.id,actorNameSnapshot:fx.manager.name,occurredAt:at,idempotencyScope:fx.marker,idempotencyKey:randomUUID(),requestHash:"a".repeat(64)};
 const original=kind==="return"?await db.operatingExpense.create({data}):null;
 const result=await locked(async tx=>{if(kind==="payout")await tx.operatingExpense.create({data});else await tx.operatingExpenseReturn.create({data:{expenseId:original!.id,cafeId:fx.cafeId,branchId:fx.branchId,shiftId:fx.shiftId,amount:20,currency:"EGP",reason:"actual test cash return",actorId:fx.manager.id,actorNameSnapshot:fx.manager.name,occurredAt:at,idempotencyScope:fx.marker,idempotencyKey:randomUUID(),requestHash:"b".repeat(64)}});},async release=>{
  const closing=closeCheckedPeriod({cafeId:fx.cafeId,periodId:period.id,actorId:fx.owner.id}).then(()=>({closed:true}),error=>({closed:false,status:(error as {status:number}).status}));
  await waitFor(()=>blockedOn('accounting_close_key'),"G1 exclusive gate waits for source");release();return closing;
 });
 assert.equal(result.closed,false);assert.equal("status" in result&&result.status,409);assert.equal((await db.accountingPeriod.findUniqueOrThrow({where:{id:period.id}})).status,"OPEN");
 const coverage=await shadowCoverage({cafeId:fx.cafeId,from:zonedDayStart(day),to:zonedDayStart(addDays(day,1))});assert.equal(coverage.complete,false);assert.ok(coverage.unpostable.some(e=>e.sourceType===(kind==="payout"?"OPERATING_EXPENSE":"OPERATING_EXPENSE_RETURN")));
 const checklist=await closeChecklist({cafeId:fx.cafeId,periodId:period.id});assert.ok(checklist.items.some(i=>i.key==="no-exceptions"&&i.status==="blocking"));journal("g1-source-gate",{kind,cafeId:fx.cafeId,periodId:period.id,unpostable:coverage.unpostable});
});

for(const kind of ["payout","return"] as const)test(kind+" versus actual handover initiation preserves the settled snapshot",{timeout:120000},async()=>{
 const fx=await fixture("HANDOVER_"+kind);await db.cafeSettings.update({where:{cafeId:fx.cafeId},data:{stockCountPolicy:"FULL",handoverCountType:"FULL",inventoryEnabled:true}});
 await db.inventoryItem.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,name:fx.marker+" counted item",isCritical:true}});
 const paid=kind==="return"?await pay(fx):null;if(paid)assert.equal(paid.status,201);
 const results=await locked(tx=>tx.$queryRawUnsafe('SELECT id FROM "Shift" WHERE id=$1 FOR UPDATE',fx.shiftId).then(()=>{}),async release=>{
  const source=kind==="payout"?pay(fx,80):receive(fx,paid!.body.id,20);
  const close=http(fx.manager,"/api/shifts/"+fx.shiftId+"/close","POST",{actualCashAmount:kind==="payout"?1000:880,reason:"owned handover race count",handoverTarget:"BRANCH_CUSTODY"});
  await waitFor(()=>blockedOn("Shift"),"handover/source queued");release();return Promise.all([source,close]);
 });
 assert.equal(results[1].status,200,JSON.stringify(results[1].body));assert.ok([201,400,409].includes(results[0].status));
 const settled=await snapshot(fx);assert.equal(settled.status,"AWAITING_HANDOVER");const expected=kind==="payout"?(results[0].status===201?920:1000):(results[0].status===201?900:880);assert.equal(String(settled.expectedCashAmount),String(expected));
 await recomputeShiftTotals(fx.shiftId);assert.equal(String((await snapshot(fx)).expectedCashAmount),String(expected));
 const later=kind==="payout"?await pay(fx,1):await receive(fx,paid!.body.id,1);assert.equal(later.status,400);
 journal("source-versus-handover",{kind,cafeId:fx.cafeId,shiftId:fx.shiftId,statuses:results.map(r=>r.status),shiftStatus:settled.status,expected,handover:results[1].body.handover});
});

for(const writer of ["effective-role-permission","user-override"] as const)test("actual "+writer+" HTTP writer waits for authority shared lock through commit",{timeout:120000},async()=>{
 const fx=await fixture("WRITER_"+writer);let roleId:string|undefined;
 if(writer==="effective-role-permission"){const role=await db.cafeRole.create({data:{cafeId:fx.cafeId,code:"AUTHRACE",name:"owned active role",permissions:{create:["expenses.view","expenses.manage"].map(permissionKey=>({permissionKey,allowed:true}))}}});roleId=role.id;await db.userPermissionOverride.deleteMany({where:{userId:fx.manager.id}});await db.user.update({where:{id:fx.manager.id},data:{cafeRoleId:role.id}});}
 assert.equal((await pay(fx,1)).status,201);
 if(roleId)assert.equal((await http(fx.owner,"/api/roles/"+roleId)).status,200);
 const response=await locked(tx=>tx.$queryRawUnsafe(writer==="user-override"?'SELECT id FROM "User" WHERE id=$1 FOR SHARE':'SELECT id FROM "CafeRole" WHERE id=$1 FOR SHARE',roleId??fx.manager.id).then(()=>{}),async release=>{
  let complete=false;const pending=(writer==="user-override"?http(fx.owner,"/api/users/"+fx.manager.id+"/permissions","PUT",{overrides:[{key:"expenses.view",allowed:true},{key:"expenses.manage",allowed:false}]}):http(fx.owner,"/api/roles/"+roleId,"PATCH",{permissionKeys:["expenses.view"]})).then(r=>{complete=true;return r});await waitFor(()=>blockedOn(writer==="user-override"?"User":"CafeRole"),"actual HTTP authority writer queued");assert.equal(complete,false);release();return pending;
 });assert.equal(response.status,200,JSON.stringify(response.body));assert.equal((await pay(fx,1)).status,403);assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),1);journal("authority-writer-commit-coordination",{writer,cafeId:fx.cafeId,roleId,response:response.status});
});
