import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { resolvePermissions } from "@/lib/perms/effective";
import { handleApiError, ApiError, requireActiveSession, resolveReadScope } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

// GET /api/shifts/[id] — full financial detail for oversight only.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireActiveSession();
    const { id } = await params;

    const scope = resolveReadScope(session);
    const { keys } = await resolvePermissions(session);
    if (!keys.has("shifts.view_reports")) throw new ApiError(403, "Not allowed");
    const shift = await db.shift.findFirst({
      where: { id, ...scope },
      include: {
        cashier: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
    });
    if (!shift) throw new ApiError(404, "Shift not found");

    const payments = await db.payment.findMany({
      where: { shiftId: id, cafeId: shift.cafeId },
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
            paidAmount: true,
            payments: {
              where: { type: "COLLECTION", status: "PAID", reversalOfPaymentId: null, reversedBy: { none: {} } },
              select: { method: true, amount: true },
            },
          },
        },
      },
    });

    // Distinct orders touched by this shift's payments.
    const orderMap = new Map<string, (typeof payments)[number]["order"]>();
    for (const p of payments) if (p.order) orderMap.set(p.order.id, p.order);

    const auditLogs = await db.auditLog.findMany({
      where: {
        cafeId: shift.cafeId,
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
