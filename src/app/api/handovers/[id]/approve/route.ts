import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveSession, handleApiError, ApiError, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { approveHandoverAsManager } from "@/lib/handover-approval";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

// POST /api/handovers/:id/approve — a manager finishes a handover through the
// audited acceptance doors (see `handover-approval.ts`).
//
// `.strict()`, and the reason code and note are REQUIRED: this is a manager
// exception however it is pressed, and an exception without a stated reason
// is the one record the handover model must never carry. `idempotencyKey`
// defaults to one derived from the handover, so a retry replays rather than
// claiming a second acceptance.
const approveSchema = z
  .object({
    reasonCodeId: z
      .string({ error: "لازم تحدد سبب الاعتماد" })
      .min(1, "لازم تحدد سبب الاعتماد"),
    note: z
      .string({ error: "لازم تكتب سبب الاعتماد بالتفصيل" })
      .max(2000),
    kind: z.enum(["MANAGER_ADJUSTMENT", "NO_INCOMING"]).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    cafeId: z.string().optional(),
  })
  .strict();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;
    const body = approveSchema.parse(await request.json().catch(() => ({})));
    const cafeId = resolveCafeId(session, body.cafeId);

    const handover = await db.handoverSession.findFirst({
      where: { id, cafeId },
      select: { branchId: true, stockCountSessionId: true },
    });
    if (!handover) throw new ApiError(404, "جلسة التسليم غير موجودة");
    if (session.branchId && handover.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }

    const { keys } = await resolvePermissions(session);
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    const isBranchManager = session.role === "BRANCH_MANAGER" && session.branchId === handover.branchId;
    if (!isOwner && !isBranchManager && !keys.has("handover.exception")) {
      throw new ApiError(403, "اعتماد التسليم مخصص للمالك أو مدير هذا الفرع");
    }
    if (!handover.stockCountSessionId) {
      throw new ApiError(409, "لا يمكن اعتماد تسليم لم يبدأ جرده — المُسلّم يبدأ الجرد الأول");
    }

    const result = await approveHandoverAsManager({
      handoverId: id,
      managerId: session.id,
      cafeId,
      viewerBranchId: session.branchId,
      reasonCodeId: body.reasonCodeId,
      note: body.note,
      kind: body.kind,
      idempotencyKey: body.idempotencyKey ?? `manager-approve:${id}`,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
