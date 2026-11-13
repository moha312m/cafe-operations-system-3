import { NextResponse, type NextRequest } from "next/server";
import { ApiError, handleApiError, requireFeature, requireKey, resolveCafeId } from "@/lib/api";
import { db } from "@/lib/db";
import { rebaseFromCount } from "@/lib/stock-rebase";

type Params = { params: Promise<{ id: string }> };

// POST /api/stock-counts/:id/apply-to-stock — move the shelf to what an
// ordinary confirmed count found (COUNT_REBASE, T23).
//
// Confirming agrees the figures; this acts on them, as its own step, so the
// numbers can be looked at before the stock moves. Each movement carries the
// line's cost, which is what puts the shortage or surplus into the books
// (هالك وفروقات مخزون) and from there into the P&L. Lines still in dispute
// are skipped, and a second call moves nothing: one count rebases one item
// once.
//
// A handover or opening count is refused here: its acceptance applies it,
// inside the transaction that decides who answers for the difference.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("stock_count.confirm");
    await requireFeature(session, "inventoryEnabled");
    const { id } = await params;
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const count = await db.stockCountSession.findUnique({
      where: { id },
      select: { cafeId: true, branchId: true, status: true, accountabilityContext: true, handoverId: true, openingBranchCustodyPeriodId: true },
    });
    if (!count || count.cafeId !== cafeId) throw new ApiError(404, "جلسة الجرد غير موجودة");
    if (session.branchId && count.branchId !== session.branchId) throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    if (count.accountabilityContext !== "NONE" || count.handoverId || count.openingBranchCustodyPeriodId) {
      throw new ApiError(409, "جرد التسليم أو فتح الفرع بيتطبق على المخزون لما التسليم يتقبل — مش من هنا");
    }
    if (count.status !== "CONFIRMED") throw new ApiError(409, "أكّد الجرد الأول، وبعدين طبّق الفروقات على المخزون");

    const result = await rebaseFromCount({ sessionId: id, actorId: session.id, idempotencyKey: `apply-to-stock:${id}` });
    return NextResponse.json({
      itemsApplied: result.itemsRebased,
      itemsSkipped: result.itemsSkipped,
      alreadyApplied: result.alreadyRebased && result.itemsRebased === 0,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
