import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession, ApiError, handleApiError } from "@/lib/api";
import { db } from "@/lib/db";
import {
  checkOwnerOverrideCode,
  overrideCodeFrom,
  OWNER_OVERRIDE_REFUSED,
  OWNER_OVERRIDE_LOCKED,
} from "@/lib/owner-override";
import { executeSalesReset, validateConfirmationPhrase } from "@/lib/sales-reset";

export async function POST(request: NextRequest) {
  try {
    const session = await requireActiveSession();
    if (session.role !== "CAFE_OWNER" || !session.cafeId) {
      throw new ApiError(403, "صلاحية مالك الكافيه مطلوبة لتنفيذ تصفير المبيعات");
    }

    const body = await request.json().catch(() => ({}));
    const branchId = typeof body.branchId === "string" ? body.branchId : undefined;
    const from = typeof body.from === "string" ? body.from : undefined;
    const to = typeof body.to === "string" ? body.to : undefined;
    const resetAll = Boolean(body.resetAll);
    const includeShiftsAndHandovers = Boolean(body.includeShiftsAndHandovers);
    const confirmPhrase = typeof body.confirmPhrase === "string" ? body.confirmPhrase : "";
    const reason = typeof body.reason === "string" ? body.reason : undefined;

    // Verify date constraints in period mode
    if (!resetAll && !from && !to && !includeShiftsAndHandovers) {
      throw new ApiError(
        400,
        "يجب تحديد تاريخ بداية أو نهاية في وضع الفترة الزمنية، أو اختيار التصفير الشامل"
      );
    }

    // Verify confirmation phrase
    if (!validateConfirmationPhrase(confirmPhrase)) {
      throw new ApiError(
        400,
        "يجب إدخال عبارة التأكيد بشكل صحيح ('تصفير المبيعات' أو 'RESET')"
      );
    }

    // Verify owner override passcode
    const code =
      overrideCodeFrom(request) ||
      (typeof body.code === "string" ? body.code : undefined) ||
      (typeof body.ownerOverrideCode === "string" ? body.ownerOverrideCode : undefined);

    if (!code) {
      throw new ApiError(400, "رمز موافقة المالك مطلوب لتنفيذ تصفير المبيعات");
    }

    const effectiveBranchId =
      branchId && branchId !== "ALL" ? branchId : (session.branchId ?? "");

    const check = await checkOwnerOverrideCode(session, {
      branchId: effectiveBranchId,
      code,
    });

    if (check.status === "INVALID" || check.status === "NONE") {
      throw new ApiError(403, OWNER_OVERRIDE_REFUSED);
    }
    if (check.status === "LOCKED") {
      throw new ApiError(429, OWNER_OVERRIDE_LOCKED);
    }

    // Record successful passcode attempt
    await db.ownerPasscodeAttempt.create({
      data: {
        cafeId: check.grant.cafeId,
        ownerId: check.grant.ownerId,
        passcodeId: check.grant.passcodeId,
        requesterId: session.id,
        success: true,
      },
    });

    // Execute atomic reset
    const result = await executeSalesReset({
      cafeId: session.cafeId,
      branchId,
      from,
      to,
      resetAll,
      includeShiftsAndHandovers,
      actorId: session.id,
      reason,
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    return handleApiError(error);
  }
}
