import { money as exactMoney, validCurrencyInput } from "@/lib/money";
import type { Prisma } from '@prisma/client';
import { ApiError } from '@/lib/api';
import { auditInTransaction } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth';
import { openVarianceCase } from '@/lib/variance-case';
import { protectedTransaction, protectedContext } from '@/lib/protected-transaction';
import { lockShifts, lockBranchAllocator } from '@/lib/transaction-locks';
import { isBranchStaff, projectStaffBranch } from '@/lib/staff-branch';

export type CashDisposition = { leftInDrawer: number; toTreasury: number; note?: string };
export const money = (amount: number) => exactMoney(amount).toNumber();
export function requireCashAmount(amount: number, signed = false): number {
  if (!validCurrencyInput(amount) || (!signed && amount < 0)) {
    throw new ApiError(400, 'Enter a valid cash amount with at most two decimal places');
  }
  return money(amount);
}
export function validateCashDisposition(actualCash: number, disposition: CashDisposition) {
  requireCashAmount(actualCash);
  const left = requireCashAmount(disposition.leftInDrawer);
  const treasury = requireCashAmount(disposition.toTreasury);
  if (!exactMoney(left).plus(exactMoney(treasury)).eq(exactMoney(actualCash))) throw new ApiError(400, 'Drawer cash plus treasury cash must equal the physical closing count');
  if ((disposition.note?.length ?? 0) > 1000) throw new ApiError(400, 'Note is too long');
}

export async function recordNightCash(tx: Prisma.TransactionClient, args: {
  cafeId: string; branchId: string; shiftId: string; handoverId: string;
  actorId: string; actualCash: number; disposition: CashDisposition;
}): Promise<{ storageId: string }> {
  validateCashDisposition(args.actualCash, args.disposition);
  const [shift, handover, actor, settings] = await Promise.all([
    tx.shift.findUnique({where:{id:args.shiftId}}),
    tx.handoverSession.findUnique({where:{id:args.handoverId}}),
    tx.user.findUnique({where:{id:args.actorId}}),
    tx.branchOpeningSettings.findUnique({where:{branchId:args.branchId}}),
  ]);
  if (!shift || !handover || shift.cafeId !== args.cafeId || shift.branchId !== args.branchId || handover.cafeId !== args.cafeId || handover.branchId !== args.branchId || handover.outgoingShiftId !== shift.id || handover.target !== 'BRANCH_CUSTODY') {
    throw new ApiError(403, 'Night cash must belong to this branch closing handover');
  }
  if (!actor?.isActive || actor.archivedAt || (actor.role !== 'SUPER_ADMIN' && actor.cafeId !== args.cafeId)) throw new ApiError(403, 'ليس لديك صلاحية لتنفيذ الإجراء ده');
  const assignment=await projectStaffBranch(tx,actor);
  if ((isBranchStaff(actor.role)&&!assignment.branchId) || (actor.role!=='SUPER_ADMIN'&&assignment.branchId&&assignment.branchId!==args.branchId)) throw new ApiError(403,'عهدة الخزنة تبع فرع تاني');
  if(await tx.shift.count({where:{branchId:args.branchId,id:{not:args.shiftId},status:'OPEN',custodyGateReason:null}})) throw new ApiError(409,'Close other operational shifts before declaring night drawer storage');
  const storage = await tx.cashStorage.create({data:{
    cafeId:args.cafeId,branchId:args.branchId,outgoingShiftId:args.shiftId,handoverId:args.handoverId,
    closingAmount:money(args.actualCash),leftInDrawer:money(args.disposition.leftInDrawer),toTreasury:money(args.disposition.toTreasury),
    drawerLabel:settings?.drawerLabel ?? 'Main drawer',declaredById:args.actorId,note:args.disposition.note?.trim() || null,
  }});
  await auditInTransaction(tx,{cafeId:args.cafeId,userId:args.actorId,action:'NIGHT_CASH_DECLARED',entity:'CashStorage',entityId:storage.id,details:{branchId:args.branchId,shiftId:args.shiftId,handoverId:args.handoverId,closingAmount:money(args.actualCash),leftInDrawer:money(args.disposition.leftInDrawer),toTreasury:money(args.disposition.toTreasury)}});
  return {storageId:storage.id};
}

