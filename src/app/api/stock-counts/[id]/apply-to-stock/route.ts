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
// This action is for ordinary counts. Handover discrepancies go to review,
// and legacy opening verification has its own workflow.
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
    if (count.accountabilityContext === "HANDOVER" || count.handoverId) {
      throw new ApiError(409, "راجع الفرق في تقرير جرد التسليم والاستلام من مراجعة فروق جرد التسليم. استلام العهدة بيسجّل الفرق، وأي تسوية للمخزون بتحتاج إجراء معتمد منفصل.");
    }
    if (count.accountabilityContext !== "NONE" || count.openingBranchCustodyPeriodId) {
      throw new ApiError(409, "جرد فتح الفرع له إجراء التحقق من العهدة الافتتاحية.");
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
