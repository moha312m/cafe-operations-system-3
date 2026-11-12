import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { db } from "@/lib/db";
import { repairBranchCustody } from "@/lib/branch-custody-repair";

type Params = { params: Promise<{ id: string }> };

// POST /api/branches/:id/custody-repair — «إصلاح عهدة الفرع».
//
// For a branch whose shift open is refused with «حالة العهدة غير مكتملة في
// الفرع» and that has no live handover to act on. Same authority as the
// freeze release (owner, or a manager holding handover.exception /
// handover.cancel), same reason + note. See src/lib/branch-custody-repair.ts
// for what is and is not changed.
const repairSchema = z
  .object({
    reasonCodeId: z
      .string({ error: "لازم تحدد سبب إصلاح عهدة الفرع" })
      .min(1, "لازم تحدد سبب إصلاح عهدة الفرع"),
    note: z
      .string({ error: "لازم تكتب اللي حصل بالتفصيل" })
      .max(2000),
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();

const MESSAGE = {
  CASH_WITHOUT_STOCK: "اتصلحت عهدة الفرع: المخزون بقى في عهدة الفرع من غير جرد، وأول شيفت لازم يعمل الجرد الافتتاحي قبل البيع",
  STOCK_WITHOUT_CASH: "اتصلحت عهدة الفرع: اتسجلت عهدة درج للشيفت اللي شغال على المخزون",
} as const;

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id: branchId } = await params;
    const body = repairSchema.parse(await request.json().catch(() => ({})));

    const branch = await db.branch.findUnique({ where: { id: branchId }, select: { id: true, cafeId: true } });
    if (!branch || (session.cafeId && branch.cafeId !== session.cafeId)) {
      throw new ApiError(404, "الفرع غير موجود");
    }
    if (session.branchId && session.branchId !== branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }
    const { keys } = await resolvePermissions(session);
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    if (!isOwner && !keys.has("handover.exception") && !keys.has("handover.cancel")) {
      throw new ApiError(403, "إصلاح عهدة الفرع مخصص للمالك أو مدير بصلاحية الاستثناء");
    }

    const result = await db.$transaction((tx) => repairBranchCustody(tx, {
      cafeId: branch.cafeId,
      branchId,
      actorId: session.id,
      reasonCodeId: body.reasonCodeId,
      note: body.note,
      idempotencyKey: body.idempotencyKey,
    }), { timeout: 60000 });

    return NextResponse.json({ ...result, message: MESSAGE[result.repaired] });
  } catch (error) {
    return handleApiError(error);
  }
}
