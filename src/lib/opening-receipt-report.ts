import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
export type ReceiptPerson={id:string;name:string};
export type OpeningReceiptRow={
  id:string;branch:{id:string;name:string};shift:{id:string;number:number;openedAt:string}|null;
  incomingEmployee:ReceiptPerson|null;nightEmployee:ReceiptPerson|null;declaredBy:ReceiptPerson|null;verifiedBy:ReceiptPerson|null;
  declaredAt:string|null;acceptedAt:string|null;closingAmount:number|null;leftInDrawer:number|null;toTreasury:number|null;
  expectedAmount:number|null;countedAmount:number|null;variance:number|null;cashStatus:string;stockStatus:string;placeStatus:string;placeInspector:ReceiptPerson|null;placeAcceptedBy:ReceiptPerson|null;placeAcceptedAt:string|null;placeFaults:number;placeOpenIncidents:number;
  handoverId:string|null;note:string|null;events:Array<{action:string;actor:ReceiptPerson;at:string;note:string|null}>;
};
export type OpeningReceiptReport={rows:OpeningReceiptRow[];totals:{receipts:number;matching:number;shortage:number;surplus:number;pending:number}};
const PERSON={id:true,name:true} as const;
const STORAGE={id:true,handoverId:true,closingAmount:true,leftInDrawer:true,toTreasury:true,note:true,declaredAt:true,declaredBy:{select:PERSON},outgoingShift:{select:{cashier:{select:PERSON}}},movements:{select:{amount:true}}} as const;
const RECEIPT={id:true,status:true,expectedAmount:true,actualAmount:true,varianceAmount:true,acceptedAt:true,claimant:{select:PERSON},verifiedBy:{select:PERSON},events:{select:{action:true,note:true,createdAt:true,actor:{select:PERSON}},orderBy:{createdAt:'asc' as const}},storage:{select:STORAGE}} as const;
const PENDING_STORAGE={...STORAGE,branch:{select:{id:true,name:true}}} as const;
type PendingStorage=Prisma.CashStorageGetPayload<{select:typeof PENDING_STORAGE}>;
const SELECT={handoversIncoming:{where:{status:'COMPLETED',target:'SHIFT_TO_SHIFT',cashVerifiedAt:{not:null}},select:{id:true,proposedOpeningCash:true,countedOpeningCash:true,cashVarianceAmount:true,cashVerifiedAt:true,cashVerifiedBy:{select:PERSON},outgoingUser:{select:PERSON}},orderBy:{cashVerifiedAt:'desc' as const},take:1},id:true,shiftNumber:true,openedAt:true,cashier:{select:PERSON},branch:{select:{id:true,name:true}},cashStorage:{select:{id:true}},openingCashReceipt:{select:RECEIPT},stockCountSessions:{where:{accountabilityContext:'BRANCH_OPENING_VERIFICATION' as const},select:{status:true},orderBy:{createdAt:'desc' as const},take:1},placeReceipt:{select:{status:true,acceptedBy:{select:PERSON},acceptedAt:true,assignedUser:{select:PERSON},observations:{select:{actor:{select:PERSON},condition:true,incident:{select:{status:true}}}}}}} satisfies Prisma.ShiftSelect;
type Shift=Prisma.ShiftGetPayload<{select:typeof SELECT}>;
const money=(n:number)=>Math.round(n*100)/100;
function placeData(shift:Shift){const p=shift.placeReceipt;const faults=p?.observations.filter(o=>o.condition==='FAULT').length??0;const open=p?.observations.filter(o=>o.incident?.status==='OPEN').length??0;const status=!p?'NOT_RECORDED':p.status==='ACCEPTED'?'ACCEPTED':p.status==='OVERRIDDEN'?'OVERRIDDEN':faults?'FAULT':p.observations.length?'IN_PROGRESS':'PENDING';return {placeStatus:status,placeInspector:p?.assignedUser??null,placeAcceptedBy:p?.acceptedBy??null,placeAcceptedAt:p?.acceptedAt?.toISOString()??null,placeFaults:faults,placeOpenIncidents:open};}
function rowForShift(shift:Shift):OpeningReceiptRow {
  const receipt=shift.openingCashReceipt,storage=receipt?.storage;
  const direct=shift.handoversIncoming[0];
  if(!receipt && direct)return {id:'direct:'+direct.id,branch:shift.branch,shift:{id:shift.id,number:shift.shiftNumber,openedAt:shift.openedAt.toISOString()},incomingEmployee:shift.cashier,nightEmployee:direct.outgoingUser,declaredBy:null,verifiedBy:direct.cashVerifiedBy,declaredAt:null,acceptedAt:direct.cashVerifiedAt?.toISOString()??null,closingAmount:null,leftInDrawer:null,toTreasury:null,expectedAmount:direct.proposedOpeningCash===null?null:Number(direct.proposedOpeningCash),countedAmount:direct.countedOpeningCash===null?null:Number(direct.countedOpeningCash),variance:direct.cashVarianceAmount===null?null:Number(direct.cashVarianceAmount),cashStatus:direct.countedOpeningCash!==null&&direct.cashVerifiedBy?'ACCEPTED':'INCOMPLETE_EVIDENCE',stockStatus:shift.stockCountSessions[0]?.status==='LOCKED'?'ACCEPTED':shift.stockCountSessions[0]?.status??'NOT_RECORDED',...placeData(shift),handoverId:direct.id,note:null,events:direct.cashVerifiedBy&&direct.cashVerifiedAt?[{action:'ACCEPTED',actor:direct.cashVerifiedBy,at:direct.cashVerifiedAt.toISOString(),note:'Direct shift-to-shift cash count'}]:[]};
  return {id:receipt?`cash:${receipt.id}`:`shift:${shift.id}`,branch:shift.branch,shift:{id:shift.id,number:shift.shiftNumber,openedAt:shift.openedAt.toISOString()},incomingEmployee:receipt?.claimant??shift.cashier,
    nightEmployee:storage?.outgoingShift.cashier??null,declaredBy:storage?.declaredBy??null,verifiedBy:receipt?.verifiedBy??null,
    declaredAt:storage?.declaredAt.toISOString()??null,acceptedAt:receipt?.acceptedAt?.toISOString()??null,
    closingAmount:storage?Number(storage.closingAmount):null,leftInDrawer:storage?Number(storage.leftInDrawer):null,toTreasury:storage?Number(storage.toTreasury):null,
    expectedAmount:receipt?receipt.acceptedAt?Number(receipt.expectedAmount):money(Number(storage!.leftInDrawer)+storage!.movements.reduce((sum,m)=>sum+Number(m.amount),0)):null,
    countedAmount:receipt?.actualAmount===null||receipt?.actualAmount===undefined?null:Number(receipt.actualAmount),variance:receipt?.varianceAmount===null||receipt?.varianceAmount===undefined?null:Number(receipt.varianceAmount),
    cashStatus:receipt?.status??'NOT_DECLARED',stockStatus:shift.stockCountSessions[0]?.status==='LOCKED'?'ACCEPTED':shift.stockCountSessions[0]?.status??'NOT_RECORDED',...placeData(shift),
    handoverId:storage?.handoverId??null,note:storage?.note??null,events:receipt?.events.map(e=>({action:e.action,actor:e.actor,at:e.createdAt.toISOString(),note:e.note}))??[]};
}
export async function loadOpeningReceipts(args:{cafeId:string;branchId?:string;employeeId?:string;from:Date;to:Date}):Promise<OpeningReceiptReport> {
  const rows:OpeningReceiptRow[]=[];let cursor:string|undefined;
  while(true){
    const shifts=await db.shift.findMany({where:{cafeId:args.cafeId,...(args.branchId?{branchId:args.branchId}:{}),OR:[{handoversIncoming:{some:{cashVerifiedAt:{gte:args.from,lte:args.to}}}},{openedAt:{gte:args.from,lte:args.to}},{openingCashReceipt:{is:{events:{some:{createdAt:{gte:args.from,lte:args.to}}}}}},{placeReceipt:{is:{acceptedAt:{gte:args.from,lte:args.to}}}},{placeReceipt:{is:{observations:{some:{createdAt:{gte:args.from,lte:args.to}}}}}}]},select:SELECT,orderBy:{id:'asc'},take:500,...(cursor?{cursor:{id:cursor},skip:1}:{})});
    for(const shift of shifts){if(shift.cashStorage && !shift.openingCashReceipt)continue;rows.push(rowForShift(shift));}
    if(shifts.length<500)break;cursor=shifts[shifts.length-1].id;
  }
  cursor=undefined;
  while(true){
    const storages:PendingStorage[]=await db.cashStorage.findMany({where:{cafeId:args.cafeId,...(args.branchId?{branchId:args.branchId}:{}),declaredAt:{gte:args.from,lte:args.to},receipt:{is:null}},select:PENDING_STORAGE,orderBy:{id:'asc'},take:500,...(cursor?{cursor:{id:cursor},skip:1}:{})});
    for(const s of storages)rows.push({id:`storage:${s.id}`,branch:s.branch,shift:null,incomingEmployee:null,nightEmployee:s.outgoingShift.cashier,declaredBy:s.declaredBy,verifiedBy:null,declaredAt:s.declaredAt.toISOString(),acceptedAt:null,closingAmount:Number(s.closingAmount),leftInDrawer:Number(s.leftInDrawer),toTreasury:Number(s.toTreasury),expectedAmount:money(Number(s.leftInDrawer)+s.movements.reduce((sum,m)=>sum+Number(m.amount),0)),countedAmount:null,variance:null,cashStatus:'AWAITING_CLAIM',stockStatus:'NOT_RECORDED',placeStatus:'NOT_RECORDED',placeInspector:null,placeAcceptedBy:null,placeAcceptedAt:null,placeFaults:0,placeOpenIncidents:0,handoverId:s.handoverId,note:s.note,events:[]});
    if(storages.length<500)break;cursor=storages[storages.length-1].id;
  }
  const filtered=rows.filter(r=>!args.employeeId || [r.incomingEmployee?.id,r.nightEmployee?.id,r.declaredBy?.id,r.verifiedBy?.id,r.placeInspector?.id,r.placeAcceptedBy?.id,...r.events.map(e=>e.actor.id)].includes(args.employeeId));
  filtered.sort((a,b)=>(b.shift?.openedAt??b.declaredAt??'').localeCompare(a.shift?.openedAt??a.declaredAt??'')||a.id.localeCompare(b.id));
  return {rows:filtered,totals:{receipts:filtered.filter(r=>r.cashStatus!=='NOT_DECLARED').length,matching:filtered.filter(r=>r.variance===0).length,shortage:money(filtered.reduce((sum,r)=>sum+Math.max(0,-(r.variance??0)),0)),surplus:money(filtered.reduce((sum,r)=>sum+Math.max(0,r.variance??0),0)),pending:filtered.filter(r=>['PENDING','DEFERRED','DISPUTED','AWAITING_CLAIM'].includes(r.cashStatus)).length}};
}


