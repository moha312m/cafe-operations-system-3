import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, teardownTaggedCafe } from './helpers/db';
import { countCafe, type CountCafe } from './helpers/count';
import { as, requireServer } from './helpers/http';
let fx:CountCafe,other:CountCafe;
const at=new Date('2026-10-03T22:05:00Z');
before(async()=>{
  await requireServer();fx=await countCafe('EMPLOYEEREPORT');other=await countCafe('EMPLOYEEREPORTX');
  const shift=await db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.cashier.id,shiftNumber:55,status:'CLOSED',openingCashAmount:100,expectedCashAmount:100,actualCashAmount:75,cashDifference:-25,cashReasonNote:'Overpaid change',financiallyClosedAt:at,openedAt:at}});
  await db.varianceCase.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,shiftId:shift.id,type:'CASH',openedById:fx.manager.id,openedAt:at,amountVariance:-25,financialImpact:25,financialImpactAvailable:true,confidence:'VERIFIED'}});
});
after(async()=>{await teardownTaggedCafe(fx.cafeId);await teardownTaggedCafe(other.cafeId,[],{disconnect:true});});
test('employee report returns names, dates and reasons on the Cairo calendar day',async()=>{
  const r=await as<{rows:Array<{employee:{id:string};reason:string;variance:number}>}>(fx.manager.email,'/api/reports/employee-variances?range=custom_day&date=2026-10-04');
  assert.equal(r.status,200,r.text);assert.equal(r.body.rows.length,1);assert.equal(r.body.rows[0].employee.id,fx.cashier.id);assert.equal(r.body.rows[0].reason,'Overpaid change');assert.equal(r.body.rows[0].variance,-25);
});
test('month and custom ranges include the case but the previous Cairo day excludes it',async()=>{
  const prior=await as<{rows:unknown[]}>(fx.manager.email,'/api/reports/employee-variances?range=custom_day&date=2026-10-03');
  assert.equal(prior.status,200,prior.text);assert.equal(prior.body.rows.length,0);
  const month=await as<{rows:unknown[]}>(fx.manager.email,'/api/reports/employee-variances?range=custom_range&from=2026-10-01&to=2026-10-31');
  assert.equal(month.status,200,month.text);assert.equal(month.body.rows.length,1);
});
test('a different cafe and a foreign employee cannot leak through report filters',async()=>{
  const r=await as<{rows:unknown[]}>(other.manager.email,'/api/reports/employee-variances?range=custom_day&date=2026-10-04');
  assert.equal(r.status,200,r.text);assert.equal(r.body.rows.length,0);
  const foreign=await as(fx.manager.email,'/api/reports/employee-variances?employeeId='+other.cashier.id);
  assert.equal(foreign.status,400,foreign.text);
  const branch=await as(fx.manager.email,'/api/reports/employee-variances?branchId='+fx.otherBranchId);
  assert.equal(branch.status,403,branch.text);
});
test('invalid date range is refused instead of silently reporting today',async()=>{
  const r=await as(fx.manager.email,'/api/reports/employee-variances?range=custom_range&from=2026-10-10&to=2026-10-01');
  assert.equal(r.status,400,r.text);
});

