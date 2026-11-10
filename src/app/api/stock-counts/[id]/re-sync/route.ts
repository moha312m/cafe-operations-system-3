import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { db } from "@/lib/db";
import { round3 } from "@/lib/costing";
import { auditInTransaction } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;

    const countSession = await db.stockCountSession.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            inventoryItem: { select: { currentStock: true } },
          },
        },
      },
    });

    if (!countSession || (session.cafeId && countSession.cafeId !== session.cafeId)) {
      throw new ApiError(404, "جلسة الجرد غير موجودة");
    }

    const { keys } = await resolvePermissions(session);
    const isOwner = session.role === "CAFE_OWNER" || session.role === "SUPER_ADMIN";
    const isBranchManager = session.role === "BRANCH_MANAGER" && session.branchId === countSession.branchId;
    const hasPermission = keys.has("stock_count.correct") || keys.has("stock_count.confirm");

    if (!isOwner && !isBranchManager && !hasPermission) {
      throw new ApiError(403, "صلاحية إعادة مزامنة الجرد مخصصة للمالك أو مدير هذا الفرع فقط");
    }

    let updatedLinesCount = 0;
    await db.$transaction(async (tx) => {
      // Re-read status under transaction lock to prevent race condition
      const current = await tx.stockCountSession.findUnique({
        where: { id },
        select: { status: true, branchId: true },
      });
      if (!current || current.status === "CONFIRMED" || current.status === "LOCKED") {
        throw new ApiError(409, "لا يمكن إعادة مزامنة جلسة جرد مغلقة أو معتمدة نهائياً");
      }

      for (const line of countSession.lines) {
        if (line.inventoryItem) {
          const newExpected = round3(Number(line.inventoryItem.currentStock));
          const activeCounted = line.effectiveCountedQuantity ?? line.countedQuantity;
          let newVariance: number | null = null;
          let newDisposition = line.disposition;

          if (activeCounted !== null) {
            newVariance = round3(Number(activeCounted) - newExpected);
            newDisposition = newVariance === 0 ? "COUNTED" : "VARIANCE_RECORDED";
          }

          await tx.stockCountLine.update({
            where: { id: line.id },
            data: {
              expectedQuantity: newExpected,
              varianceQuantity: newVariance,
              disposition: newDisposition,
            },
          });
          updatedLinesCount++;
        }
      }

      await auditInTransaction(tx, {
        cafeId: countSession.cafeId,
        userId: session.id,
        action: "STOCK_COUNT_RESYNCED",
        entity: "StockCountSession",
        entityId: countSession.id,
        details: {
          branchId: countSession.branchId,
          updatedLinesCount,
        },
      });
    });

    return NextResponse.json({
      success: true,
      updatedLinesCount,
      message: `تم تحديث ومزامنة ${updatedLinesCount} صنف مع الرصيد الحالي للمخزن`,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