export async function moveStoredCash(args: { storageId: string; actor: SessionUser; amount: number; reason: string; idempotencyKey?: string }) {
  const amount = requireCashAmount(args.amount,true);
  const reason = args.reason.trim();
  if (!amount || !reason || reason.length > 1000) throw new ApiError(400,'A nonzero amount and reason are required');
  if (args.actor.role !== 'CAFE_OWNER' || !args.actor.cafeId) throw new ApiError(403,'Only the cafe owner may move stored cash');
  return protectedTransaction(async tx => {
    const actor=await tx.user.findUnique({where:{id:args.actor.id}});
    if (!actor?.isActive || actor.archivedAt || actor.role !== 'CAFE_OWNER' || actor.cafeId !== args.actor.cafeId) throw new ApiError(403,'ليس لديك صلاحية لتنفيذ الإجراء ده');
    const scope={cafeId:actor.cafeId!,...(actor.branchId?{branchId:actor.branchId}:{})};
    protectedContext(tx).scope=scope;
    const candidate=await tx.cashStorage.findFirst({where:{id:args.storageId,...scope}});
    if(!candidate)throw new ApiError(403,'ليس لديك صلاحية لتنفيذ الإجراء ده');
    await lockBranchAllocator(tx,candidate.branchId);
    const rows=await tx.$queryRaw<{id:string}[]>`SELECT id FROM "CashStorage" WHERE id=${candidate.id} AND "cafeId"=${candidate.cafeId} AND "branchId"=${candidate.branchId} FOR UPDATE`;
    if(rows.length!==1)throw new ApiError(409,'عهدة الخزنة اتغيرت — جرّب تاني');
    protectedContext(tx).trace.push({entity:'CashStorage',ids:rows.map(row=>row.id),mode:'FOR UPDATE'});
    if(args.idempotencyKey) {
      const prior=await tx.cashStorageMovement.findUnique({where:{storageId_idempotencyKey:{storageId:candidate.id,idempotencyKey:args.idempotencyKey}}});
      if(prior) {
        if(!exactMoney(prior.amount).eq(amount) || prior.reason!==reason || prior.actorId!==actor.id) throw new ApiError(409,'مفتاح العملية ده مستخدم لحركة خزنة مختلفة');
        return prior;
      }
    }
    const receipt=await tx.openingCashReceipt.findUnique({where:{storageId:candidate.id}});
    if(receipt?.acceptedAt) throw new ApiError(409,'The drawer has already been received');
    if(await tx.shift.count({where:{branchId:candidate.branchId,status:'OPEN',custodyGateReason:null}})) throw new ApiError(409,'Close operational shifts before moving stored drawer cash');
    const movements=await tx.cashStorageMovement.aggregate({where:{storageId:candidate.id},_sum:{amount:true}});
    const expected=exactMoney(candidate.leftInDrawer).plus(movements._sum.amount ?? 0).toNumber();
    requireCashAmount(exactMoney(expected).plus(amount).toNumber());
    const movement=await tx.cashStorageMovement.create({data:{cafeId:candidate.cafeId,storageId:candidate.id,amount,actorId:actor.id,reason,idempotencyKey:args.idempotencyKey}});
    await auditInTransaction(tx,{cafeId:candidate.cafeId,userId:actor.id,action:'NIGHT_CASH_MOVEMENT',entity:'CashStorage',entityId:candidate.id,details:{movementId:movement.id,amount,expectedBefore:expected,expectedAfter:exactMoney(expected).plus(amount).toNumber(),reason}});
    return movement;
  });
}

