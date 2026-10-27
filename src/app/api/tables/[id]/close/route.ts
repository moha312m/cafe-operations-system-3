import { protectedTransaction } from "@/lib/protected-transaction";
import { lockOrders, lockOrderPayments, lockTableSessions } from "@/lib/transaction-locks";
import { money } from "@/lib/money";
import { NextResponse, type NextRequest } from "next/server";
import { requireKey, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { resolvePermissions } from "@/lib/perms/effective";
import { recomputeSessionTotals, BLOCKING_ORDER_STATUSES } from "@/lib/table-sessions";

type Params = { params: Promise<{ id: string }> };

// POST /api/tables/[id]/close — close a fully-settled table. Managers with
// tables.manage may override and close with an outstanding balance.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("tables.close");
    const { id } = await params;

    const { keys } = await resolvePermissions(session);
    const mayOverride = keys.has("tables.manage");

    // Everything is re-checked here, at the moment of closing, rather than
    // trusting the eligibility the screen computed. Between the prompt
    // appearing and the button being pressed a waiter can ring in another
    // round, and a close decided before that must not release the table.
    const closed = await protectedTransaction(async (tx) => {
      const scope = resolveReadScope(session);
      const candidate = await tx.tableSession.findFirst({ where: { id, ...scope } });
      if (!candidate) throw new ApiError(404, "الحساب مش موجود");
      const members = await tx.order.findMany({ where: { tableSessionId: id, ...scope }, select: { id: true } });
      await lockOrders(tx, members.map(order => order.id));
      await lockOrderPayments(tx, members.map(order => order.id));
      await lockTableSessions(tx, [id]);
      const freshMembers = await tx.order.findMany({ where: { tableSessionId: id, ...scope }, select: { id: true } });
      if (freshMembers.some(order => !members.some(locked => locked.id === order.id))) throw new ApiError(409, "طلبات الترابيزة اتغيرت — جرّب تاني");
      await recomputeSessionTotals(id, tx);
      const current = await tx.tableSession.findFirst({ where: { id, ...scope } });
      if (!current || current.status !== "OPEN") {
        throw new ApiError(400, "الترابيزة مقفولة بالفعل");
      }

      const remaining = money(current.remainingAmount);
      if (remaining.gt(0) && !mayOverride) {
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

      await auditInTransaction(tx, { cafeId: current.cafeId, userId: session.id, action: "TABLE_SESSION_CLOSED", entity: "TableSession", entityId: id, details: { branchId: current.branchId, tableSessionId: id, tableNumber: current.tableNumber, oldValue: "OPEN", newValue: "CLOSED", totalAmount: current.totalAmount, paidAmount: current.paidAmount, remainingAmount: current.remainingAmount, unservedOrders: unserved, managerOverride: remaining.gt(0) || unserved > 0 } });
      return {
        session: await tx.tableSession.findUniqueOrThrow({ where: { id } }),
        remaining,
        unserved,
      };
    }, resolveReadScope(session));
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
