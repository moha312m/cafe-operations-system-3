import { NextResponse, type NextRequest } from "next/server";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
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
    });
    return NextResponse.json({ handover });
  } catch (error) {
    return handleApiError(error);
  }
}
