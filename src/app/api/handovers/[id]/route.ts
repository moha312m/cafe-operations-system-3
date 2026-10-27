import { NextResponse, type NextRequest } from "next/server";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { db } from "@/lib/db";
import { resolvePermissions } from "@/lib/perms/effective";
import { handoverOverview } from "@/lib/handover-overview";
import { incomingHandoverView } from "@/lib/handover";

type Params = { params: Promise<{ id: string }> };

// GET /api/handovers/:id — one handover, as the arriving custodian may see it.
//
// The blindness is applied in the service rather than here, so every future
// reader of a handover goes through the same door. Until the reviewer has
// taken their own look, the response carries no quantity key at all — not
// nulled, not zeroed, absent — because a reviewer who can read the outgoing
// figures first is transcribing rather than counting.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.view");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const handover = await incomingHandoverView(id, session.id, {
      cafeId,
      viewerBranchId: session.branchId,
      allowOutgoingDraft: true,
      allowCompletedRead: true,
    });
    const context = await db.handoverSession.findUniqueOrThrow({where:{id},select:{incomingShift:{select:{id:true,shiftNumber:true,cashierId:true,cashier:{select:{name:true}}}},branch:{select:{name:true}},stockAcknowledgements:{select:{stockCountLineId:true,decision:true}},outgoingUser:{select:{name:true}},incomingUser:{select:{name:true}},cashVarianceAmount:true,cashVerifiedAt:true,
      outgoingShift:{select:{id:true,shiftNumber:true,cashDifference:true,cashReasonNote:true,tenderReconciliations:{select:{method:true,varianceAmount:true,reasonNote:true}}}}}});
    const incoming = handover.status === "COMPLETED" ? [] : await db.shift.findMany({ where: { cafeId, branchId: handover.branchId, status: "OPEN", custodyGateReason: "AWAITING_CUSTODY_TRANSFER" }, select: { id: true, shiftNumber: true, cashierId: true, cashier: { select: { name: true } } }, take: 2 });
    const { keys } = await resolvePermissions(session);
    const overview = await handoverOverview(id, cafeId, handover.branchId, keys);
    return NextResponse.json({ handover:{...handover,overview,workflow:{branchName:context.branch.name,acknowledgements:context.stockAcknowledgements,incomingShift:context.incomingShift ?? (incoming.length === 1 ? incoming[0] : null),incomingAmbiguous:context.incomingShift === null && incoming.length > 1},financialSummary:{outgoingName:context.outgoingUser.name,incomingName:context.incomingUser?.name??null,
      shiftId:context.outgoingShift.id,shiftNumber:context.outgoingShift.shiftNumber,cashVariance:keys.has("shifts.view_reports") ? context.outgoingShift.cashDifference : null,cashReason:keys.has("shifts.view_reports") ? context.outgoingShift.cashReasonNote : null,
      tenders:keys.has("shifts.view_reports") ? context.outgoingShift.tenderReconciliations : [],cashReceiptVariance:keys.has("shifts.view_reports") ? context.cashVarianceAmount : null,cashVerifiedAt:context.cashVerifiedAt}} });
  } catch (error) {
    return handleApiError(error);
  }
}
