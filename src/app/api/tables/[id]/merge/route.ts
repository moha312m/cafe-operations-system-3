import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { recomputeSessionTotals } from "@/lib/table-sessions";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ targetTableNumber: z.string().trim().min(1, "رقم الترابيزة مطلوب") });

// POST /api/tables/[id]/merge — merge this session INTO the open session
// of another table: orders + payments move over, this session is cancelled.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("tables.merge");
    const { id } = await params;
    const { targetTableNumber } = bodySchema.parse(await request.json());

    const source = await db.tableSession.findUnique({ where: { id } });
    if (!source) throw new ApiError(404, "الجلسة غير موجودة");
    if (session.role !== "SUPER_ADMIN" && source.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && source.branchId !== session.branchId) {
      throw new ApiError(403, "الترابيزة تبع فرع تاني");
    }
    if (source.status !== "OPEN") throw new ApiError(400, "الجلسة مقفولة");

    const target = await db.tableSession.findFirst({
      where: {
        cafeId: source.cafeId, branchId: source.branchId,
        tableNumber: targetTableNumber, status: "OPEN", id: { not: id },
      },
    });
    if (!target) throw new ApiError(400, `مفيش جلسة مفتوحة على الترابيزة ${targetTableNumber}`);

    await db.$transaction([
      db.order.updateMany({
        where: { tableSessionId: id },
        data: { tableSessionId: target.id, tableNumber: target.tableNumber },
      }),
      db.payment.updateMany({ where: { tableSessionId: id }, data: { tableSessionId: target.id } }),
      db.orderItemPayment.updateMany({ where: { tableSessionId: id }, data: { tableSessionId: target.id } }),
      db.tableSession.update({
        where: { id },
        data: { status: "CANCELLED", closedAt: new Date(), closedByUserId: session.id },
      }),
    ]);
    await recomputeSessionTotals(target.id);
    await recomputeSessionTotals(id);

    await audit({
      cafeId: source.cafeId, userId: session.id, action: "TABLE_MERGED",
      entity: "TableSession", entityId: target.id,
      details: {
        branchId: source.branchId,
        oldValue: { sourceSessionId: id, sourceTable: source.tableNumber },
        newValue: { targetSessionId: target.id, targetTable: target.tableNumber },
      },
    });

    return NextResponse.json({ ok: true, targetSessionId: target.id });
  } catch (error) {
    return handleApiError(error);
  }
}
