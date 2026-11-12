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
    select:{cafeId:true,branchId:true,status:true,custodyGateReason:true,openingCashAmount:true,expectedCashAmount:true}});
  // A colleague who is still trading on the SAME drawer receives too (owner
  // decision 2026-11-11, simulation F-064). They are operational, not gated,
  // and must already be a holder of the outgoing drawer — nobody else.
  const colleague = incoming.custodyGateReason === null && !!h.outgoingCashCustodyId
    && (await tx.shiftCustody.count({where:{shiftId:args.incomingShiftId,custodyPeriodId:h.outgoingCashCustodyId}})) > 0;
  if (incoming.cafeId !== h.cafeId || incoming.branchId !== h.branchId || incoming.status !== 'OPEN'
      || (incoming.custodyGateReason !== 'AWAITING_CUSTODY_TRANSFER' && !colleague)) {
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
    // A receipt difference is a recorded observation, not a manager exception.
    // A reason/note may be supplied independently; neither is invented or required.
    const reasonCodeId = args.cashReasonCodeId ?? null;
    const note = args.cashReasonNote?.trim() || null;
    if (reasonCodeId) {
      const reason = await tx.reasonCode.findFirst({where:{id:reasonCodeId,cafeId:h.cafeId,domain:'HANDOVER',isActive:true},select:{id:true}});
      if (!reason) throw new ApiError(400,'سبب فرق التسليم مش صالح للكافيه');
    }
    const exception = await tx.openingException.create({data:{cafeId:h.cafeId,branchId:h.branchId,
      shiftId:h.outgoingShiftId,custodyPeriodId:h.outgoingCashCustodyId,handoverId:h.id,kind:'CASH_MISMATCH',
      proposedAmount:proposed,actualAmount:counted,varianceAmount:variance,reasonCodeId,
      note,authorizedById:actorId},select:{id:true}});
    caseId=(await openVarianceCase(tx,{cafeId:h.cafeId,branchId:h.branchId,type:'OPENING_EXCEPTION',
      shiftId:h.outgoingShiftId,custodyPeriodId:h.outgoingCashCustodyId,source:{kind:'OPENING',openingExceptionId:exception.id},
      amountVariance:variance,financialImpact:{available:true,value:Math.abs(variance)},confidence:'VERIFIED',
      acceptedHandoverId:h.id,openedById:actorId})).caseId;
  }
  await tx.handoverSession.update({where:{id:h.id},data:{proposedOpeningCash:proposed,countedOpeningCash:counted,
    cashVarianceAmount:variance,cashVerifiedAt:args.at,cashVerifiedById:actorId}});
  if (colleague) {
    // The colleague's own collections are already in this drawer and in their
    // expected figure (opening + their net cash). Their opening becomes the
    // counted drawer less their own net cash so far, so that from now on
    // "expected" equals what was counted at this moment plus what follows —
    // never their sales twice. Past collections are not touched.
    const ownNet = money(incoming.expectedCashAmount).minus(incoming.openingCashAmount);
    const opening = money(decimal(counted).minus(ownNet));
    await tx.shift.update({where:{id:args.incomingShiftId},data:{openingCashAmount:opening.toNumber(),expectedCashAmount:counted}});
  } else {
    // Sales are still blocked by the custody gate: this changes the opening, never past collections.
    await tx.shift.update({where:{id:args.incomingShiftId},data:{openingCashAmount:counted,expectedCashAmount:counted}});
  }
  await auditInTransaction(tx,{cafeId:h.cafeId,userId:actorId,action:'HANDOVER_CASH_VERIFIED',
    entity:'HandoverSession',entityId:h.id,details:{proposed,counted,variance,caseId,incomingShiftId:args.incomingShiftId}});
  return {proposed,counted,variance,caseId};
}
