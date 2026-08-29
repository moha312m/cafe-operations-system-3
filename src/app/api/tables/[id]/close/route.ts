import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { resolvePermissions } from "@/lib/perms/effective";
import { recomputeSessionTotals, BLOCKING_ORDER_STATUSES } from "@/lib/table-sessions";

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
    await recomputeSessionTotals(id);

    const { keys } = await resolvePermissions(session);
    const mayOverride = keys.has("tables.manage");

    // Everything is re-checked here, at the moment of closing, rather than
    // trusting the eligibility the screen computed. Between the prompt
    // appearing and the button being pressed a waiter can ring in another
    // round, and a close decided before that must not release the table.
    const closed = await db.$transaction(async (tx) => {
      const current = await tx.tableSession.findUnique({ where: { id } });
      if (!current || current.status !== "OPEN") {
        throw new ApiError(400, "الترابيزة مقفولة بالفعل");
      }

      const remaining = Number(current.remainingAmount);
      if (remaining > 0.001 && !mayOverride) {
        throw new ApiError(400, "لا يمكن قفل الترابيزة قبل تحصيل باقي الحساب");
      }

      // A settled bill is not a finished table: an order that is confirmed,
      // being made, or sitting ready on the pass has not reached the customer,
      // and closing here would release the table and orphan it. Cancelled and
      // rejected orders are already out of the session's reckoning.
      const unserved = await tx.order.count({
        where: { tableSessionId: id, status: { in: [...BLOCKING_ORDER_STATUSES] } },
      });
      if (unserved > 0 && !mayOverride) {
        throw new ApiError(400, "لا يمكن قفل الترابيزة قبل تسليم كل الطلبات");
      }

      // Conditional on OPEN so two simultaneous closes cannot both win.
      const flipped = await tx.tableSession.updateMany({
        where: { id, status: "OPEN" },
        data: { status: "CLOSED", closedAt: new Date(), closedByUserId: session.id },
      });
      if (flipped.count === 0) throw new ApiError(400, "الترابيزة مقفولة بالفعل");

      return {
        session: await tx.tableSession.findUniqueOrThrow({ where: { id } }),
        remaining,
        unserved,
      };
    });
    const remaining = closed.remaining;

    await audit({
      cafeId: ts.cafeId, userId: session.id, action: "TABLE_SESSION_CLOSED",
      entity: "TableSession", entityId: id,
      details: {
        branchId: ts.branchId, tableSessionId: id, tableNumber: ts.tableNumber,
        oldValue: "OPEN", newValue: "CLOSED",
        totalAmount: Number(closed.session.totalAmount), paidAmount: Number(closed.session.paidAmount),
        remainingAmount: Number(closed.session.remainingAmount),
        unservedOrders: closed.unserved,
        managerOverride: remaining > 0.001 || closed.unserved > 0,
      },
    });

    return NextResponse.json({
      session: {
        id: closed.session.id,
        status: closed.session.status,
        closedAt: closed.session.closedAt,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
