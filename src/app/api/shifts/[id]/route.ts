import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolvePermissions } from "@/lib/perms/effective";
import { getSession } from "@/lib/auth";
import { handleApiError, ApiError, requireActiveSession } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

// GET /api/shifts/[id] — full shift detail: summary, its orders, payments,
// refunds and the shift's audit trail. Cashiers may only open their own.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
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
    // No oversight permission → only your own shift. Read from the
    // effective keys (R-SEC-01), so a café that grants or revokes shift
    // oversight through a custom role is actually obeyed.
    const { keys } = await resolvePermissions(session);
    if (!keys.has("shifts.view_reports") && shift.cashierId !== session.id) {
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
            // Drives whether a refund is still offered on this order.
            paymentStatus: true,
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
      // Both shapes count as a refund: a REFUND row, and the legacy
      // in-period reversal that flipped the collection to REFUNDED.
      refunds: payments.filter((p) => p.type === "REFUND" || p.status === "REFUNDED"),
      auditLogs,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
