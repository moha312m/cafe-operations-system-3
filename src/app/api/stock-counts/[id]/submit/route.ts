import { NextResponse, type NextRequest } from "next/server";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { submitCountSession } from "@/lib/stock-count";

type Params = { params: Promise<{ id: string }> };

// POST /api/stock-counts/:id/submit — close the counting phase.
//
// Every counted line gets a verdict against the tolerance governing its item,
// and the theoretical figure it was measured against gets a confidence rating
// and a price (or a stated reason it could not be priced). Submission refuses
// while any shelf is still unlooked-at: a NULL count is not a zero one.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.submit");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const result = await submitCountSession({
      sessionId: id,
      submittedById: session.id,
      cafeId,
      viewerBranchId: session.branchId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
