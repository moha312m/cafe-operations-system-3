import { NextResponse, type NextRequest } from "next/server";
import { ApiError, handleApiError, requireKey, requirePermission, resolveBranchId, resolveCafeId } from "@/lib/api";
import { db } from "@/lib/db";
import { listDeliveryCouriers } from "@/lib/delivery-couriers";

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("orders:create");
    await requireKey("pos.create_order");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = resolveBranchId(session, params.get("branchId"));
    const branch = await db.branch.findFirst({
      where: { id: branchId, cafeId, isActive: true },
      select: { id: true },
    });
    if (!branch) throw new ApiError(404, "الفرع مش موجود");
    return NextResponse.json({ couriers: await listDeliveryCouriers(db, cafeId, branchId) });
  } catch (error) {
    return handleApiError(error);
  }
}
