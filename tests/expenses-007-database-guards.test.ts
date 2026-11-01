import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, fixture, pay, receive, snapshot, removeOwnedCache, journal } from "./helpers/expenses-runtime";
import { recomputeShiftTotals } from "@/lib/shifts";
after(async()=>{await db.$disconnect()});

test("PostgreSQL enforces append-only payouts, scoped active categories, OPEN custody, positive amounts and EGP",{timeout:120000},async()=>{
 const fx=await fixture("GUARDS"), other=await fixture("GUARDOTHER");const paid=await pay(fx);assert.equal(paid.status,201,JSON.stringify(paid.body));
 const source=await db.operatingExpense.findUniqueOrThrow({where:{id:paid.body.id}});
 const clone=()=>({...source,id:randomUUID(),idempotencyKey:randomUUID()});
 const cases=[{amount:0},{amount:-1},{currency:"USD"},{branchId:fx.otherBranchId},{categoryId:other.categoryId},{actorId:fx.owner.id},{amount:"10000000000"}];
 for(const patch of cases){await assert.rejects(db.operatingExpense.create({data:{...clone(),...patch}}));journal("sql-guard-rejected",{cafeId:fx.cafeId,patch});}
 for(const status of ["CLOSED","AWAITING_HANDOVER"] as const)await assert.rejects(db.$transaction(async tx=>{await tx.shift.update({where:{id:fx.shiftId},data:{status}});await tx.operatingExpense.create({data:clone()});}));
 await assert.rejects(db.$transaction(async tx=>{await tx.expenseCategory.update({where:{id:fx.categoryId},data:{archivedAt:new Date()}});await tx.operatingExpense.create({data:clone()});}));
 await assert.rejects(db.operatingExpense.update({where:{id:source.id},data:{description:"changed"}}));await assert.rejects(db.operatingExpense.delete({where:{id:source.id}}));
 assert.equal((await snapshot(fx)).status,"OPEN");assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),1);
 // NUMERIC(12,2) coerces SQL precision; rejection of overprecision belongs to the API.
 const rollback=new Error("owned precision probe rollback");
 await assert.rejects(db.$transaction(async tx=>{const row=await tx.operatingExpense.create({data:{...clone(),amount:"1.001"}});assert.equal(String(row.amount),"1");throw rollback;}),e=>e===rollback);
 journal("numeric-coercion-distinction",{cafeId:fx.cafeId,input:"1.001",storedInRolledBackProbe:"1.00",committed:false});
});

test("PostgreSQL bounds cumulative linked returns and prevents editing/deleting return evidence",{timeout:120000},async()=>{
 const fx=await fixture("RETURN_GUARD");const paid=await pay(fx);assert.equal(paid.status,201);const received=await receive(fx,paid.body.id,20);assert.equal(received.status,201);
 const original=await db.operatingExpenseReturn.findUniqueOrThrow({where:{id:received.body.returns[0].id}});
 await assert.rejects(db.operatingExpenseReturn.create({data:{...original,id:randomUUID(),idempotencyKey:randomUUID(),amount:"100.01"}}));
 await assert.rejects(db.operatingExpenseReturn.create({data:{...original,id:randomUUID(),idempotencyKey:randomUUID(),shiftId:"nonexistent"}}));
 await assert.rejects(db.operatingExpenseReturn.update({where:{id:original.id},data:{reason:"erase evidence"}}));await assert.rejects(db.operatingExpenseReturn.delete({where:{id:original.id}}));
 assert.equal(await db.operatingExpenseReturn.count({where:{expenseId:paid.body.id}}),1);assert.equal(String((await snapshot(fx)).expectedCashAmount),"900");
});

for(const kind of ["payout","return"] as const)test("durable "+kind+" identity prevents a second effect and conflicts with changed payload after only its OWN response cache is removed",{timeout:120000},async()=>{
 const fx=await fixture("DURABLE_"+kind);const payoutKey=randomUUID(),returnKey=randomUUID();const paid=await pay(fx,120,payoutKey);assert.equal(paid.status,201);
 if(kind==="return")assert.equal((await receive(fx,paid.body.id,20,returnKey)).status,201);
 const source=kind==="payout"?await db.operatingExpense.findUniqueOrThrow({where:{id:paid.body.id}}):await db.operatingExpenseReturn.findFirstOrThrow({where:{expenseId:paid.body.id}});
 const before=await snapshot(fx);await removeOwnedCache(fx,source);
 const repeated=kind==="payout"?await pay(fx,120,payoutKey):await receive(fx,paid.body.id,20,returnKey);
 const changed=kind==="payout"?await pay(fx,121,payoutKey):await receive(fx,paid.body.id,21,returnKey);
 assert.ok([201,409].includes(repeated.status),"unexpected retry result "+JSON.stringify(repeated.body));assert.equal(changed.status,409);
 assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),1);assert.equal(await db.operatingExpenseReturn.count({where:{cafeId:fx.cafeId}}),kind==="return"?1:0);
 assert.equal(await db.auditLog.count({where:{cafeId:fx.cafeId,action:"OPERATING_EXPENSE_PAID"}}),1);assert.equal(await db.auditLog.count({where:{cafeId:fx.cafeId,action:"OPERATING_EXPENSE_CASH_RETURNED"}}),kind==="return"?1:0);
 assert.equal(String((await snapshot(fx)).expectedCashAmount),String(before.expectedCashAmount));
 journal("durable-source-after-cache-removal",{kind,cafeId:fx.cafeId,sourceId:source.id,samePayloadStatus:repeated.status,changedPayloadStatus:changed.status,sourceAuditAndCashUnchanged:true,receiptReplayAvailable:repeated.status===201});
});
