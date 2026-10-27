import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {db,teardownTaggedCafe} from './helpers/db';
import {countCafe,type CountCafe} from './helpers/count';
import {as} from './helpers/http';
let fx:CountCafe,other:CountCafe,assetId:string,checkpointId:string;
before(async()=>{fx=await countCafe('PLACE001');other=await countCafe('PLACE001-FOREIGN');});
after(async()=>{if(fx)await teardownTaggedCafe(fx.cafeId);if(other)await teardownTaggedCafe(other.cafeId);await db.$disconnect();});
async function shift(n:number){return db.shift.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,cashierId:fx.cashier.id,shiftNumber:n,status:'CLOSED',closedAt:new Date()}});}
async function receipt(n:number){const s=await shift(n);const r=await as<{receipt:{id:string;snapshot:Array<{name:string;checkpoints:Array<{id:string}>}>}}>(fx.owner.email,'/api/place-receipts',{method:'POST',body:JSON.stringify({shiftId:s.id,assignedUserId:fx.storekeeper.id})});assert.equal(r.status,201,r.text);return r.body.receipt;}
test('owner defines assets/checkpoints; staff cannot configure another place',async()=>{
 const bad=await as(fx.manager.email,'/api/place-assets',{method:'POST',body:JSON.stringify({branchId:fx.branchId,name:'Espresso',checkpoints:[{label:'Pressure',required:true,critical:true}]})});assert.equal(bad.status,403,bad.text);
 const r=await as<{asset:{id:string;checkpoints:Array<{id:string}>}}>(fx.owner.email,'/api/place-assets',{method:'POST',body:JSON.stringify({branchId:fx.branchId,name:'Espresso',area:'Bar',checkpoints:[{label:'Pressure',required:true,critical:true}]})});assert.equal(r.status,201,r.text);assetId=r.body.asset.id;checkpointId=r.body.asset.checkpoints[0].id;
 const cross=await as(other.owner.email,'/api/place-assets/'+assetId,{method:'PATCH',body:JSON.stringify({name:'Intruder'})});assert.equal(cross.status,403,cross.text);
});
test('receipt snapshots survive rename; named inspector signs once and others cannot',async()=>{
 const r=await receipt(1);
 assert.equal(r.snapshot[0].name,'Espresso');
 const rename=await as(fx.owner.email,'/api/place-assets/'+assetId,{method:'PATCH',body:JSON.stringify({name:'Renamed mill'})});assert.equal(rename.status,200,rename.text);
 const route='/api/place-receipts/'+r.id;
 const wrong=await as(fx.cashier.email,route,{method:'PATCH',body:JSON.stringify({action:'OBSERVE',assetId,checkpointId,side:'INCOMING',condition:'OK'})});assert.equal(wrong.status,403,wrong.text);
 const observe=await as(fx.storekeeper.email,route,{method:'PATCH',body:JSON.stringify({action:'OBSERVE',assetId,checkpointId,side:'INCOMING',condition:'OK'})});assert.equal(observe.status,200,observe.text);
 const key=crypto.randomUUID();for(let i=0;i<2;i++){const accept=await as(fx.storekeeper.email,route,{method:'PATCH',body:JSON.stringify({action:'ACCEPT',idempotencyKey:key})});assert.equal(accept.status,200,accept.text);}
 const got=await as<{receipt:{snapshot:Array<{name:string}>;acceptedBy:{id:string};events:Array<{action:string}>}}>(fx.owner.email,route);assert.equal(got.status,200,got.text);assert.equal(got.body.receipt.snapshot[0].name,'Espresso');assert.equal(got.body.receipt.acceptedBy.id,fx.storekeeper.id);assert.equal(got.body.receipt.events.filter(e=>e.action==='ACCEPTED').length,1);
 const locked=await as(fx.storekeeper.email,route,{method:'PATCH',body:JSON.stringify({action:'OBSERVE',assetId,checkpointId,side:'INCOMING',condition:'FAULT',note:'Later'})});assert.equal(locked.status,409,locked.text);
});
test('required missing/fault refuses ordinary acceptance; override records reason and repair preserves fault',async()=>{
 const r=await receipt(2),route='/api/place-receipts/'+r.id;
 const missing=await as(fx.storekeeper.email,route,{method:'PATCH',body:JSON.stringify({action:'ACCEPT',idempotencyKey:crypto.randomUUID()})});assert.equal(missing.status,400,missing.text);
 const fault=await as<{observationId:string;incidentId:string}>(fx.storekeeper.email,route,{method:'PATCH',body:JSON.stringify({action:'OBSERVE',assetId,checkpointId,side:'INCOMING',condition:'FAULT',note:'Existing cracked gauge'})});assert.equal(fault.status,200,fault.text);
 const fail=await as(fx.storekeeper.email,route,{method:'PATCH',body:JSON.stringify({action:'ACCEPT',idempotencyKey:crypto.randomUUID()})});assert.equal(fail.status,400,fail.text);
 const deny=await as(fx.storekeeper.email,route,{method:'PATCH',body:JSON.stringify({action:'ACCEPT',idempotencyKey:crypto.randomUUID(),overrideReason:'Keep open'})});assert.equal(deny.status,403,deny.text);
 const override=await as(fx.manager.email,route,{method:'PATCH',body:JSON.stringify({action:'ACCEPT',idempotencyKey:crypto.randomUUID(),overrideReason:'Use other machine; repair requested'})});assert.equal(override.status,200,override.text);
 const repair=await as(fx.owner.email,'/api/place-incidents/'+fault.body.incidentId+'/resolve',{method:'POST',body:JSON.stringify({repairNote:'Gauge replaced'})});assert.equal(repair.status,200,repair.text);
 const history=await as<{receipt:{observations:Array<{condition:string;incident:{status:string;repairNote:string}|null}>}}>(fx.owner.email,route);assert.equal(history.status,200,history.text);assert.equal(history.body.receipt.observations[0].condition,'FAULT');assert.equal(history.body.receipt.observations[0].incident?.status,'RESOLVED');
});
test('mandatory empty checklist or foreign inspector cannot be enabled; legacy branches stay optional',async()=>{
 const invalid=await as(fx.owner.email,`/api/branches/${fx.otherBranchId}/opening-settings`,{method:'PATCH',body:JSON.stringify({placeAcceptanceRequired:true,placeInspectorId:fx.storekeeper.id})});assert.equal(invalid.status,400,invalid.text);
 const foreign=await as(fx.owner.email,`/api/branches/${fx.branchId}/opening-settings`,{method:'PATCH',body:JSON.stringify({placeAcceptanceRequired:true,placeInspectorId:other.cashier.id})});assert.equal(foreign.status,400,foreign.text);
 const optional=await as<{settings:{placeAcceptanceRequired:boolean}}>(fx.owner.email,`/api/branches/${fx.otherBranchId}/opening-settings`);assert.equal(optional.status,200,optional.text);assert.equal(optional.body.settings.placeAcceptanceRequired,false);
});

