import type { Prisma } from '@prisma/client';
import { ApiError } from '@/lib/api';
import { EFFECTIVE_EVIDENCE_SELECT } from '@/lib/count-evidence';
import { handoverLineObservation, matchingHandoverLine } from '@/lib/handover-count-match';
import { acquireInventorySharedLocks, activeFreezeFor } from '@/lib/inventory-freeze';
import { lockItemForUpdate } from '@/lib/ledger';
import { defaultKeysForRole } from '@/lib/perms/templates';
import { CAFE_KEYS } from '@/lib/perms/catalog';
import { staffBranchSelect, projectStaffBranch, isBranchStaff } from '@/lib/staff-branch';

export const COUNT_SYSTEM_VALIDATED = 'COUNT_SYSTEM_VALIDATED';
/**
 * HND-UX-004: a complete, current outgoing count whose quantities differ from
 * the book, recorded as the outgoing employee observed it. Never a match and
 * never a manager signature: `confirmedById` stays NULL and this audit row is
 * the evidence. The owner reviews the differences later, in the reports.
 */
export const COUNT_OUTGOING_DECLARED = 'COUNT_OUTGOING_DECLARED';

/** Same serialization boundary as handover submit, receiving and recount. */
export async function lockHandoverCount(tx: Prisma.TransactionClient, sessionId: string) {
  const candidate = await tx.stockCountSession.findUnique({where:{id:sessionId},select:{handoverId:true,accountabilityContext:true}});
  if (candidate?.accountabilityContext !== 'HANDOVER' || !candidate.handoverId) return false;
  await tx.$queryRaw`SELECT "id" FROM "HandoverSession" WHERE "id"=${candidate.handoverId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "StockCountSession" WHERE "id"=${sessionId} FOR UPDATE`;
  return true;
}

/** Resolve current permission and effective branch inside the transaction. */
export async function assertHandoverCountActor(tx: Prisma.TransactionClient, args: {actorId:string;cafeId:string;branchId:string;key:'stock_count.submit'|'stock_count.confirm'|'handover.accept'}) {
  const actor = await tx.user.findUnique({where:{id:args.actorId},select:{...staffBranchSelect,isActive:true,
    cafeRole:{select:{isActive:true,permissions:{select:{permissionKey:true,allowed:true}}}},
    permissionOverrides:{select:{permissionKey:true,allowed:true}}}});
  if (!actor || !actor.isActive || (actor.role !== 'SUPER_ADMIN' && actor.cafeId !== args.cafeId)) throw new ApiError(403,'ليس لديك صلاحية لتقديم هذا الجرد');
  const scope = await projectStaffBranch(tx, actor);
  if ((isBranchStaff(actor.role) && !scope.branchId) || (scope.branchId && scope.branchId !== args.branchId)) throw new ApiError(403,'ليس لديك صلاحية على فرع تاني');
  let keys = new Set(actor.cafeRole?.isActive ? actor.cafeRole.permissions.filter(p=>p.allowed).map(p=>p.permissionKey) : defaultKeysForRole(actor.role));
  if (actor.role === 'CAFE_OWNER' || actor.role === 'SUPER_ADMIN') keys = new Set([...keys,...CAFE_KEYS]);
  for (const entry of actor.permissionOverrides) { if(entry.allowed) keys.add(entry.permissionKey); else keys.delete(entry.permissionKey); }
  const settings = await tx.cafeSettings.findUnique({where:{cafeId:args.cafeId},select:{inventoryEnabled:true}});
  if (!keys.has(args.key) || settings?.inventoryEnabled === false) throw new ApiError(403,'ليس لديك صلاحية لتقديم هذا الجرد');
}

/** Call with the handover and session locks held; inventory locks persist to commit. */
export async function matchingHandoverCountEvidence(tx: Prisma.TransactionClient, sessionId: string) {
  return handoverCountEvidence(tx, sessionId, 'MATCH');
}