test('verified stock belongs to its custodian while a period shortage preserves context only',async()=>{
  const shift=await db.shift.findFirstOrThrow({where:{cafeId:fx.cafeId,shiftNumber:55}});
  const custody=await db.custodyPeriod.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,scope:'STOCK',status:'CLOSED',responsibleShiftId:shift.id,endedAt:at,participants:{create:{userId:fx.cashier.id,role:'PRIMARY'}}}});
  const h=await db.handoverSession.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,outgoingShiftId:shift.id,outgoingUserId:fx.cashier.id,status:'COMPLETED',acceptedAt:at,completedAt:at}});
  for(const verified of [true,false]){
    const item=await db.inventoryItem.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,name:verified?'Verified beans':'Uncertain beans',unit:'KG',currentStock:10,costPerUnit:100}});
    const count=await db.stockCountSession.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,type:'FULL',scopeDerivation:'ALL_ELIGIBLE',status:'CONFIRMED',initiatedById:fx.manager.id,lines:{create:{inventoryItemId:item.id,unit:'KG',expectedQuantity:10,countedQuantity:9.98,effectiveCountedQuantity:9.98,varianceQuantity:-0.02,reasonNote:'20g missing',confidence:verified?'VERIFIED':'PARTIAL'}}},select:{lines:{select:{id:true}}}});
    await db.varianceCase.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,type:'STOCK',stockCountLineId:count.lines[0].id,openedById:fx.manager.id,openedAt:at,quantityVariance:-0.02,confidence:verified?'VERIFIED':'PARTIAL',attribution:verified?'VERIFIED_SHIFT':'PERIOD_UNRESOLVED',custodyPeriodId:verified?custody.id:null,shiftId:verified?shift.id:null,acceptedHandoverId:h.id,financialImpactAvailable:verified,financialImpact:verified?2:null,amountVariance:verified?2:null}});
  }
  const r=await as<{rows:Array<{item:{name:string}|null;employee:{id:string}|null;responsibility:string;relatedEmployees:Array<{id:string}>}>;employees:Array<{employee:{id:string};totals:{STOCK:{shortage:number}}}>}>(fx.manager.email,'/api/reports/employee-variances?range=custom_day&date=2026-10-04&employeeId='+fx.cashier.id);
  assert.equal(r.status,200,r.text);
  assert.equal(r.body.rows.find(x=>x.item?.name==='Verified beans')?.employee?.id,fx.cashier.id);
  const uncertain=r.body.rows.find(x=>x.item?.name==='Uncertain beans')!;
  assert.equal(uncertain.employee,null);assert.equal(uncertain.responsibility,'UNRESOLVED');assert.ok(uncertain.relatedEmployees.some(x=>x.id===fx.cashier.id));
  assert.equal(r.body.employees[0].totals.STOCK.shortage,2);
});
test('responsibility cannot be approved without naming the employee',async()=>{
  const c=await db.varianceCase.findFirstOrThrow({where:{cafeId:fx.cafeId,type:'CASH'}});
  const investigate=await as(fx.manager.email,'/api/variances/'+c.id+'/advance',{method:'POST',body:JSON.stringify({to:'UNDER_INVESTIGATION'})});
  assert.equal(investigate.status,200,investigate.text);
  const unnamed=await as(fx.manager.email,'/api/variances/'+c.id+'/advance',{method:'POST',body:JSON.stringify({to:'RESPONSIBILITY_ASSIGNED'})});
  assert.equal(unnamed.status,400,unnamed.text);
});
test('case review presents employee names for choosing the responsible person',async()=>{
  const c=await db.varianceCase.findFirstOrThrow({where:{cafeId:fx.cafeId,type:'CASH'}});
  const r=await as<{responsibilityCandidates:Array<{id:string;name:string}>}>(fx.manager.email,'/api/variances/'+c.id);
  assert.equal(r.status,200,r.text);assert.ok(r.body.responsibilityCandidates?.some(p=>p.id===fx.cashier.id));
});

test('uncertain responsibility cannot be smuggled into an investigation transition',async()=>{
  const c=await db.varianceCase.findFirstOrThrow({where:{cafeId:fx.cafeId,type:'STOCK',confidence:'PARTIAL'}});
  const r=await as(fx.manager.email,'/api/variances/'+c.id+'/advance',{method:'POST',body:JSON.stringify({to:'UNDER_INVESTIGATION',assignedResponsibilityUserId:fx.cashier.id})});
  assert.equal(r.status,400,r.text);
  assert.equal((await db.varianceCase.findUniqueOrThrow({where:{id:c.id}})).assignedResponsibilityUserId,null);
});
test('named responsibility is persisted and appears in the employee report',async()=>{
  const c=await db.varianceCase.findFirstOrThrow({where:{cafeId:fx.cafeId,type:'CASH'}});
  const r=await as(fx.manager.email,'/api/variances/'+c.id+'/advance',{method:'POST',body:JSON.stringify({to:'RESPONSIBILITY_ASSIGNED',assignedResponsibilityUserId:fx.cashier.id,note:'Reviewed drawer evidence'})});
  assert.equal(r.status,200,r.text);
  const report=await as<{rows:Array<{id:string;responsibility:string;assignedResponsibility:{id:string}|null}>}>(fx.manager.email,'/api/reports/employee-variances?range=custom_day&date=2026-10-04&employeeId='+fx.cashier.id);
  assert.equal(report.status,200,report.text);
  const row=report.body.rows.find(x=>x.id===c.id)!;
  assert.equal(row.responsibility,'ASSIGNED');assert.equal(row.assignedResponsibility?.id,fx.cashier.id);
});