test('mandatory place receipt gates a new shift until its named inspector accepts it',async()=>{
  const settings=await as(fx.owner.email,'/api/branches/'+fx.branchId+'/opening-settings',{method:'PATCH',body:JSON.stringify({placeAcceptanceRequired:true,placeInspectorId:fx.storekeeper.id})});
  assert.equal(settings.status,200,settings.text);
  const opened=await as<{shift:{id:string}}>(fx.cashier.email,'/api/shifts',{method:'POST',body:JSON.stringify({branchId:fx.branchId,openingCashAmount:200})});
  assert.equal(opened.status,201,opened.text);
  const pending=await as<{shift:unknown;pendingShift:{id:string;placeReceipt:{id:string;status:string;assignedUser:{id:string}}}}>(fx.cashier.email,'/api/shifts/active');
  assert.equal(pending.status,200,pending.text);assert.equal(pending.body.shift,null);assert.equal(pending.body.pendingShift.id,opened.body.shift.id);assert.equal(pending.body.pendingShift.placeReceipt.status,'PENDING');assert.equal(pending.body.pendingShift.placeReceipt.assignedUser.id,fx.storekeeper.id);
  const receiptId=pending.body.pendingShift.placeReceipt.id, route='/api/place-receipts/'+receiptId;
  const observe=await as(fx.storekeeper.email,route,{method:'PATCH',body:JSON.stringify({action:'OBSERVE',assetId,checkpointId,side:'INCOMING',condition:'OK'})});assert.equal(observe.status,200,observe.text);
  const accepted=await as(fx.storekeeper.email,route,{method:'PATCH',body:JSON.stringify({action:'ACCEPT',idempotencyKey:crypto.randomUUID()})});assert.equal(accepted.status,200,accepted.text);
  const ready=await as<{shift:{id:string};pendingShift:null}>(fx.cashier.email,'/api/shifts/active');assert.equal(ready.status,200,ready.text);assert.equal(ready.body.shift.id,opened.body.shift.id);assert.equal(ready.body.pendingShift,null);
});
