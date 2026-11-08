import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveSession, handleApiError, ApiError, resolveCafeId } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { approveHandoverAsManager } from "@/lib/handover-approval";

type Params = { params: Promise<{ id: string }> };

const approveSchema = z
  .object({
    note: z.string().max(1000).optional(),
    cafeId: z.string().optional(),
  })
  .strip();

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { keys } = await resolvePermissions(session);
    const isOwnerOrManager =
      session.role === "CAFE_OWNER" || session.role === "BRANCH_MANAGER" || session.role === "SUPER_ADMIN";
    const hasHandoverPerm =
      keys.has("handover.accept") ||
      keys.has("handover.exception") ||
      keys.has("handover.manage") ||
      keys.has("shifts:operate");

    if (!isOwnerOrManager && !hasHandoverPerm) {
      throw new ApiError(403, "ليس لديك صلاحية اعتماد الجرد وإغلاق التسليم");
    }

    const { id } = await params;
    const body = approveSchema.parse(await request.json().catch(() => ({})));
    const cafeId = resolveCafeId(session, body.cafeId);

    const result = await approveHandoverAsManager({
      handoverId: id,
      managerId: session.id,
      cafeId,
      viewerBranchId: session.branchId,
      note: body.note,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
