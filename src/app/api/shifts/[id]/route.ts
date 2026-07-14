import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { handleApiError, ApiError } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

// GET /api/shifts/[id] — full shift detail: summary, its orders, payments,
// refunds and the shift's audit trail. Cashiers may only open their own.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await getSession();
    if (!session) throw new ApiError(401, "Not authenticated");
    const { id } = await params;

    const shift = await db.shift.findUnique({
      where: { id },
      include: {
        cashier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });
    if (!shift) throw new ApiError(404, "Shift not found");

    // Tenant + scope checks.
    if (session.role !== "SUPER_ADMIN" && shift.cafeId !== session.cafeId) {
      throw new ApiError(403, "Not allowed");
    }
    if (session.branchId && shift.branchId !== session.branchId) {
      throw new ApiError(403, "Not allowed");
    }
    // No read permission → only your own shift.
    if (!hasPermission(session.role, "shifts:read") && shift.cashierId !== session.id) {
      throw new ApiError(403, "Not allowed");
    }

    const payments = await db.payment.findMany({
      where: { shiftId: id },
      orderBy: { paidAt: "desc" },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            total: true,
            discountAmount: true,
            status: true,
          },
        },
      },
    });

    // Distinct orders touched by this shift's payments.
    const orderMap = new Map<string, (typeof payments)[number]["order"]>();
    for (const p of payments) if (p.order) orderMap.set(p.order.id, p.order);

    const auditLogs = await db.auditLog.findMany({
      where: {
        OR: [
          { entity: "Shift", entityId: id },
          { details: { path: ["shiftId"], equals: id } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { name: true } } },
    });

    return NextResponse.json({
      shift,
      orders: [...orderMap.values()],
      payments,
      refunds: payments.filter((p) => p.status === "REFUNDED"),
      auditLogs,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
