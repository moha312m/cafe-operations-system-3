import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { sessionDisplayStatus } from "@/lib/table-sessions";

type Params = { params: Promise<{ id: string }> };

// GET /api/tables/[id] — full session detail: orders, items (with paid
// quantities), payments. Tenant + branch scoped.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("tables.view");
    const { id } = await params;

    const ts = await db.tableSession.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, name: true } },
        orders: {
          orderBy: { createdAt: "asc" },
          include: {
            items: { include: { addOns: true, itemPayments: { select: { quantityPaid: true } } } },
            createdBy: { select: { name: true } },
          },
        },
        payments: {
          where: { status: { in: ["PAID", "REFUNDED"] } },
          orderBy: { createdAt: "asc" },
          include: { receivedBy: { select: { name: true } } },
        },
      },
    });
    if (!ts) throw new ApiError(404, "الجلسة غير موجودة");
    if (session.role !== "SUPER_ADMIN" && ts.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && ts.branchId !== session.branchId) {
      throw new ApiError(403, "الترابيزة تبع فرع تاني");
    }

    // Also surface payments recorded directly on session orders (e.g. POS
    // inline payments made before the session id existed on the payment).
    const orderIds = ts.orders.map((o) => o.id);
    const orderPayments = orderIds.length
      ? await db.payment.findMany({
          where: { orderId: { in: orderIds }, status: { in: ["PAID", "REFUNDED"] }, tableSessionId: null },
          orderBy: { createdAt: "asc" },
          include: { receivedBy: { select: { name: true } } },
        })
      : [];
    const allPayments = [...ts.payments, ...orderPayments].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return NextResponse.json({
      session: {
        id: ts.id,
        tableNumber: ts.tableNumber,
        branch: ts.branch.name,
        status: ts.status,
        displayStatus: sessionDisplayStatus(ts),
        startedAt: ts.startedAt,
        closedAt: ts.closedAt,
        totalAmount: Number(ts.totalAmount),
        paidAmount: Number(ts.paidAmount),
        remainingAmount: Number(ts.remainingAmount),
        customerName: ts.customerName,
        notes: ts.notes,
      },
      orders: ts.orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        source: o.source,
        status: o.status,
        paymentStatus: o.paymentStatus,
        total: Number(o.total),
        paidAmount: Number(o.paidAmount),
        remainingAmount: Number(o.remainingAmount),
        createdAt: o.createdAt,
        createdBy: o.createdBy?.name ?? null,
        items: o.items.map((it) => {
          const paidQty = it.itemPayments.reduce((s, p) => s + p.quantityPaid, 0);
          return {
            id: it.id,
            productName: it.productName,
            variantName: it.variantName,
            unitPrice: Number(it.unitPrice),
            quantity: it.quantity,
            lineTotal: Number(it.lineTotal),
            notes: it.notes,
            kitchenStatus: it.kitchenStatus,
            paidQuantity: Math.min(paidQty, it.quantity),
            remainingQuantity: Math.max(it.quantity - paidQty, 0),
            addOns: it.addOns.map((a) => ({ name: a.addOnName, price: Number(a.price) })),
          };
        }),
      })),
      payments: allPayments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        method: p.method,
        status: p.status,
        note: p.note,
        receivedBy: p.receivedBy.name,
        createdAt: p.createdAt,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
