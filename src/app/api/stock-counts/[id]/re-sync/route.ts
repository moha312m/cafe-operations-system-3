import { NextResponse, type NextRequest } from "next/server";
import { requireActiveSession, handleApiError, ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { round3 } from "@/lib/costing";

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

    if (countSession.status === "CONFIRMED" || countSession.status === "LOCKED") {
      throw new ApiError(400, "لا يمكن إعادة مزامنة جلسة جرد مغلقة أو معتمدة نهائياً");
    }

    let updatedLinesCount = 0;
    await db.$transaction(async (tx) => {
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