/** Complete current evidence whether or not it matches; null when anything is missing or stale. */
export async function declaredHandoverCountEvidence(tx: Prisma.TransactionClient, sessionId: string) {
  return handoverCountEvidence(tx, sessionId, 'DECLARE');
}

async function handoverCountEvidence(tx: Prisma.TransactionClient, sessionId: string, mode: 'MATCH'|'DECLARE') {
  const session = await tx.stockCountSession.findUnique({where:{id:sessionId},select:{id:true,cafeId:true,branchId:true,
    handoverId:true,accountabilityContext:true,status:true,shiftId:true,custodyPeriodId:true,
    lines:{select:{...EFFECTIVE_EVIDENCE_SELECT,inventoryItemId:true,unit:true,disposition:true}}}});
  if (!session || session.accountabilityContext !== 'HANDOVER' || !session.handoverId || !['SUBMITTED','RECOUNT_REQUIRED','CONFIRMED'].includes(session.status)) return null;
  const handover = await tx.handoverSession.findUnique({where:{id:session.handoverId},select:{id:true,cafeId:true,branchId:true,
    status:true,stockCountSessionId:true,stockMode:true,target:true,requiredItemTrigger:true,requiredItemCount:true,
    outgoingShiftId:true,outgoingStockCustodyId:true,
    outgoingShift:{select:{status:true,financiallyClosedAt:true,stockClosedAt:true}},
    outgoingStockCustody:{select:{status:true,scope:true}},
    requiredItems:{select:{inventoryItemId:true,unitSnapshot:true,omitted:true}}}});
  if (!handover || !['DRAFT','REJECTED','OUTGOING_SUBMITTED','INCOMING_REVIEW'].includes(handover.status) ||
      handover.stockCountSessionId !== session.id || handover.cafeId !== session.cafeId || handover.branchId !== session.branchId ||
      !handover.stockMode || !handover.target || !handover.requiredItemTrigger ||
      handover.outgoingShiftId !== session.shiftId || handover.outgoingStockCustodyId !== session.custodyPeriodId ||
      handover.outgoingShift.status !== 'AWAITING_HANDOVER' || !handover.outgoingShift.financiallyClosedAt || handover.outgoingShift.stockClosedAt ||
      handover.outgoingStockCustody?.status !== 'OPEN' || handover.outgoingStockCustody.scope !== 'STOCK') return null;
  if (!handover.requiredItems.length || handover.requiredItemCount !== handover.requiredItems.length ||
      handover.requiredItems.some(i=>i.omitted) || session.lines.length !== handover.requiredItems.length) return null;
  const required = new Map(handover.requiredItems.map(i=>[i.inventoryItemId,i.unitSnapshot]));
  if (session.lines.some(l=>required.get(l.inventoryItemId) !== l.unit)) return null;
  if (await tx.stockCountCorrection.count({where:{line:{sessionId},status:'PENDING_APPROVAL'}})) return null;
  if (await tx.handoverStockAcknowledgement.count({where:{handoverId:handover.id,line:{sessionId},decision:'DISPUTED'}})) return null;
  await acquireInventorySharedLocks(tx,[session.branchId]);
  const freeze = await activeFreezeFor(tx,session.branchId);
  if (freeze?.handoverId !== handover.id) return null;
  const observations: {lineId:string;itemVersion:string;countedAt:string;quantity:string;sourceId:string|null}[]=[];
  const differenceLineIds: string[] = [];
  for (const line of [...session.lines].sort((a,b)=>a.inventoryItemId.localeCompare(b.inventoryItemId))) {
    const item = await lockItemForUpdate(tx,line.inventoryItemId);
    const observed = handoverLineObservation(line,item.ledgerVersion);
    if (!observed || (mode === 'MATCH' && !matchingHandoverLine(line,item.ledgerVersion))) return null;
    if (observed.difference !== 0) differenceLineIds.push(line.id);
    const recount=line.recounts[0]; const correction=line.corrections[0];
    observations.push({lineId:line.id,itemVersion:String(item.ledgerVersion),countedAt:(recount?.countedAt??line.countedAt)!.toISOString(),
      quantity:String(recount?.countedQuantity??correction?.newCountedQuantity??line.countedQuantity),sourceId:recount?.id??correction?.id??null});
  }
  return {sessionId:session.id,handoverId:handover.id,branchId:session.branchId,observations,differenceLineIds};
}

