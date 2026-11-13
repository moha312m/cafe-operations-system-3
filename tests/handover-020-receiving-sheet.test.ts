import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { db, assertTestDatabase, tag, teardownTaggedCafe } from './helpers/db';
import { acknowledgeStockSheet, handoverCountVersion } from '@/lib/handover';

const cafes: string[]=[];
after(async()=>{for(const id of cafes) {
 await db.handoverStockAcknowledgement.deleteMany({where:{handover:{cafeId:id}}});
 await db.handoverSession.updateMany({where:{cafeId:id},data:{stockCountSessionId:null}});
 await db.stockCountSession.deleteMany({where:{cafeId:id}});
 // v2 (C1): a sheet difference/dispute opens a review row, which must go before its handover.
 await db.stockHandoverReview.deleteMany({where:{cafeId:id}});
 await db.handoverSession.deleteMany({where:{cafeId:id}});
 await teardownTaggedCafe(id);
}await db.$disconnect();});
async function fixture(){
 await assertTestDatabase(); const marker=tag('HND-SHEET');
 const cafe=await db.cafe.create({data:{name:marker,slug:marker.toLowerCase(),settings:{create:{}},branches:{create:{name:marker}}},include:{branches:true}});cafes.push(cafe.id);
 const branchId=cafe.branches[0].id;
 const users=await Promise.all(['out','in','other','manager'].map((key)=>db.user.create({data:{name:key,email:`${marker}-${key}@example.invalid`,passwordHash:'no-login-path',role:key==='manager'?'BRANCH_MANAGER':'CASHIER',cafeId:cafe.id,branchId}})));
 const [out,incoming,other,manager]=users;
 const shift=await db.shift.create({data:{cafeId:cafe.id,branchId,cashierId:out.id,shiftNumber:1,openingCashAmount:0,expectedCashAmount:0,status:'AWAITING_HANDOVER',financiallyClosedAt:new Date()}});
 await db.shift.create({data:{cafeId:cafe.id,branchId,cashierId:incoming.id,shiftNumber:2,openingCashAmount:0,expectedCashAmount:0,custodyGateReason:'AWAITING_CUSTODY_TRANSFER'}});
 const h=await db.handoverSession.create({data:{cafeId:cafe.id,branchId,outgoingShiftId:shift.id,outgoingUserId:out.id,status:'OUTGOING_SUBMITTED',target:'SHIFT_TO_SHIFT'}});
 const items=await Promise.all(['alpha','beta'].map(name=>db.inventoryItem.create({data:{cafeId:cafe.id,branchId,name,unit:'KG',currentStock:10,costPerUnit:0}})));
 const session=await db.stockCountSession.create({data:{cafeId:cafe.id,branchId,shiftId:shift.id,initiatedById:out.id,type:'FULL',scopeDerivation:'ALL_ELIGIBLE',status:'CONFIRMED',confirmedAt:new Date(),accountabilityContext:'HANDOVER',handoverId:h.id,lines:{create:items.map(i=>({inventoryItemId:i.id,unit:'KG',countedQuantity:10,expectedQuantity:10,effectiveCountedQuantity:10,varianceQuantity:0,countedAt:new Date(),counterId:out.id,itemVersion:BigInt(0),expectedBasis:'LEDGER',disposition:'WITHIN_TOLERANCE'}))}},include:{lines:true}});
 await db.handoverSession.update({where:{id:h.id},data:{stockCountSessionId:session.id}});
 const args={handoverId:h.id,countSessionId:session.id,countVersion:await handoverCountVersion(db,session.id),cafeId:cafe.id,viewerBranchId:branchId,acknowledgedById:incoming.id,idempotencyKey:crypto.randomUUID(),lines:session.lines.map((l,i)=>({stockCountLineId:l.id,incomingCountedQuantity:i===0?10:null}))};
 return {args,session,h,incoming,other,manager,cafe,branchId};
}
test('receiving sheet records independent count and explicit absence, actor, time; retries have one effect',async()=>{
 const {args}=await fixture();const [a,b]=await Promise.all([acknowledgeStockSheet(args),acknowledgeStockSheet(args)]);assert.equal(a.lines.length,2);assert.equal(b.lines.length,2);
 const rows=await db.handoverStockAcknowledgement.findMany({where:{handoverId:args.handoverId},orderBy:{stockCountLineId:'asc'}});assert.equal(rows.length,2);
 const measured=rows.find(r=>r.stockCountLineId===args.lines[0].stockCountLineId)!;const absent=rows.find(r=>r.stockCountLineId===args.lines[1].stockCountLineId)!;
 assert.equal(Number(measured.incomingCountedQuantity),10);assert.equal(Number(measured.varianceQuantity),0);assert.equal(absent.incomingCountedQuantity,null);assert.equal(absent.varianceQuantity,null);assert.ok(rows.every(r=>r.acknowledgedById===args.acknowledgedById&&r.acknowledgedAt));
 assert.equal(await db.auditLog.count({where:{entityId:args.handoverId,action:'HANDOVER_SHEET_ACKNOWLEDGED'}}),1);
 await assert.rejects(acknowledgeStockSheet({...args,lines:args.lines.map(l=>({...l,incomingCountedQuantity:0}))}),/مختلف|مسجل/);
});
// HND-UX-003: a different count alone no longer needs a reason (it is accepted
// and recorded); an explicit refusal does. The rollback is now proved on a
// refusal without a reason, every line or none.
test('receiving sheet rolls back every line on a refusal missing its reason; valid reason creates dispute',async()=>{
 const {args}=await fixture();const lines=args.lines.map(l=>({...l,incomingCountedQuantity:9,refuse:true}));
 await assert.rejects(acknowledgeStockSheet({...args,lines}));assert.equal(await db.handoverStockAcknowledgement.count({where:{handoverId:args.handoverId}}),0);
 const reason=await db.reasonCode.create({data:{cafeId:args.cafeId,domain:'HANDOVER',code:'CHECK',label:'Check'}});
 const r=await acknowledgeStockSheet({...args,lines:lines.map(l=>({...l,disputeReasonCodeId:reason.id}))});assert.ok(r.lines.every(l=>l.decision==='DISPUTED'));
});
test('receiving rejects stale round, duplicate lines, incomplete sheet and ineligible actor',async()=>{
 const {args,other}=await fixture();
 for(const bad of [{...args,countSessionId:'stale'},{...args,lines:[args.lines[0],args.lines[0]]},{...args,lines:[args.lines[0]]},{...args,acknowledgedById:other.id},{...args,viewerBranchId:'elsewhere'},{...args,cafeId:'elsewhere'}])await assert.rejects(acknowledgeStockSheet(bad));
 assert.equal(await db.handoverStockAcknowledgement.count({where:{handoverId:args.handoverId}}),0);
});

test('receiving rejects an edited line in the same count session',async()=>{
 const {args}=await fixture();
 await db.stockCountLine.update({where:{id:args.lines[0].stockCountLineId},data:{countedQuantity:9}});
 await assert.rejects(acknowledgeStockSheet(args),/نسخة الجرد/);
 assert.equal(await db.handoverStockAcknowledgement.count({where:{handoverId:args.handoverId}}),0);
});
