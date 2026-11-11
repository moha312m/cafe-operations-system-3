import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveSession, handleApiError, ApiError, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { db } from "@/lib/db";
import { cancelHandoverIntoBranchCustody, CANCEL_BY_CUSTODIAN } from "@/lib/handover-cancel";

type Params = { params: Promise<{ id: string }> };

// POST /api/handovers/:id/cancel — a manager ends an unfinished handover into
// branch custody, with a reason, on the record.
//
// `.strict()`: a body carrying `status`, `resolvedTarget` or any custody id is
// refused by name. The reason code and the note are REQUIRED: this ends a
// custodian's accountability without a count, and a record of why is the
// whole of what makes it defensible.
//
// Who may call it: the owner, or a holder of `handover.exception` /
// `handover.cancel`. Never the outgoing custodian, even when they hold one of
// those keys — the service refuses that too.
const cancelSchema = z
  .object({
    reasonCodeId: z
      .string({ error: "لازم تحدد سبب إنهاء التسليم" })
      .min(1, "لازم تحدد سبب إنهاء التسليم"),
    note: z
      .string({ error: "لازم تكتب سبب إنهاء التسليم بالتفصيل" })
      .max(2000),
    cafeId: z.string().optional(),
  })
  .strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const body = cancelSchema.parse(await request.json().catch(() => ({})));
    const cafeId = resolveCafeId(session, body.cafeId);

    const handover = await db.handoverSession.findFirst({
      where: { id, cafeId },
      select: { id: true, branchId: true, outgoingUserId: true },
    });
    if (!handover) throw new ApiError(404, "جلسة التسليم غير موجودة");
    if (session.branchId && handover.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }

    const { keys } = await resolvePermissions(session);
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    const mayEnd = isOwner || keys.has("handover.exception") || keys.has("handover.cancel");
    if (!mayEnd) {
      throw new ApiError(403, "إنهاء جلسات التسليم مخصص للمالك أو مدير بصلاحية الاستثناء");
    }
    if (handover.outgoingUserId === session.id) throw new ApiError(403, CANCEL_BY_CUSTODIAN);

    const result = await db.$transaction(
      (tx) => cancelHandoverIntoBranchCustody(tx, {
        handoverId: id,
        actorId: session.id,
        cafeId,
        viewerBranchId: session.branchId,
        reasonCodeId: body.reasonCodeId,
        note: body.note,
      }),
      { timeout: 30000 },
    );

    return NextResponse.json({
      success: true,
      ...result,
      message: result.alreadyCompleted
        ? "التسليم ده كان منتهي قبل كده — مفيش حاجة اتغيرت"
        : result.redecidedShiftIds.length > 0
          ? `أُنهي التسليم لعهدة الفرع — ${result.redecidedShiftIds.length} شيفت مستني انتقل للتحقق من العهدة الافتتاحية`
          : "أُنهي التسليم لعهدة الفرع وأُقفل شيفت المُسلّم — شيفت الصبح بيجرد ويتحقق قبل البيع",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
