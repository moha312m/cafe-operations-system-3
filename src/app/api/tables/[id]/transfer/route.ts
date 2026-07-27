import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ tableNumber: z.string().trim().min(1, "رقم الترابيزة مطلوب") });

// POST /api/tables/[id]/transfer — move an open session to another table
// (target must not already have an open session).
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("tables.transfer");
    const { id } = await params;
    const { tableNumber } = bodySchema.parse(await request.json());

    const ts = await db.tableSession.findUnique({ where: { id } });
    if (!ts) throw new ApiError(404, "الجلسة غير موجودة");
    if (session.role !== "SUPER_ADMIN" && ts.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && ts.branchId !== session.branchId) {
      throw new ApiError(403, "الترابيزة تبع فرع تاني");
    }
    if (ts.status !== "OPEN") throw new ApiError(400, "الجلسة مقفولة");
    if (tableNumber === ts.tableNumber) throw new ApiError(400, "نفس الترابيزة الحالية");

    const clash = await db.tableSession.findFirst({
      where: { cafeId: ts.cafeId, branchId: ts.branchId, tableNumber, status: "OPEN" },
    });
    if (clash) throw new ApiError(400, `الترابيزة ${tableNumber} عليها جلسة مفتوحة بالفعل`);

    await db.$transaction([
      db.tableSession.update({ where: { id }, data: { tableNumber } }),
      // Orders carry the table number for the kitchen — keep them in sync.
      db.order.updateMany({ where: { tableSessionId: id }, data: { tableNumber } }),
    ]);

    await audit({
      cafeId: ts.cafeId, userId: session.id, action: "TABLE_TRANSFERRED",
      entity: "TableSession", entityId: id,
      details: {
        branchId: ts.branchId, tableSessionId: id,
        oldValue: ts.tableNumber, newValue: tableNumber,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
