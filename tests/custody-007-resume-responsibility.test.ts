import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { db, teardownTaggedCafe } from "./helpers/db";
import { countCafe, type CountCafe } from "./helpers/count";
import { as, requireServer } from "./helpers/http";
import { ensureCustodyForShift, openCustodyPeriod } from "@/lib/custody";
let fx: CountCafe;
before(async()=>{await requireServer();fx=await countCafe("CUSTODY007");});
after(async()=>{if(fx)await teardownTaggedCafe(fx.cafeId,[],{disconnect:true});});
async function legacy(suffix:string, responsible=false){
 const branch=await db.branch.create({data:{cafeId:fx.cafeId,name:fx.marker+suffix}});
 const shift=await db.shift.create({data:{cafeId:fx.cafeId,branchId:branch.id,cashierId:fx.owner.id,shiftNumber:1,openingCashAmount:17,expectedCashAmount:17}});
 const periods=await db.$transaction(async tx=>{
  const cash=await openCustodyPeriod(tx,{cafeId:fx.cafeId,branchId:branch.id,scope:"CASH",participants:[{userId:fx.owner.id,role:"PRIMARY"}],shiftId:shift.id,openingCashAmount:17});
  const stock=await openCustodyPeriod(tx,{cafeId:fx.cafeId,branchId:branch.id,scope:"STOCK",participants:[{userId:fx.owner.id,role:"PRIMARY"}],shiftId:shift.id,responsibleShiftId:responsible?shift.id:null});
  return {cash:cash.custodyPeriodId,stock:stock.custodyPeriodId};
 });return {branch,shift,...periods};
}
// An operational bootstrap must not leave USER stock without accountable responsibility.
test("opening a coworker shift claims only previously unassigned USER stock",async()=>{
 const l=await legacy("-claim");
 const second=await db.shift.create({data:{cafeId:fx.cafeId,branchId:l.branch.id,cashierId:fx.manager.id,shiftNumber:2}});
 const verdict=await db.$transaction(tx=>ensureCustodyForShift(tx,{cafeId:fx.cafeId,branchId:l.branch.id,shiftId:second.id,userId:fx.manager.id,openingCashAmount:0}));
 assert.equal(verdict.operational,true);
 assert.equal((await db.custodyPeriod.findUniqueOrThrow({where:{id:l.stock}})).responsibleShiftId,second.id);
 assert.equal(await db.auditLog.count({where:{entityId:l.stock,action:"STOCK_CUSTODY_RESPONSIBILITY_ASSIGNED"}}),1);
});
// Repeated resume cannot create another custody/link or overwrite opening cash.
test("POST resumes an existing shift and restores missing responsibility idempotently",async()=>{
 const l=await legacy("-resume");
 for(let i=0;i<2;i++){
  const r=await as<{shift:{id:string;expectedCashAmount?:unknown};alreadyOpen:boolean}>(fx.owner.email,"/api/shifts",{method:"POST",body:JSON.stringify({branchId:l.branch.id,openingCashAmount:999})});
  assert.equal(r.status,200,r.text);assert.equal(r.body.alreadyOpen,true);assert.equal(r.body.shift.id,l.shift.id);
  assert.equal(Number(r.body.shift.expectedCashAmount),17,"owner report permission retains the target");
  assert.equal((await db.custodyPeriod.findUniqueOrThrow({where:{id:l.stock}})).responsibleShiftId,l.shift.id);
 }
 assert.equal(await db.shiftCustody.count({where:{shiftId:l.shift.id}}),2);
 assert.equal(await db.custodyPeriod.count({where:{branchId:l.branch.id}}),2);
 assert.equal(Number((await db.shift.findUniqueOrThrow({where:{id:l.shift.id}})).openingCashAmount),17);
 assert.equal(await db.auditLog.count({where:{entityId:l.stock,action:"STOCK_CUSTODY_RESPONSIBILITY_ASSIGNED"}}),1);
});
// Sharing or resuming cannot steal responsibility already recorded for another shift.
test("bootstrap resume keeps valid existing responsibility and original links",async()=>{
 const l=await legacy("-keep",true);
 const verdict=await db.$transaction(tx=>ensureCustodyForShift(tx,{cafeId:fx.cafeId,branchId:l.branch.id,shiftId:l.shift.id,userId:fx.owner.id,openingCashAmount:17}));
 assert.equal(verdict.operational,true);assert.equal((await db.custodyPeriod.findUniqueOrThrow({where:{id:l.stock}})).responsibleShiftId,l.shift.id);
 assert.equal(await db.shiftCustody.count({where:{shiftId:l.shift.id}}),2);
 assert.equal(await db.auditLog.count({where:{entityId:l.stock,action:"STOCK_CUSTODY_RESPONSIBILITY_ASSIGNED"}}),0);
});
// Serving must remain blocked until an explicit resume, with no silent attribution/stock repair.
test("serving explains missing custody in Arabic then succeeds after explicit resume",async()=>{
 const l=await legacy("-serve");
 const order=await db.order.create({data:{cafeId:fx.cafeId,branchId:l.branch.id,orderNumber:1,type:"DINE_IN",source:"CASHIER_POS",status:"READY",subtotal:0,total:0,paymentStatus:"PAID",remainingAmount:0,createdById:fx.owner.id}});
 const patch=()=>as<{error:string;code:string;branchId:string}>(fx.owner.email,"/api/orders/"+order.id+"/status",{method:"PATCH",body:JSON.stringify({status:"SERVED"})});
 const refused=await patch();assert.equal(refused.status,409,refused.text);assert.match(refused.body.error,/[؀-ۿ]/);assert.equal(refused.body.code,"STOCK_CUSTODY_REQUIRED");assert.equal(refused.body.branchId,l.branch.id);
 assert.equal((await db.order.findUniqueOrThrow({where:{id:order.id}})).status,"READY");
 assert.equal((await db.custodyPeriod.findUniqueOrThrow({where:{id:l.stock}})).responsibleShiftId,null);
 const resumed=await as(fx.owner.email,"/api/shifts",{method:"POST",body:JSON.stringify({branchId:l.branch.id})});assert.equal(resumed.status,200,resumed.text);
 const served=await patch();assert.equal(served.status,200,served.text);
 const saved=await db.order.findUniqueOrThrow({where:{id:order.id}});assert.equal(saved.servedShiftId,l.shift.id);assert.equal(saved.servedStockCustodyPeriodId,l.stock);
 assert.equal(await db.inventoryTransaction.count({where:{branchId:l.branch.id}}),0);
});

