import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  requireActiveSession,
  requireFeature,
  resolveCafeId,
  handleApiError,
} from "@/lib/api";

export async function GET(request: NextRequest) {
  try {
    const session = await requireActiveSession();
    await requireFeature(session, "inventoryEnabled");
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const branchId = request.nextUrl.searchParams.get("branchId") || session.branchId;
    const countOnly = request.nextUrl.searchParams.get("countOnly") === "1" || request.nextUrl.searchParams.get("countOnly") === "true";

    const whereClause = {
      status: "PENDING_APPROVAL" as const,
      line: {
        session: {
          cafeId,
          ...(branchId ? { branchId } : {}),
        },
      },
    };

    if (countOnly) {
      const count = await db.stockCountCorrection.count({ where: whereClause });
      return NextResponse.json({ count });
    }

    const pendingCorrections = await db.stockCountCorrection.findMany({
      where: whereClause,
      select: {
        id: true,
        lineId: true,
        oldCountedQuantity: true,
        newCountedQuantity: true,
        note: true,
        createdAt: true,
        actor: { select: { id: true, name: true, role: true } },
        reasonCode: { select: { id: true, code: true, label: true } },
        line: {
          select: {
            id: true,
            unit: true,
            expectedQuantity: true,
            sessionId: true,
            inventoryItem: { select: { id: true, name: true } },
            session: { select: { id: true, handoverId: true, branchId: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ count: pendingCorrections.length, pendingCorrections });
  } catch (error) {
    return handleApiError(error);
  }
}
