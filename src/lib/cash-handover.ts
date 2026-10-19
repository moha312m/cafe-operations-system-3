import type { Prisma } from '@prisma/client';
import { ApiError } from '@/lib/api';
import { decimal, money, validCurrencyInput } from '@/lib/money';
import { openVarianceCase } from '@/lib/variance-case';
import { auditInTransaction } from '@/lib/audit';

/** Called under the acceptance row lock; refusal rolls back the entire handover. */
export async function recordCashHandover(tx: Prisma.TransactionClient, args: {
  handoverId: string; incomingShiftId: string; incomingUserId: string; at: Date;
  verifiedById?: string;
  countedOpeningCash?: number; cashReasonCodeId?: string; cashReasonNote?: string;
}) {
  const actorId=args.verifiedById??args.incomingUserId;
  const h = await tx.handoverSession.findUniqueOrThrow({ where: { id: args.handoverId },
    select: { id:true,cafeId:true,branchId:true,outgoingShiftId:true,outgoingCashCustodyId:true,
      outgoingShift:{select:{actualCashAmount:true}} } });
  const incoming = await tx.shift.findUniqueOrThrow({where:{id:args.incomingShiftId},
    select:{cafeId:true,branchId:true,status:true,custodyGateReason:true,openingCashAmount:true}});
  if (incoming.cafeId !== h.cafeId || incoming.branchId !== h.branchId || incoming.status !== 'OPEN'
      || incoming.custodyGateReason !== 'AWAITING_CUSTODY_TRANSFER') {
    throw new ApiError(409,'الشيفت المستلم مش منتظر استلام العهدة');
  }
  const countedInput = args.countedOpeningCash ?? incoming.openingCashAmount.toString();
  if (!validCurrencyInput(countedInput) || decimal(countedInput).lt(0)) {
    throw new ApiError(400,'مبلغ النقدية المستلمة لازم يكون موجب أو صفر وبحد أقصى منزلتين عشريتين');
  }
  const counted = money(countedInput).toNumber();
  const proposed = h.outgoingShift.actualCashAmount === null ? null : money(h.outgoingShift.actualCashAmount).toNumber();
  const variance = proposed === null ? null : money(money(countedInput).minus(h.outgoingShift.actualCashAmount!)).toNumber();
  let caseId: string|null = null;
  if (variance !== null && variance !== 0) {
    if (!args.cashReasonCodeId || !args.cashReasonNote?.trim()) throw new ApiError(400,'لازم تحدد سبب فرق النقدية بين المسلم والمستلم وتكتب ملاحظة');
    const reason = await tx.reasonCode.findFirst({where:{id:args.cashReasonCodeId,cafeId:h.cafeId,domain:'HANDOVER',isActive:true},select:{id:true}});
    if (!reason) throw new ApiError(400,'سبب فرق التسليم مش صالح للكافيه');
    const exception = await tx.openingException.create({data:{cafeId:h.cafeId,branchId:h.branchId,
      shiftId:h.outgoingShiftId,custodyPeriodId:h.outgoingCashCustodyId,handoverId:h.id,kind:'CASH_MISMATCH',
      proposedAmount:proposed,actualAmount:counted,varianceAmount:variance,reasonCodeId:reason.id,
      note:args.cashReasonNote.trim(),authorizedById:actorId},select:{id:true}});
    caseId=(await openVarianceCase(tx,{cafeId:h.cafeId,branchId:h.branchId,type:'OPENING_EXCEPTION',
      shiftId:h.outgoingShiftId,custodyPeriodId:h.outgoingCashCustodyId,source:{kind:'OPENING',openingExceptionId:exception.id},
      amountVariance:variance,financialImpact:{available:true,value:Math.abs(variance)},confidence:'VERIFIED',
      acceptedHandoverId:h.id,openedById:actorId})).caseId;
  }
  await tx.handoverSession.update({where:{id:h.id},data:{proposedOpeningCash:proposed,countedOpeningCash:counted,
    cashVarianceAmount:variance,cashVerifiedAt:args.at,cashVerifiedById:actorId}});
  // Sales are still blocked by the custody gate: this changes the opening, never past collections.
  await tx.shift.update({where:{id:args.incomingShiftId},data:{openingCashAmount:counted,expectedCashAmount:counted}});
  await auditInTransaction(tx,{cafeId:h.cafeId,userId:actorId,action:'HANDOVER_CASH_VERIFIED',
    entity:'HandoverSession',entityId:h.id,details:{proposed,counted,variance,caseId,incomingShiftId:args.incomingShiftId}});
  return {proposed,counted,variance,caseId};
}
