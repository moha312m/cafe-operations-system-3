import { protectedTransaction } from "@/lib/protected-transaction";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireKey, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";

import { lockOrders, lockTableSessions } from "@/lib/transaction-locks";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ tableNumber: z.string().trim().min(1, "رقم الترابيزة مطلوب") });

// POST /api/tables/[id]/transfer — move an open session to another table
// (target must not already have an open session).
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("tables.transfer");
    const { id } = await params;
    const { tableNumber } = bodySchema.parse(await request.json());

    return await protectedTransaction(async (tx) => {
      const candidate = await tx.tableSession.findFirst({ where: { id, ...resolveReadScope(session) }, select: { id: true } });
      if (!candidate) throw new ApiError(404, "الحساب مش موجود");
      const members = await tx.order.findMany({ where: { tableSessionId: id, ...resolveReadScope(session) }, select: { id: true } });
      await lockOrders(tx, members.map((order) => order.id));
      await lockTableSessions(tx, [id]);
      const freshMembers = await tx.order.findMany({ where: { tableSessionId: id }, select: { id: true } });
      const locked = new Set(members.map((order) => order.id));
      if (freshMembers.some((order) => !locked.has(order.id))) throw new ApiError(409, "طلبات الترابيزة اتغيرت — جرّب النقل تاني");
      const ts = await tx.tableSession.findFirst({ where: { id, ...resolveReadScope(session) } });
      if (!ts) throw new ApiError(404, "الجلسة غير موجودة");
      if (session.role !== "SUPER_ADMIN" && ts.cafeId !== session.cafeId) {
        throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
      }
      if (session.branchId && ts.branchId !== session.branchId) {
        throw new ApiError(403, "الترابيزة تبع فرع تاني");
      }
      if (ts.status !== "OPEN") throw new ApiError(400, "الجلسة مقفولة");
      if (tableNumber === ts.tableNumber) throw new ApiError(400, "نفس الترابيزة الحالية");

      const clash = await tx.tableSession.findFirst({
        where: { cafeId: ts.cafeId, branchId: ts.branchId, tableNumber, status: "OPEN" },
      });
      if (clash) throw new ApiError(400, `الترابيزة ${tableNumber} عليها جلسة مفتوحة بالفعل`);

      await tx.order.updateMany({ where: { tableSessionId: id }, data: { tableNumber } });
      await tx.tableSession.update({ where: { id }, data: { tableNumber } });

      await auditInTransaction(tx, {
        cafeId: ts.cafeId, userId: session.id, action: "TABLE_TRANSFERRED",
        entity: "TableSession", entityId: id,
        details: {
          branchId: ts.branchId, tableSessionId: id,
          oldValue: ts.tableNumber, newValue: tableNumber,
        },
      });

      return NextResponse.json({ ok: true });
    }, resolveReadScope(session));
  } catch (error) {
    return handleApiError(error);
  }
}
