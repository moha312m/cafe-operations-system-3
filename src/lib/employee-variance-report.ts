import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { round2, round3 } from '@/lib/costing';

export type VarianceEmployee = {id:string;name:string};
export type VarianceCategory = 'CASH'|'CARD'|'WALLET'|'TENDER'|'STOCK'|'HANDOVER_CASH'|'OPENING';
export type EmployeeVarianceRow = {
  id:string;category:VarianceCategory;type:string;status:string;openedAt:string;
  custodian?:VarianceEmployee|null;
  outgoingEmployee?:VarianceEmployee|null;incomingEmployee?:VarianceEmployee|null;
  employee:VarianceEmployee|null;relatedEmployees:VarianceEmployee[];assignedResponsibility:VarianceEmployee|null;
  responsibility:'CUSTODY'|'ASSIGNED'|'UNRESOLVED'|'BRANCH';confidence:string;attribution:string;
  expected:number|null;actual:number|null;variance:number|null;amountVariance:number|null;financialImpact:number|null;
  item:{id:string;name:string}|null;unit:string|null;reason:string|null;
  shift:{id:string;number:number;openedAt:string}|null;branch:{id:string;name:string};handoverId:string|null;
};
const CATEGORIES: VarianceCategory[]=['CASH','CARD','WALLET','TENDER','STOCK','HANDOVER_CASH','OPENING'];
const totals=()=>Object.fromEntries(CATEGORIES.map(c=>[c,{shortage:0,surplus:0,count:0,unpriced:0}])) as Record<VarianceCategory,{shortage:number;surplus:number;count:number;unpriced:number}>;
export function summarizeEmployeeVariances(source:EmployeeVarianceRow[],employeeId?:string) {
  const rows=source.filter(r=>!employeeId || r.employee?.id===employeeId || r.assignedResponsibility?.id===employeeId || r.relatedEmployees.some(e=>e.id===employeeId));
  const groups=new Map<string,{employee:VarianceEmployee;totals:ReturnType<typeof totals>;stock:Array<{itemId:string;name:string;unit:string;shortage:number;surplus:number}>;unresolvedCount:number}>();
  const ensure=(e:VarianceEmployee)=>{let g=groups.get(e.id);if(!g){g={employee:e,totals:totals(),stock:[],unresolvedCount:0};groups.set(e.id,g);}return g;};
  const unresolved:EmployeeVarianceRow[]=[];
  for(const r of rows){
    const uncertain=r.responsibility==='UNRESOLVED'||r.responsibility==='BRANCH'||!r.employee;
    if(uncertain){unresolved.push(r);for(const e of r.relatedEmployees){if(!employeeId||employeeId===e.id)ensure(e).unresolvedCount++;}continue;}
    const g=ensure(r.employee!);const t=g.totals[r.category];t.count++;
    const signed=r.variance??r.amountVariance;
    const value=r.category==='STOCK'?r.financialImpact:r.amountVariance;
    if(value===null)t.unpriced++;
    else if(signed!==null&&signed<0)t.shortage=round2(t.shortage+Math.abs(value));
    else if(signed!==null&&signed>0)t.surplus=round2(t.surplus+Math.abs(value));
    if(r.category==='STOCK'&&r.item&&r.unit&&signed!==null){
      let item=g.stock.find(s=>s.itemId===r.item!.id&&s.unit===r.unit);
      if(!item){item={itemId:r.item.id,name:r.item.name,unit:r.unit,shortage:0,surplus:0};g.stock.push(item);}
      if(signed<0)item.shortage=round3(item.shortage+Math.abs(signed));else item.surplus=round3(item.surplus+signed);
    }
  }
  return {rows,employees:[...groups.values()].sort((a,b)=>a.employee.name.localeCompare(b.employee.name,'ar')),unresolved};
}