/** Claim structurally under the same Branch lock used by opening and close. */
export async function claimOpeningCash(tx: Prisma.TransactionClient, args: { shiftId: string; actorId: string }): Promise<{ receiptId: string|null }> {
  const shift=await tx.shift.findUnique({where:{id:args.shiftId}});
  if(!shift || shift.status!=='OPEN' || shift.cashierId!==args.actorId)throw new ApiError(403,'Only the incoming cashier may claim this drawer');
  await tx.$queryRaw`SELECT id FROM "Branch" WHERE id=${shift.branchId} FOR NO KEY UPDATE`;
  const prior=await tx.openingCashReceipt.findUnique({where:{incomingShiftId:shift.id}});
  if(prior)return {receiptId:prior.id};
  const storage=await tx.cashStorage.findFirst({where:{cafeId:shift.cafeId,branchId:shift.branchId,declaredAt:{lte:shift.openedAt},OR:[{receipt:{is:null}},{receipt:{is:{acceptedAt:null}}}]},orderBy:[{declaredAt:'desc'},{id:'desc'}],include:{receipt:true}});
  if(!storage)return {receiptId:null};
  await tx.$queryRaw`SELECT id FROM "CashStorage" WHERE id=${storage.id} FOR UPDATE`;
  if(storage.receipt)throw new ApiError(409,'Another incoming shift is already confirming this drawer');
  const movements=await tx.cashStorageMovement.aggregate({where:{storageId:storage.id},_sum:{amount:true}});
  const expected=exactMoney(storage.leftInDrawer).plus(movements._sum.amount ?? 0).toNumber();
  requireCashAmount(expected);
  const receipt=await tx.openingCashReceipt.create({data:{cafeId:shift.cafeId,branchId:shift.branchId,storageId:storage.id,incomingShiftId:shift.id,claimantId:args.actorId,expectedAmount:expected}});
  await tx.shift.update({where:{id:shift.id},data:{openingCashAmount:0,expectedCashAmount:0}});
  await tx.openingCashReceiptEvent.create({data:{cafeId:shift.cafeId,receiptId:receipt.id,actorId:args.actorId,action:'CLAIMED',details:{expected}}});
  await auditInTransaction(tx,{cafeId:shift.cafeId,userId:args.actorId,action:'OPENING_CASH_CLAIMED',entity:'OpeningCashReceipt',entityId:receipt.id,details:{storageId:storage.id,shiftId:shift.id,expected}});
  return {receiptId:receipt.id};
}

async function lockedReceipt(tx: Prisma.TransactionClient, receiptId: string, actorId: string, override: boolean) {
  const candidate=await tx.openingCashReceipt.findUnique({where:{id:receiptId}});
  const actor=await tx.user.findUnique({where:{id:actorId}});
  if(!candidate || !actor?.isActive || actor.archivedAt || candidate.cafeId!==actor.cafeId)throw new ApiError(403,'Not allowed');
  const assignment = await projectStaffBranch(tx, actor);
  if ((assignment.branchId && candidate.branchId !== assignment.branchId) || (isBranchStaff(actor.role) && !assignment.branchId)) throw new ApiError(403,'Not allowed');
  if(override) {
    if(actor.role!=='CAFE_OWNER')throw new ApiError(403,'Only the cafe owner may override a cash receipt');
  } else if(candidate.claimantId!==actorId)throw new ApiError(403,'Only the named incoming cashier may confirm this drawer');
  protectedContext(tx).scope = { cafeId: candidate.cafeId, branchId: candidate.branchId };
  await lockShifts(tx, [candidate.incomingShiftId]);
  await lockBranchAllocator(tx, candidate.branchId);
  const storage = await tx.$queryRaw<{id:string}[]>`SELECT id FROM "CashStorage" WHERE id=${candidate.storageId} AND "cafeId"=${candidate.cafeId} AND "branchId"=${candidate.branchId} FOR UPDATE`;
  if (storage.length !== 1) throw new ApiError(403,'Not allowed');
  protectedContext(tx).trace.push({ entity: 'CashStorage', ids: storage.map(row=>row.id), mode: 'FOR UPDATE' });
  await tx.$queryRaw`SELECT id FROM "OpeningCashReceipt" WHERE id=${candidate.id} AND "cafeId"=${candidate.cafeId} AND "branchId"=${candidate.branchId} FOR UPDATE`;
  protectedContext(tx).trace.push({ entity: 'OpeningCashReceipt', ids: [candidate.id], mode: 'FOR UPDATE' });
  return tx.openingCashReceipt.findUniqueOrThrow({where:{id:candidate.id},include:{storage:{include:{handover:true}},incomingShift:true,openingException:{select:{varianceCase:{select:{id:true}}}}}});
}

