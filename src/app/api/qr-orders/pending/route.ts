import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { handleApiError, ApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { approvalQueueWhere } from "@/lib/qr-approval";

// GET /api/qr-orders/pending — pending QR orders the CURRENT user may
// approve (assignment-aware). ?countOnly=1 returns just the badge count.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new ApiError(401, "سجّل دخولك الأول");
    const { keys } = await resolvePermissions(session);
    // Must be able to view QR orders at all.
    if (!keys.has("qr_orders.view") && !keys.has("qr_orders.approve")) {
      return NextResponse.json({ orders: [], count: 0 });
    }
    const where = approvalQueueWhere(session, keys.has("qr_orders.approve"));

    if (request.nextUrl.searchParams.get("countOnly") === "1") {
      const count = await db.order.count({ where });
      return NextResponse.json({ count });
    }

    const orders = await db.order.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: 100,
      include: {
        items: { include: { addOns: true } },
        branch: { select: { name: true } },
        assignedApprover: { select: { name: true } },
      },
    });

    return NextResponse.json({
      count: orders.length,
      canApprove: keys.has("qr_orders.approve"),
      canReject: keys.has("qr_orders.reject"),
      canEdit: keys.has("qr_orders.edit_before_approval"),
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        tableNumber: o.tableNumber,
        customerName: o.customerName,
        notes: o.notes,
        total: Number(o.total),
        createdAt: o.createdAt,
        approvalMode: o.approvalModeSnapshot,
        assignedRole: o.assignedApproverRole,
        assignedUser: o.assignedApprover?.name ?? null,
        items: o.items.map((it) => ({
          id: it.id,
          productName: it.productName,
          variantName: it.variantName,
          quantity: it.quantity,
          unitPrice: Number(it.unitPrice),
          lineTotal: Number(it.lineTotal),
          notes: it.notes,
        })),
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