const PERSON={id:true,name:true} as const;
const SHIFT={id:true,shiftNumber:true,openedAt:true,expectedCashAmount:true,actualCashAmount:true,cashReasonNote:true,cashier:{select:PERSON},handoversOutgoing:{select:{id:true,outgoingUser:{select:PERSON},incomingUser:{select:PERSON}},orderBy:{createdAt:"desc"},take:1}} as const;
const CUSTODY={holderType:true,participants:{select:{user:{select:PERSON}}},responsibleShift:{select:SHIFT}} as const;
const SELECT={id:true,type:true,status:true,openedAt:true,amountVariance:true,quantityVariance:true,financialImpact:true,financialImpactAvailable:true,
  confidence:true,attribution:true,shift:{select:SHIFT},cashShift:{select:SHIFT},branch:{select:{id:true,name:true}},
  custodyPeriod:{select:CUSTODY},assignedResponsibility:{select:PERSON},
  stockCountLine:{select:{unit:true,expectedQuantity:true,countedQuantity:true,effectiveCountedQuantity:true,varianceQuantity:true,reasonNote:true,
    inventoryItem:{select:PERSON}}},
  tenderReconciliation:{select:{method:true,expectedAmount:true,actualAmount:true,varianceAmount:true,reasonNote:true}},
  openingException:{select:{kind:true,proposedAmount:true,actualAmount:true,varianceAmount:true,note:true,overnightReceipt:{select:{claimant:{select:PERSON},storage:{select:{outgoingShift:{select:{cashier:{select:PERSON}}}}}}},reasonCode:{select:{label:true}}}},
  acceptedHandover:{select:{id:true,outgoingUser:{select:PERSON},incomingUser:{select:PERSON},outgoingShift:{select:SHIFT}}},
  varianceSpan:{select:{custodyLinks:{select:{custodyPeriod:{select:CUSTODY}}}}},
} satisfies Prisma.VarianceCaseSelect;
type Case=Prisma.VarianceCaseGetPayload<{select:typeof SELECT}>;
const num=(v:unknown)=>v===null||v===undefined?null:Number(v);
function project(c:Case):EmployeeVarianceRow {
  const shift=c.shift??c.cashShift??c.custodyPeriod?.responsibleShift??c.acceptedHandover?.outgoingShift??null;
  const transfer=c.acceptedHandover??shift?.handoversOutgoing[0]??null;
  const people=c.custodyPeriod?.participants.map(p=>p.user)??[];
  const related=new Map<string,VarianceEmployee>();
  for(const p of [...people,...(c.varianceSpan?.custodyLinks.flatMap(s=>s.custodyPeriod.participants.map(p=>p.user))??[])])related.set(p.id,p);
  if(shift)related.set(shift.cashier.id,shift.cashier);
  if(c.acceptedHandover)related.set(c.acceptedHandover.outgoingUser.id,c.acceptedHandover.outgoingUser);
  if(c.assignedResponsibility)related.set(c.assignedResponsibility.id,c.assignedResponsibility);
  const stock=c.type==='STOCK';
  const overnight=c.openingException?.kind==='OVERNIGHT_CASH_MISMATCH';
  if(c.openingException?.overnightReceipt){const receipt=c.openingException.overnightReceipt;related.set(receipt.claimant.id,receipt.claimant);const outgoing=receipt.storage.outgoingShift.cashier;related.set(outgoing.id,outgoing);}
  const uncertain=overnight||stock&&(!['VERIFIED_SHIFT','BRANCH_CUSTODY'].includes(c.attribution)||c.confidence!=='VERIFIED');
  const branch=c.custodyPeriod?.holderType==='BRANCH'||c.attribution==='BRANCH_CUSTODY';
  const custodian=uncertain||branch?null:people.length===1?people[0]:people.length>1?null:shift?.cashier??null;
  const employee=c.assignedResponsibility??custodian;
  const category:VarianceCategory=stock?'STOCK':c.type==='CASH'?'CASH':c.tenderReconciliation?(['CARD','WALLET','CASH'].includes(c.tenderReconciliation.method)?c.tenderReconciliation.method as VarianceCategory:'TENDER'):['CASH_MISMATCH','OVERNIGHT_CASH_MISMATCH'].includes(c.openingException?.kind ?? '')?'HANDOVER_CASH':'OPENING';
  const s=c.stockCountLine,t=c.tenderReconciliation,o=c.openingException;
  return {custodian,outgoingEmployee:c.openingException?.overnightReceipt?.storage.outgoingShift.cashier??transfer?.outgoingUser??null,incomingEmployee:c.openingException?.overnightReceipt?.claimant??transfer?.incomingUser??null,id:c.id,category,type:c.type,status:c.status,openedAt:c.openedAt.toISOString(),employee,relatedEmployees:[...related.values()],assignedResponsibility:c.assignedResponsibility,
    responsibility:c.assignedResponsibility?'ASSIGNED':branch?'BRANCH':employee?'CUSTODY':'UNRESOLVED',confidence:c.confidence,attribution:c.attribution,
    expected:stock?num(s?.expectedQuantity):t?num(t.expectedAmount):o?num(o.proposedAmount):num(shift?.expectedCashAmount),
    actual:stock?num(s?.effectiveCountedQuantity??s?.countedQuantity):t?num(t.actualAmount):o?num(o.actualAmount):num(shift?.actualCashAmount),
    variance:stock?num(c.quantityVariance):num(c.amountVariance),amountVariance:num(c.amountVariance),
    financialImpact:c.financialImpactAvailable?num(c.financialImpact):null,item:s?.inventoryItem??null,unit:s?.unit??null,
    reason:stock?(s?.reasonNote??null):t?t.reasonNote:o?(o.note??o.reasonCode.label):shift?.cashReasonNote??null,
    shift:shift?{id:shift.id,number:shift.shiftNumber,openedAt:shift.openedAt.toISOString()}:null,branch:c.branch,handoverId:c.acceptedHandover?.id??null};
}

