import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError, ApiError, resolveReadScope } from "@/lib/api";
import { normalizeEgyptianPhone } from "@/lib/phone";

// GET /api/customers/last-order?phone= — the customer's most recent order in
// this café, so the till can offer "repeat last order". Same gate as the
// phone lookup (customers.lookup), café-scoped, read-only. Only what is needed
// to rebuild the cart is returned; prices are never reused — the till prices
// the repeated lines at today's menu and the server re-prices on submit.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("customers.lookup");
    const scope = resolveReadScope(session);
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const normalized = normalizeEgyptianPhone(params.get("phone")?.trim() ?? "");
    if (!normalized) throw new ApiError(400, "رقم الموبايل غير صحيح");

    const customer = await db.customer.findUnique({
      where: { cafeId_normalizedPhone: { cafeId, normalizedPhone: normalized } },
      select: { id: true, name: true },
    });
    if (!customer) return NextResponse.json({ order: null });

    const order = await db.order.findFirst({
      where: { cafeId, ...scope, customerId: customer.id, status: { notIn: ["CANCELLED", "REJECTED"] } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, orderNumber: true, createdAt: true,
        items: {
          where: { kitchenStatus: { not: "CANCELLED" }, productId: { not: null } },
          select: {
            productId: true, variantId: true, productName: true, variantName: true,
            quantity: true, notes: true, addOns: { select: { addOnId: true } },
          },
        },
      },
    });
    if (!order || order.items.length === 0) return NextResponse.json({ order: null });

    return NextResponse.json({
      order: {
        orderNumber: order.orderNumber,
        createdAt: order.createdAt,
        customerName: customer.name,
        items: order.items.map((i) => ({
          productId: i.productId!,
          variantId: i.variantId,
          productName: i.productName,
          variantName: i.variantName,
          quantity: i.quantity,
          notes: i.notes,
          addOnIds: i.addOns.map((a) => a.addOnId).filter((id): id is string => !!id),
        })),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
