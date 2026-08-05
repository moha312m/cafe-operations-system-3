import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError, ApiError } from "@/lib/api";
import { sessionDisplayStatus } from "@/lib/table-sessions";

// Orders excluded from the table bill (never shown as invoices).
const INACTIVE = ["CANCELLED", "REJECTED"] as const;

// GET /api/tables/session?branchId=&tableNumber= — the OPEN table session for
// one table, with all its invoices (orders + items + totals) and payments.
// Returns { session: null } when the table has no open session yet. Powers
// the POS "فواتير الترابيزة" cards. Gated by tables.view.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("tables.view");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    const tableNumber = params.get("tableNumber")?.trim();
    if (!branchId) throw new ApiError(400, "اختار الفرع الأول");
    if (!tableNumber) throw new ApiError(400, "رقم الترابيزة مطلوب");

    const ts = await db.tableSession.findFirst({
      where: { cafeId, branchId, tableNumber, status: "OPEN" },
      include: {
        orders: {
          where: { status: { notIn: [...INACTIVE] } },
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

    if (!ts) return NextResponse.json({ session: null });

    return NextResponse.json({
      session: {
        id: ts.id,
        tableNumber: ts.tableNumber,
        displayStatus: sessionDisplayStatus(ts),
        startedAt: ts.startedAt,
        totalAmount: Number(ts.totalAmount),
        paidAmount: Number(ts.paidAmount),
        remainingAmount: Number(ts.remainingAmount),
        invoiceCount: ts.orders.length,
      },
      invoices: ts.orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        source: o.source,
        status: o.status,
        paymentStatus: o.paymentStatus,
        createdAt: o.createdAt,
        createdBy: o.createdBy?.name ?? null,
        subtotal: Number(o.subtotal),
        discountAmount: Number(o.discountAmount),
        serviceChargeAmount: Number(o.serviceChargeAmount),
        taxAmount: Number(o.taxAmount),
        total: Number(o.total),
        paidAmount: Number(o.paidAmount),
        remainingAmount: Number(o.remainingAmount),
        itemCount: o.items.reduce((s, it) => s + it.quantity, 0),
        editable: o.status === "PENDING_WAITER_APPROVAL",
        items: o.items.map((it) => ({
          id: it.id,
          productName: it.productName,
          variantName: it.variantName,
          unitPrice: Number(it.unitPrice),
          quantity: it.quantity,
          lineTotal: Number(it.lineTotal),
          notes: it.notes,
          addOns: it.addOns.map((a) => ({ name: a.addOnName, price: Number(a.price) })),
        })),
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