// A closed or foreign shift cannot claim custody merely by passing its ID.
test("custody resume refuses closed and cross-branch shifts without changing responsibility",async()=>{
 for(const kind of ["closed","foreign"]){
  const l=await legacy("-invalid-"+kind);
  const candidate=await db.shift.create({data:{cafeId:fx.cafeId,branchId:kind==="foreign"?fx.otherBranchId:l.branch.id,cashierId:fx.manager.id,shiftNumber:kind==="foreign"?1:2,status:kind==="closed"?"CLOSED":"OPEN"}});
  await assert.rejects(()=>db.$transaction(tx=>ensureCustodyForShift(tx,{cafeId:fx.cafeId,branchId:l.branch.id,shiftId:candidate.id,userId:fx.manager.id,openingCashAmount:0})),/شيفت|shift|incoming cashier/i);
  assert.equal((await db.custodyPeriod.findUniqueOrThrow({where:{id:l.stock}})).responsibleShiftId,null);
  assert.equal(await db.shiftCustody.count({where:{shiftId:candidate.id}}),0);
 }
});

// A recovery action must not fabricate an opening drawer/amount.
test("resume-only refuses when no own shift exists without opening custody",async()=>{
 const branch=await db.branch.create({data:{cafeId:fx.cafeId,name:fx.marker+"-resume-only"}});
 const r=await as(fx.owner.email,"/api/shifts",{method:"POST",body:JSON.stringify({branchId:branch.id,resumeOnly:true})});
 assert.equal(r.status,409,r.text);assert.equal(await db.shift.count({where:{branchId:branch.id}}),0);assert.equal(await db.custodyPeriod.count({where:{branchId:branch.id}}),0);
});
// Conditional responsibility assignment has one winner even when coworkers resume together.
test("concurrent coworker claims record one responsible shift and one audit",async()=>{
 const l=await legacy("-race");
 const users=[fx.manager.id,fx.cashier.id];const shifts=await Promise.all(users.map((cashierId,i)=>db.shift.create({data:{cafeId:fx.cafeId,branchId:l.branch.id,cashierId,shiftNumber:i+2}})));
 await Promise.all(shifts.map(s=>db.$transaction(tx=>ensureCustodyForShift(tx,{cafeId:fx.cafeId,branchId:l.branch.id,shiftId:s.id,userId:s.cashierId,openingCashAmount:0}))));
 const saved=await db.custodyPeriod.findUniqueOrThrow({where:{id:l.stock}});assert.ok(shifts.some(s=>s.id===saved.responsibleShiftId));
 assert.equal(await db.auditLog.count({where:{entityId:l.stock,action:"STOCK_CUSTODY_RESPONSIBILITY_ASSIGNED"}}),1);
});

// An acceptance's Branch FK KEY SHARE must coexist with resume's number lock.
test("resume permits the acceptance branch FK lock while awaiting the handover row",async()=>{
 const l=await legacy("-lock-order");
 const h=await db.handoverSession.create({data:{cafeId:fx.cafeId,branchId:l.branch.id,status:"OUTGOING_SUBMITTED",outgoingShiftId:l.shift.id,outgoingUserId:fx.owner.id,outgoingStockCustodyId:l.stock}});
 let resume:ReturnType<typeof as>|undefined;
 const acceptance=db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT "id" FROM "HandoverSession" WHERE "id" = ${h.id} FOR UPDATE`;
  const ids=await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;const pid=ids[0].pid;
  resume=as(fx.owner.email,"/api/shifts",{method:"POST",body:JSON.stringify({branchId:l.branch.id,resumeOnly:true})});
  const deadline=Date.now()+5000;let blocked=false;
  while(Date.now()<deadline){
   const waiting=await db.$queryRaw<{pid:number}[]>`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`;
   if(waiting.length){blocked=true;break;}await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(blocked,true,"resume reached the handover lock");
  // Exactly the row lock required by a new custody's Branch foreign key.
  await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${l.branch.id} FOR KEY SHARE`;
 },{timeout:15000});
 const accepted=await Promise.allSettled([acceptance]);const resumed=resume?await resume:null;
 assert.equal(accepted[0].status,"fulfilled",accepted[0].status==="rejected"?String(accepted[0].reason):"");
 assert.equal(resumed?.status,200,resumed?.text);
});
