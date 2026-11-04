// ── One handover, as the viewer may see it ─────────────────────────────
// Shared by the detail route and the report export so both show exactly the same facts:
// blind-count disclosure, financial access and every permission check live here once.
import { db } from "@/lib/db";
import { resolvePermissions } from "@/lib/perms/effective";
import { handoverOverview } from "@/lib/handover-overview";
import { incomingHandoverView } from "@/lib/handover";
import { branchReadiness } from "@/lib/handover-readiness";
import { handoverActivity } from "@/lib/handover-activity";
import { DEFAULT_TZ } from "@/lib/date-range";
import type { SessionUser } from "@/lib/auth";

export async function handoverDetailPayload(session: SessionUser, id: string, cafeId: string) {
  const handover = await incomingHandoverView(id, session.id, {
    cafeId,
    viewerBranchId: session.branchId,
    allowOutgoingDraft: true,
    allowCompletedRead: true,
  });
  const context = await db.handoverSession.findUniqueOrThrow({where:{id},select:{incomingShift:{select:{id:true,shiftNumber:true,cashierId:true,cashier:{select:{name:true}}}},branch:{select:{name:true}},outgoingUser:{select:{name:true}},incomingUser:{select:{name:true}},cashVarianceAmount:true,cashVerifiedAt:true,
    outgoingShift:{select:{id:true,shiftNumber:true,cashDifference:true,cashReasonNote:true,tenderReconciliations:{select:{method:true,varianceAmount:true,reasonNote:true}}}}}});
  // Only the round the handover now points at. A superseded round keeps its signatures as history,
  // but a dispute that was already sent back for recount must not colour or block the replacement.
  // The figures are the receiver's own count and what was handed over; they exist only once that
  // line was acknowledged, which is also when the outgoing figures are disclosed.
  const acknowledgements = handover.count === null ? [] : await db.handoverStockAcknowledgement.findMany({
    where: { handoverId: id, line: { sessionId: handover.count.sessionId } },
    select: { stockCountLineId: true, decision: true, incomingCountedQuantity: true, handedOverQuantity: true, varianceQuantity: true },
  });
  const incoming = handover.status === "COMPLETED" ? [] : await db.shift.findMany({ where: { cafeId, branchId: handover.branchId, status: "OPEN", custodyGateReason: "AWAITING_CUSTODY_TRANSFER" }, select: { id: true, shiftNumber: true, cashierId: true, cashier: { select: { name: true } } }, take: 2 });
  const { keys } = await resolvePermissions(session);
  const overview = await handoverOverview(id, cafeId, handover.branchId, keys);
  const [cafe, reporting] = await Promise.all([
    db.cafe.findUniqueOrThrow({ where: { id: cafeId }, select: { currency: true } }),
    db.branchReportingVersion.findFirst({ where: { branchId: handover.branchId }, orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }], select: { timezone: true } }),
  ]);
  const readiness = await branchReadiness(cafeId, handover.branchId);
  const countSessionIds = handover.count ? [handover.count.sessionId] : [];
  const activity = await handoverActivity({ cafeId, handoverId: id, outgoingShiftId: context.outgoingShift.id, countSessionIds, incomingShiftId: context.incomingShift?.id ?? null });
  return {...handover,overview,activity,workflow:{readiness,timezone:reporting?.timezone ?? DEFAULT_TZ,currency:cafe.currency,branchName:context.branch.name,acknowledgements,incomingShift:context.incomingShift ?? (incoming.length === 1 ? incoming[0] : null),incomingAmbiguous:context.incomingShift === null && incoming.length > 1},financialSummary:{outgoingName:context.outgoingUser.name,incomingName:context.incomingUser?.name??null,
    shiftId:context.outgoingShift.id,shiftNumber:context.outgoingShift.shiftNumber,cashVariance:keys.has("shifts.view_reports") ? context.outgoingShift.cashDifference : null,cashReason:keys.has("shifts.view_reports") ? context.outgoingShift.cashReasonNote : null,
    tenders:keys.has("shifts.view_reports") ? context.outgoingShift.tenderReconciliations : [],cashReceiptVariance:keys.has("shifts.view_reports") ? context.cashVarianceAmount : null,cashVerifiedAt:context.cashVerifiedAt}};
}
