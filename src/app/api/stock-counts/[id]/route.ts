import { NextResponse, type NextRequest } from "next/server";
import {
  requireKey,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";
import { getCountSessionForViewer } from "@/lib/stock-count";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

// GET /api/stock-counts/:id — one count, redacted for whoever is reading it.
//
// The redaction is applied in the service rather than here, so every future
// reader of a session goes through the same door. See §5: the counter is not
// shown the target until the count is submitted.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.view");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const found = await getCountSessionForViewer({
      sessionId: id,
      cafeId,
      viewerId: session.id,
      viewerBranchId: session.branchId,
    });
    // How many lines have already moved the shelf, so the screen knows
    // whether "apply to stock" is still to do.
    const appliedLines = await db.stockCountRebase.count({ where: { sessionId: id } });
    return NextResponse.json({ session: { ...found, appliedLines } });
  } catch (error) {
    return handleApiError(error);
  }
}
