import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, ApiError, requireKey } from "@/lib/api";
import { sendShiftReport } from "@/lib/whatsapp";

type Params = { params: Promise<{ id: string }> };

// POST /api/shifts/[id]/report/whatsapp — send (or resend) one shift's report
// to the café's WhatsApp recipient. Oversight only: the recipient is the
// owner, and the person being reported on does not choose when.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("shifts.view_reports");
    const { id } = await params;
    const shift = await db.shift.findUnique({ where: { id }, select: { cafeId: true, branchId: true } });
    if (!shift) throw new ApiError(404, "الشيفت مش موجود");
    if (shift.cafeId !== session.cafeId) throw new ApiError(403, "Not allowed");
    if (session.branchId && shift.branchId !== session.branchId) throw new ApiError(403, "Not allowed");

    const outcome = await sendShiftReport({ shiftId: id, cafeId: shift.cafeId, trigger: "MANUAL", actorId: session.id });
    if (outcome.status === "SKIPPED") {
      throw new ApiError(409, outcome.reason === "DISABLED" ? "واتساب مش متفعّل من الإعدادات" : "التقرير بيجهز بعد قفل الشيفت");
    }
    if (outcome.status === "FAILED") throw new ApiError(502, `فشل الإرسال: ${outcome.error}`);
    return NextResponse.json({ status: "SENT" });
  } catch (error) {
    return handleApiError(error);
  }
}
