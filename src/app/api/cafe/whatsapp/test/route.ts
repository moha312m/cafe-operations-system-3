import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { sendShiftReport } from "@/lib/whatsapp";

// POST /api/cafe/whatsapp/test — proves the connection end to end by sending
// the report of the café's most recently closed shift. Owner only.
export async function POST() {
  try {
    const session = await requireKey("settings.edit");
    if (!session.cafeId) throw new ApiError(400, "المستخدم غير مرتبط بكافيه");
    const shift = await db.shift.findFirst({
      where: { cafeId: session.cafeId, status: { in: ["CLOSED", "AWAITING_HANDOVER"] } },
      orderBy: [{ financiallyClosedAt: { sort: "desc", nulls: "last" } }, { closedAt: "desc" }],
      select: { id: true, shiftNumber: true },
    });
    if (!shift) throw new ApiError(409, "مفيش شيفت مقفول لسه نبعت تقريره كتجربة");

    const outcome = await sendShiftReport({ shiftId: shift.id, cafeId: session.cafeId, trigger: "TEST", actorId: session.id });
    if (outcome.status === "SKIPPED") throw new ApiError(409, "فعّل واتساب واحفظ البيانات الأول");
    if (outcome.status === "FAILED") throw new ApiError(502, `فشل الإرسال: ${outcome.error}`);
    return NextResponse.json({ status: "SENT", shiftNumber: shift.shiftNumber });
  } catch (error) {
    return handleApiError(error);
  }
}