/** An old automatic result cannot endorse a correction/recount written later. */
export async function systemValidationIsCurrent(tx: Prisma.TransactionClient, sessionId: string): Promise<boolean> {
  return recordedEvidenceIsCurrent(tx, sessionId, COUNT_SYSTEM_VALIDATED);
}

/** The same staleness rule for a recorded outgoing declaration (HND-UX-004). */
export async function outgoingDeclarationIsCurrent(tx: Prisma.TransactionClient, sessionId: string): Promise<boolean> {
  return recordedEvidenceIsCurrent(tx, sessionId, COUNT_OUTGOING_DECLARED);
}

/** Which unsigned evidence confirmed this count, if either is still current. */
export async function currentUnsignedCountEvidence(tx: Prisma.TransactionClient, sessionId: string): Promise<'SYSTEM_MATCH'|'OUTGOING_DECLARED'|null> {
  if (await systemValidationIsCurrent(tx, sessionId)) return 'SYSTEM_MATCH';
  if (await outgoingDeclarationIsCurrent(tx, sessionId)) return 'OUTGOING_DECLARED';
  return null;
}

async function recordedEvidenceIsCurrent(tx: Prisma.TransactionClient, sessionId: string, action: string): Promise<boolean> {
  const session=await tx.stockCountSession.findUnique({where:{id:sessionId},select:{status:true,confirmedById:true}});
  if(!session || session.status!=='CONFIRMED' || session.confirmedById!==null) return false;
  const audit=await tx.auditLog.findFirst({where:{entity:'StockCountSession',entityId:sessionId,action},orderBy:{createdAt:'desc'},select:{details:true}});
  if(!audit) return false;
  const evidence=action===COUNT_SYSTEM_VALIDATED?await matchingHandoverCountEvidence(tx,sessionId):await declaredHandoverCountEvidence(tx,sessionId);
  if(!evidence) return false;
  const recorded=audit.details as {observations?:typeof evidence.observations;handoverId?:string};
  // jsonb normalizes object key order; compare explicit ordered tuples.
  const tuples=(observations:typeof evidence.observations)=>observations.map(o=>[o.lineId,o.itemVersion,o.countedAt,o.quantity,o.sourceId]);
  return recorded.handoverId===evidence.handoverId && Array.isArray(recorded.observations) &&
    JSON.stringify(tuples(recorded.observations))===JSON.stringify(tuples(evidence.observations));
}


/** Receiving consent belongs to one immutable round; use requestRecount to replace it. */
export async function assertHandoverCorrectionRoundOpen(tx: Prisma.TransactionClient, sessionId: string) {
  const session=await tx.stockCountSession.findUnique({where:{id:sessionId},select:{handoverId:true}});
  if(!session?.handoverId) return;
  const handover=await tx.handoverSession.findUnique({where:{id:session.handoverId},select:{status:true,stockCountSessionId:true}});
  if(handover?.stockCountSessionId !== sessionId) return;
  const acknowledged=await tx.handoverStockAcknowledgement.count({where:{handoverId:session.handoverId,line:{sessionId}}});
  if(acknowledged || ["COMPLETED","ACCEPTED","MANAGER_EXCEPTION"].includes(handover.status)) {
    throw new ApiError(409,"تم توقيع هذا الجرد — اطلب إعادة الجرد في جولة جديدة قبل التصحيح");
  }
}
