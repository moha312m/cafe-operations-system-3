import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { db } from "@/lib/db";
import { forceReleaseBranchFreezes } from "@/lib/inventory-freeze";
import { cancelHandoverIntoBranchCustody } from "@/lib/handover-cancel";

type Params = { params: Promise<{ id: string }> };

// POST /api/branches/:id/inventory-freeze/release — the owner's "unblock the
// branch" act, as two honest halves:
//
//   1. freezes whose handover already finished (COMPLETED / ACCEPTED) are
//      dangling and are simply released;
//   2. every DRAFT / REJECTED handover of the branch is ENDED into branch
//      custody through the same audited service the cancel route uses, with
//      the reason and note given here — never marked complete with nothing
//      behind it.
//
// A handover that cannot be ended (its shelf is shared with a working shift,
// its stock custody is not open) refuses the whole call and names itself; the
// owner then resolves that one from the handover screen. Submitted handovers
// awaiting a receiver are never touched here.
const releaseSchema = z
  .object({
    reasonCodeId: z
      .string({ error: "لازم تحدد سبب إنهاء التسليمات المعلقة" })
      .min(1, "لازم تحدد سبب إنهاء التسليمات المعلقة"),
    note: z
      .string({ error: "لازم تكتب سبب الإنهاء بالتفصيل" })
      .max(2000),
  })
  .strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id: branchId } = await params;
    const body = releaseSchema.parse(await request.json().catch(() => ({})));

    const branch = await db.branch.findUnique({
      where: { id: branchId },
      select: { id: true, cafeId: true },
    });
    if (!branch || (session.cafeId && branch.cafeId !== session.cafeId)) {
      throw new ApiError(404, "الفرع غير موجود");
    }
    if (session.branchId && session.branchId !== branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }

    const { keys } = await resolvePermissions(session);
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    if (!isOwner && !keys.has("handover.exception") && !keys.has("handover.cancel")) {
      throw new ApiError(403, "فك تجميد المخزون وإنهاء التسليمات المعلقة مخصص للمالك أو مدير بصلاحية الاستثناء");
    }

    const outcome = await db.$transaction(async (tx) => {
      const releasedCount = await forceReleaseBranchFreezes(tx, branchId, session.id);
      const open = await tx.handoverSession.findMany({
        where: { branchId, cafeId: branch.cafeId, status: { in: ["DRAFT", "REJECTED"] } },
        select: { id: true, outgoingUserId: true },
        orderBy: { createdAt: "asc" },
      });
      const cancelled: string[] = [];
      for (const handover of open) {
        if (handover.outgoingUserId === session.id) {
          throw new ApiError(403, "واحد من التسليمات المعلقة تسليمك انت — مينفعش تنهيه بنفسك، خلي مدير تاني أو المالك ينهيه");
        }
        const result = await cancelHandoverIntoBranchCustody(tx, {
          handoverId: handover.id,
          actorId: session.id,
          cafeId: branch.cafeId,
          viewerBranchId: session.branchId,
          reasonCodeId: body.reasonCodeId,
          note: body.note,
        });
        if (!result.alreadyCompleted) cancelled.push(handover.id);
      }
      return { releasedCount, cancelled };
    }, { timeout: 60000 });

    return NextResponse.json({
      success: true,
      releasedCount: outcome.releasedCount,
      cancelledHandoverIds: outcome.cancelled,
      message: `اتفك ${outcome.releasedCount} تجميد معلّق وأُنهي ${outcome.cancelled.length} تسليم لعهدة الفرع بسبب مسجل`,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
