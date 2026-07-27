import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { resolvePermissions } from "@/lib/perms/effective";
import { recomputeSessionTotals } from "@/lib/table-sessions";

type Params = { params: Promise<{ id: string }> };

// POST /api/tables/[id]/close — close a fully-settled table. Managers with
// tables.manage may override and close with an outstanding balance.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("tables.close");
    const { id } = await params;

    const ts = await db.tableSession.findUnique({ where: { id } });
    if (!ts) throw new ApiError(404, "الجلسة غير موجودة");
    if (session.role !== "SUPER_ADMIN" && ts.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && ts.branchId !== session.branchId) {
      throw new ApiError(403, "الترابيزة تبع فرع تاني");
    }
    if (ts.status !== "OPEN") throw new ApiError(400, "الترابيزة مقفولة بالفعل");

    // Refresh totals first so a stale remaining can't block/allow wrongly.
    const fresh = await recomputeSessionTotals(id);
    const remaining = Number(fresh.remainingAmount);

    if (remaining > 0.001) {
      const { keys } = await resolvePermissions(session);
      if (!keys.has("tables.manage")) {
        throw new ApiError(400, "لا يمكن قفل الترابيزة قبل تحصيل باقي الحساب");
      }
    }

    const closed = await db.tableSession.update({
      where: { id },
      data: { status: "CLOSED", closedAt: new Date(), closedByUserId: session.id },
    });

    await audit({
      cafeId: ts.cafeId, userId: session.id, action: "TABLE_SESSION_CLOSED",
      entity: "TableSession", entityId: id,
      details: {
        branchId: ts.branchId, tableSessionId: id, tableNumber: ts.tableNumber,
        oldValue: "OPEN", newValue: "CLOSED",
        totalAmount: Number(closed.totalAmount), paidAmount: Number(closed.paidAmount),
        remainingAmount: Number(closed.remainingAmount),
        managerOverride: remaining > 0.001,
      },
    });

    return NextResponse.json({ session: { id: closed.id, status: closed.status, closedAt: closed.closedAt } });
  } catch (error) {
    return handleApiError(error);
  }
}
