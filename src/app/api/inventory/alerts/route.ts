import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError, requireFeature } from "@/lib/api";
import { getLowStockAlertPercent, withStockAlerts } from "@/lib/low-stock";

const LISTED = 5;

// GET /api/inventory/alerts — what the low-stock banner shows.
// Branch-pinned users only ever see their own branch; read-only.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("inventory:read");
    await requireFeature(session, "inventoryEnabled");
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    const items = await db.inventoryItem.findMany({
      where: {
        cafeId,
        archivedAt: null,
        isActive: true,
        ...(session.branchId ? { branchId: session.branchId } : {}),
      },
      select: {
        id: true, name: true, unit: true, currentStock: true, minimumStock: true,
        branch: { select: { name: true } },
      },
    });

    const flagged = (await withStockAlerts(cafeId, items))
      .filter((i) => i.status !== "ok")
      .sort((a, b) =>
        a.status === b.status
          ? Number(a.currentStock) / (a.alertThreshold || 1) - Number(b.currentStock) / (b.alertThreshold || 1)
          : a.status === "out" ? -1 : 1
      );

    return NextResponse.json({
      percent: await getLowStockAlertPercent(cafeId),
      outCount: flagged.filter((i) => i.status === "out").length,
      lowCount: flagged.filter((i) => i.status === "low").length,
      items: flagged.slice(0, LISTED).map((i) => ({
        id: i.id,
        name: i.name,
        unit: i.unit,
        branchName: i.branch.name,
        stock: Number(i.currentStock),
        threshold: i.alertThreshold,
        status: i.status,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
