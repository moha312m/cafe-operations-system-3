import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError, ApiError, resolveReadScope } from "@/lib/api";

const OPEN_STATUSES = ["PENDING_WAITER_APPROVAL", "CONFIRMED", "PREPARING", "READY"] as const;

// GET /api/handovers/carried-orders?branchId= — orders a closing shift passed
// to whoever comes next that still need something: serving, or collecting an
// unpaid balance. Read-only. Branch-pinned users only ever see their branch.
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("orders:read");
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const requested = request.nextUrl.searchParams.get("branchId");
    const branchId = resolveReadScope(session).branchId ?? requested;
    if (session.branchId && requested && requested !== session.branchId) {
      throw new ApiError(403, "Not allowed");
    }

    const rows = await db.handoverCarriedOrder.findMany({
      where: {
        cafeId,
        ...(branchId ? { branchId } : {}),
        order: {
          OR: [
            { status: { in: [...OPEN_STATUSES] } },
            { paymentStatus: { in: ["UNPAID", "PENDING_COLLECTION", "PARTIAL"] }, status: { notIn: ["CANCELLED", "REJECTED"] } },
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        statusAtHandover: true,
        remainingAtHandover: true,
        stockDeductedAtHandover: true,
        shift: { select: { shiftNumber: true, cashier: { select: { name: true } } } },
        order: {
          select: {
            id: true, orderNumber: true, status: true, paymentStatus: true, type: true,
            tableNumber: true, customerName: true, total: true, paidAmount: true, stockDeductedAt: true,
            items: { where: { voidedAt: null }, select: { stockModeSnapshot: true, stockAcceptedAt: true, finishedStockDeductedAt: true } },
          },
        },
      },
    });

    // An order carried twice (left open across two handovers) is listed once,
    // under its most recent handover.
    const seen = new Set<string>();
    const orders = rows.filter((r) => !seen.has(r.order.id) && seen.add(r.order.id)).map((r) => ({
      orderId: r.order.id,
      orderNumber: r.order.orderNumber,
      status: r.order.status,
      paymentStatus: r.order.paymentStatus,
      type: r.order.type,
      tableNumber: r.order.tableNumber,
      customerName: r.order.customerName,
      remaining: Math.max(0, Math.round((Number(r.order.total) - Number(r.order.paidAmount)) * 100) / 100),
      statusAtHandover: r.statusAtHandover,
      stockDeductedAtHandover: r.stockDeductedAtHandover,
      recipesAlreadyProcessed: !!r.order.stockDeductedAt, finishedStockPending: r.order.items.some(i => i.stockModeSnapshot === "FINISHED_GOOD" && !!i.stockAcceptedAt && !i.finishedStockDeductedAt),
      carriedAt: r.createdAt,
      fromShiftNumber: r.shift.shiftNumber,
      fromCashier: r.shift.cashier.name,
    }));

    return NextResponse.json({ orders });
  } catch (error) {
    return handleApiError(error);
  }
}
