import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession, ApiError, handleApiError } from "@/lib/api";
import { previewSalesReset } from "@/lib/sales-reset";

export async function POST(request: NextRequest) {
  try {
    const session = await requireActiveSession();
    if (session.role !== "CAFE_OWNER" || !session.cafeId) {
      throw new ApiError(403, "صلاحية مالك الكافيه مطلوبة لمعاينة تصفير المبيعات");
    }

    const body = await request.json().catch(() => ({}));
    const branchId = typeof body.branchId === "string" ? body.branchId : undefined;
    const from = typeof body.from === "string" ? body.from : undefined;
    const to = typeof body.to === "string" ? body.to : undefined;
    const resetAll = Boolean(body.resetAll);
    const includeShiftsAndHandovers = Boolean(body.includeShiftsAndHandovers);

    if (!resetAll && !from && !to && !includeShiftsAndHandovers) {
      throw new ApiError(
        400,
        "يجب تحديد تاريخ بداية أو نهاية في وضع الفترة الزمنية، أو اختيار التصفير الشامل"
      );
    }

    const preview = await previewSalesReset({
      cafeId: session.cafeId,
      branchId,
      from,
      to,
      resetAll,
      includeShiftsAndHandovers,
    });

    return NextResponse.json({ success: true, preview });
  } catch (error) {
    return handleApiError(error);
  }
}