export async function acceptOpeningCash(args: { receiptId:string;actorId:string;countedCash:number;reasonCodeId?:string;note?:string;idempotencyKey:string;override?:boolean }): Promise<{alreadyAccepted:boolean;shiftId:string;caseId:string|null}> {
  const counted=requireCashAmount(args.countedCash);
  const note=args.note?.trim() || null;
  if(!args.idempotencyKey.trim() || args.idempotencyKey.length>100 || (note?.length ?? 0)>1000)throw new ApiError(400,'A valid receipt key and note are required');
  const fingerprint=JSON.stringify({counted,reasonCodeId:args.reasonCodeId??null,note,override:args.override??false,actorId:args.actorId});
  return protectedTransaction(async tx=>{
    const receipt=await lockedReceipt(tx,args.receiptId,args.actorId,args.override??false);
    if(receipt.acceptedAt) {
      if(receipt.idempotencyKey!==args.idempotencyKey || receipt.acceptanceFingerprint!==fingerprint)throw new ApiError(409,'This drawer receipt was already accepted with different evidence');
      return {alreadyAccepted:true,shiftId:receipt.incomingShiftId,caseId:receipt.openingException?.varianceCase?.id ?? null};
    }
    if(receipt.incomingShift.status!=='OPEN' || receipt.incomingShift.cashierId!==receipt.claimantId || receipt.incomingShift.cafeId!==receipt.cafeId || receipt.incomingShift.branchId!==receipt.branchId)throw new ApiError(409,'Receipt does not belong to an open incoming shift');
    if(receipt.storage.handover.status!=='COMPLETED' || receipt.storage.handover.target!=='BRANCH_CUSTODY')throw new ApiError(409,'Complete the night branch handover before receiving its cash');
    const cash=await tx.shiftCustody.findUnique({where:{shiftId_scope:{shiftId:receipt.incomingShiftId,scope:'CASH'}},include:{custodyPeriod:{include:{participants:true}}}});
    if(!cash || cash.custodyPeriod.status!=='OPEN' || cash.custodyPeriod.holderType!=='USER' || cash.custodyPeriod.cafeId!==receipt.cafeId || cash.custodyPeriod.branchId!==receipt.branchId || !cash.custodyPeriod.participants.some(p=>p.userId===receipt.claimantId))throw new ApiError(409,'The incoming shift needs its provisional cash custody first');
    if(await tx.payment.count({where:{shiftId:receipt.incomingShiftId,status:'PAID'}}))throw new ApiError(409,'Cannot rewrite an opening after financial movements');
    const otherAccepted=await tx.shiftCustody.count({where:{custodyPeriodId:cash.custodyPeriodId,shiftId:{not:receipt.incomingShiftId},shift:{openingCashReceipt:{is:{acceptedAt:{not:null}}}}}});
    if(otherAccepted)throw new ApiError(409,'This cash custody already has another accepted opening');
    const movements=await tx.cashStorageMovement.aggregate({where:{storageId:receipt.storageId},_sum:{amount:true}});
    const expected=requireCashAmount(exactMoney(receipt.storage.leftInDrawer).plus(movements._sum.amount ?? 0).toNumber());
    const variance=exactMoney(counted).minus(expected).toNumber();
    let exceptionId:string|null=null,caseId:string|null=null;
    if(variance!==0 || args.override) {
      if(!args.reasonCodeId || !note)throw new ApiError(400,'A reason and note are required for a drawer difference or owner override');
      const reason=await tx.reasonCode.findFirst({where:{id:args.reasonCodeId,cafeId:receipt.cafeId,domain:'HANDOVER',isActive:true}});
      if(!reason)throw new ApiError(400,'Use an active handover reason from this cafe');
      if(variance!==0) {
        const exception=await tx.openingException.create({data:{cafeId:receipt.cafeId,branchId:receipt.branchId,handoverId:receipt.storage.handoverId,kind:'OVERNIGHT_CASH_MISMATCH',proposedAmount:expected,actualAmount:counted,varianceAmount:variance,reasonCodeId:reason.id,note,authorizedById:args.actorId}});
        exceptionId=exception.id;
        caseId=(await openVarianceCase(tx,{cafeId:receipt.cafeId,branchId:receipt.branchId,type:'OPENING_EXCEPTION',source:{kind:'OPENING',openingExceptionId:exception.id},amountVariance:variance,financialImpact:{available:true,value:Math.abs(variance)},confidence:'VERIFIED',openedById:args.actorId})).caseId;
      }
    }
    const at=new Date();
    await tx.shift.update({where:{id:receipt.incomingShiftId},data:{openingCashAmount:counted,expectedCashAmount:counted}});
    await tx.custodyPeriod.update({where:{id:cash.custodyPeriodId},data:{openingCashAmount:counted}});
    const status=args.override?'OVERRIDDEN':'ACCEPTED';
    await tx.openingCashReceipt.update({where:{id:receipt.id},data:{status,expectedAmount:expected,actualAmount:counted,varianceAmount:variance,verifiedById:args.actorId,acceptedAt:at,idempotencyKey:args.idempotencyKey,acceptanceFingerprint:fingerprint,openingExceptionId:exceptionId}});
    await tx.openingCashReceiptEvent.create({data:{cafeId:receipt.cafeId,receiptId:receipt.id,actorId:args.actorId,action:status,note,details:{expected,counted,variance,caseId}}});
    await auditInTransaction(tx,{cafeId:receipt.cafeId,userId:args.actorId,action:'OPENING_CASH_ACCEPTED',entity:'OpeningCashReceipt',entityId:receipt.id,details:{shiftId:receipt.incomingShiftId,storageId:receipt.storageId,expected,counted,variance,caseId,status,note}});
    return {alreadyAccepted:false,shiftId:receipt.incomingShiftId,caseId};
  });
}

export async function updateOpeningCashReview(args: { receiptId:string;actorId:string;action:'DISPUTE'|'DEFER';note:string }): Promise<void> {
  const note=args.note.trim();
  if(!note || note.length>1000 || !['DISPUTE','DEFER'].includes(args.action))throw new ApiError(400,'Record a review action and note');
  await protectedTransaction(async tx=>{
    const receipt=await lockedReceipt(tx,args.receiptId,args.actorId,false);
    if(receipt.acceptedAt || receipt.incomingShift.status!=='OPEN')throw new ApiError(409,'A completed receipt cannot be rewritten');
    const status=args.action==='DISPUTE'?'DISPUTED':'DEFERRED';
    await tx.openingCashReceipt.update({where:{id:receipt.id},data:{status}});
    await tx.openingCashReceiptEvent.create({data:{cafeId:receipt.cafeId,receiptId:receipt.id,actorId:args.actorId,action:args.action,note}});
    await auditInTransaction(tx,{cafeId:receipt.cafeId,userId:args.actorId,action:'OPENING_CASH_REVIEWED',entity:'OpeningCashReceipt',entityId:receipt.id,details:{status,note}});
  });
}
