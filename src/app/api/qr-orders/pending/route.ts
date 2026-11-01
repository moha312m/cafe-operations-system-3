import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, requireActiveSession, resolveReadScope } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { approvalQueueWhere } from "@/lib/qr-approval";
import { orderPage } from "@/lib/order-pagination";

// GET /api/qr-orders/pending — pending QR orders the CURRENT user may
// approve (assignment-aware). ?countOnly=1 returns just the badge count.
export async function GET(request: NextRequest) {
  try {
    const session = await requireActiveSession();
    const { keys } = await resolvePermissions(session);
    // Must be able to view QR orders at all.
    if (!keys.has("qr_orders.view") && !keys.has("qr_orders.approve")) {
      return NextResponse.json({ orders: [], count: 0, pageInfo: { hasMore: false, nextCursor: null }, canApprove: false, canReject: false, canEdit: false });
    }
    const where = { ...approvalQueueWhere(session, keys.has("qr_orders.approve")), ...resolveReadScope(session) };

    if (request.nextUrl.searchParams.get("countOnly") === "1") {
      const count = await db.order.count({ where });
      return NextResponse.json({ count });
    }

    const page = orderPage(request.nextUrl.searchParams, where);
    const rows = await db.order.findMany({
      where: page.where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.pageSize + 1,
      include: {
        items: { include: { addOns: true } },
        branch: { select: { name: true } },
        assignedApprover: { select: { name: true } },
      },
    });
    const { orders, pageInfo } = page.finish(rows);
    const count = await db.order.count({ where });

    return NextResponse.json({
      count,
      pageInfo,
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
