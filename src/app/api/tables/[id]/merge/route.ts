import { protectedTransaction } from "@/lib/protected-transaction";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireKey, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { recomputeSessionTotals } from "@/lib/table-sessions";


import { lockOrders, lockOrderPayments, lockTableSessions } from "@/lib/transaction-locks";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ targetTableNumber: z.string().trim().min(1, "رقم الترابيزة مطلوب") });

// POST /api/tables/[id]/merge — merge this session INTO the open session
// of another table: orders + payments move over, this session is cancelled.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("tables.merge");
    const { id } = await params;
    const { targetTableNumber } = bodySchema.parse(await request.json());

    return await protectedTransaction(async (tx) => {
      const source = await tx.tableSession.findFirst({ where: { id, ...resolveReadScope(session) } });
      if (!source) throw new ApiError(404, "الجلسة غير موجودة");
      if (session.role !== "SUPER_ADMIN" && source.cafeId !== session.cafeId) {
        throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
      }
      if (session.branchId && source.branchId !== session.branchId) {
        throw new ApiError(403, "الترابيزة تبع فرع تاني");
      }
      if (source.status !== "OPEN") throw new ApiError(400, "الجلسة مقفولة");

      const target = await tx.tableSession.findFirst({
        where: {
          cafeId: source.cafeId, branchId: source.branchId,
          tableNumber: targetTableNumber, status: "OPEN", id: { not: id },
        },
      });
      if (!target) throw new ApiError(400, `مفيش جلسة مفتوحة على الترابيزة ${targetTableNumber}`);

      const tableIds = [id, target.id].sort();
      const members = await tx.order.findMany({ where: { tableSessionId: { in: tableIds } }, select: { id: true } });
      const paymentMembers = await tx.payment.findMany({ where: { tableSessionId: { in: tableIds } }, select: { orderId: true } });
      const orderIds = [...new Set([...members.map((order) => order.id), ...paymentMembers.map((payment) => payment.orderId)])];
      await lockOrders(tx, orderIds);
      await lockOrderPayments(tx, orderIds);
      await lockTableSessions(tx, tableIds);
      const freshTables = await tx.tableSession.findMany({ where: { id: { in: tableIds } } });
      if (freshTables.some((table) => table.status !== "OPEN") || freshTables.length !== 2) throw new ApiError(409, "حالة الترابيزة اتغيرت — جرّب الدمج تاني");
      if (freshTables.find((table) => table.id === target.id)?.tableNumber !== targetTableNumber) throw new ApiError(409, "الترابيزة المطلوبة اتنقلت — جرّب الدمج تاني");
      const freshMembers = await tx.order.findMany({ where: { tableSessionId: { in: tableIds } }, select: { id: true } });
      const freshPayments = await tx.payment.findMany({ where: { tableSessionId: { in: tableIds } }, select: { orderId: true } });
      const locked = new Set(orderIds);
      if (freshMembers.some((order) => !locked.has(order.id)) || freshPayments.some((payment) => !locked.has(payment.orderId))) throw new ApiError(409, "طلبات الترابيزة اتغيرت — جرّب الدمج تاني");
      await tx.order.updateMany({
        where: { tableSessionId: id },
        data: { tableSessionId: target.id, tableNumber: target.tableNumber },
      });
      await tx.payment.updateMany({ where: { tableSessionId: id }, data: { tableSessionId: target.id } });
      await tx.orderItemPayment.updateMany({ where: { tableSessionId: id }, data: { tableSessionId: target.id } });
      await tx.tableSession.update({
        where: { id },
        data: { status: "CANCELLED", closedAt: new Date(), closedByUserId: session.id },
      });

      await recomputeSessionTotals(target.id, tx);
      await recomputeSessionTotals(id, tx);

      await auditInTransaction(tx, {
        cafeId: source.cafeId, userId: session.id, action: "TABLE_MERGED",
        entity: "TableSession", entityId: target.id,
        details: {
          branchId: source.branchId,
          oldValue: { sourceSessionId: id, sourceTable: source.tableNumber },
          newValue: { targetSessionId: target.id, targetTable: target.tableNumber },
        },
      });

      return NextResponse.json({ ok: true, targetSessionId: target.id });
    }, resolveReadScope(session));
  } catch (error) {
    return handleApiError(error);
  }
}
