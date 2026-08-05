import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { getCafeSettings } from "@/lib/cafe-settings";
import { sessionDisplayStatus } from "@/lib/table-sessions";

// GET /api/tables/selector?branchId= — active configured tables for a branch,
// each annotated with its live open-session state. Powers the POS visual
// table picker, the /tables board, and the QR links list.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("tables.view");
    await requireFeature(session, "enableTables");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    if (!branchId) throw new ApiError(400, "اختار الفرع الأول");

    const [tables, openSessions, settings] = await Promise.all([
      db.cafeTable.findMany({
        where: { cafeId, branchId, isActive: true, archivedAt: null },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      db.tableSession.findMany({
        where: { cafeId, branchId, status: "OPEN" },
        select: { id: true, tableNumber: true, totalAmount: true, paidAmount: true, remainingAmount: true, startedAt: true },
      }),
      getCafeSettings(cafeId),
    ]);

    const sessionByNumber = new Map(openSessions.map((s) => [s.tableNumber, s]));

    return NextResponse.json({
      allowCustomTables: settings.allowCustomTables,
      tables: tables.map((t) => {
        const s = sessionByNumber.get(t.tableNumber);
        return {
          id: t.id,
          tableNumber: t.tableNumber,
          displayName: t.displayName,
          area: t.area,
          seatsCount: t.seatsCount,
          session: s
            ? {
                id: s.id,
                displayStatus: sessionDisplayStatus(s),
                remainingAmount: Number(s.remainingAmount),
                totalAmount: Number(s.totalAmount),
                startedAt: s.startedAt,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
