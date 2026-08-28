import { NextResponse, type NextRequest } from "next/server";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { approveCountCorrection } from "@/lib/stock-count";

type Params = { params: Promise<{ id: string }> };

// POST /api/corrections/:id/approve — the second signature.
//
// The key is `stock_count.approve_correction`, and holding it is not the same
// as being a second person: the service refuses the author their own
// approval regardless of what they hold.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.approve_correction");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const result = await approveCountCorrection({
      correctionId: id,
      approvedById: session.id,
      cafeId,
      viewerBranchId: session.branchId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