export async function loadEmployeeVariances(args:{cafeId:string;branchId?:string;from:Date;to:Date;employeeId?:string;handoverId?:string}) {
  const handover=args.handoverId?await db.handoverSession.findFirst({where:{id:args.handoverId,cafeId:args.cafeId,...(args.branchId?{branchId:args.branchId}:{})},select:{outgoingShiftId:true}}):null;
  if(args.handoverId&&!handover)return summarizeEmployeeVariances([],args.employeeId);
  const cases:Case[]=[];let cursor:string|undefined;
  // The old board's 200-row cap must never become a monthly report's total.
  while(true){
    const batch=await db.varianceCase.findMany({where:{cafeId:args.cafeId,...(args.branchId?{branchId:args.branchId}:{}),
      ...(args.handoverId?{OR:[{acceptedHandoverId:args.handoverId},{shiftId:handover!.outgoingShiftId}]}:{openedAt:{gte:args.from,lte:args.to}})},
      select:SELECT,orderBy:{id:'asc'},take:500,...(cursor?{cursor:{id:cursor},skip:1}:{})});
    cases.push(...batch);if(batch.length<500)break;cursor=batch[batch.length-1].id;
  }
  const rows=cases.map(project);
  // Historical transfers without verification remain disclosed; do not fabricate a case or backfill blame.
  const legacy=await db.handoverSession.findMany({where:{cafeId:args.cafeId,status:'COMPLETED',target:'SHIFT_TO_SHIFT',cashVerifiedAt:null,
    ...(args.branchId?{branchId:args.branchId}:{}),...(args.handoverId?{id:args.handoverId}:{acceptedAt:{gte:args.from,lte:args.to}})},
    select:{id:true,acceptedAt:true,outgoingUser:{select:PERSON},incomingUser:{select:PERSON},outgoingShift:{select:SHIFT},
      incomingShift:{select:{openingCashAmount:true}},branch:{select:{id:true,name:true}}}});
  for(const h of legacy){const expected=num(h.outgoingShift.actualCashAmount),actual=num(h.incomingShift?.openingCashAmount);
    if(expected===null||actual===null||round2(actual-expected)===0)continue;
    rows.push({id:`legacy:${h.id}`,category:'HANDOVER_CASH',type:'OPENING_EXCEPTION',status:'UNRECORDED',openedAt:h.acceptedAt!.toISOString(),
      employee:null,relatedEmployees:[h.outgoingUser,...(h.incomingUser?[h.incomingUser]:[])],assignedResponsibility:null,responsibility:'UNRESOLVED',
      confidence:'UNVERIFIABLE',attribution:'NOT_APPLICABLE',expected,actual,variance:round2(actual-expected),amountVariance:round2(actual-expected),financialImpact:null,
      item:null,unit:null,reason:'تسليم سابق: افتتاح المستلم مختلف عن مبلغ المسلم، بدون تسجيل عد نقدي معتمد',
      shift:{id:h.outgoingShift.id,number:h.outgoingShift.shiftNumber,openedAt:h.outgoingShift.openedAt.toISOString()},branch:h.branch,handoverId:h.id});
  }
  rows.sort((a,b)=>b.openedAt.localeCompare(a.openedAt)||a.id.localeCompare(b.id));
  return summarizeEmployeeVariances(rows,args.employeeId);
}
