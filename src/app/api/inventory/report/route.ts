import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError } from "@/lib/api";
import { round2 } from "@/lib/inventory";
import type { Prisma } from "@prisma/client";

// GET /api/inventory/report — value, low/out lists, movement history, waste.
//   ?branchId= ?category= ?from=YYYY-MM-DD ?to=YYYY-MM-DD
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("inventory:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    const category = params.get("category") ?? undefined;

    const from = params.get("from") ? new Date(params.get("from")!) : undefined;
    const to = params.get("to") ? new Date(`${params.get("to")!}T23:59:59`) : undefined;

    const itemWhere: Prisma.InventoryItemWhereInput = {
      cafeId,
      archivedAt: null,
      ...(branchId ? { branchId } : {}),
      ...(category ? { category } : {}),
    };

    const items = await db.inventoryItem.findMany({
      where: itemWhere,
      select: {
        id: true,
        name: true,
        unit: true,
        currentStock: true,
        minimumStock: true,
        costPerUnit: true,
        updatedAt: true,
        branch: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    });

    let stockValue = 0;
    const lowStock: typeof items = [];
    const outOfStock: typeof items = [];
    for (const i of items) {
      const cur = Number(i.currentStock);
      stockValue += cur * Number(i.costPerUnit);
      if (cur <= 0) outOfStock.push(i);
      else if (cur <= Number(i.minimumStock)) lowStock.push(i);
    }

    const txnWhere: Prisma.InventoryTransactionWhereInput = {
      cafeId,
      ...(branchId ? { branchId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };

    const [movements, wasteAgg] = await Promise.all([
      db.inventoryTransaction.findMany({
        where: txnWhere,
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          inventoryItem: { select: { name: true, unit: true } },
          branch: { select: { name: true } },
          createdBy: { select: { name: true } },
        },
      }),
      db.inventoryTransaction.aggregate({
        where: { ...txnWhere, type: "WASTE" },
        _sum: { totalCost: true },
      }),
    ]);

    return NextResponse.json({
      stockValue: round2(stockValue),
      itemCount: items.length,
      lowStock,
      outOfStock,
      wasteTotal: round2(Number(wasteAgg._sum.totalCost ?? 0)),
      movements,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
