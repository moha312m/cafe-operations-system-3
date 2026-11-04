import { NextResponse, type NextRequest } from "next/server";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { handoverDetailPayload } from "@/lib/handover-detail-payload";

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

    return NextResponse.json({ handover: await handoverDetailPayload(session, id, cafeId) });
  } catch (error) {
    return handleApiError(error);
  }
}
