import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError, ApiError } from "@/lib/api";
import { normalizeEgyptianPhone } from "@/lib/phone";
import { getLoyaltySettings, loyaltyCalcSettings } from "@/lib/loyalty";

// GET /api/customers/lookup?phone= — single-customer lookup for the POS
// order screen. Gated by pos.create_order (NOT customers.view): cashiers
// can identify the customer in front of them without being able to browse
// the whole customer list.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("pos.create_order");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const phone = params.get("phone")?.trim() ?? "";

    const normalized = normalizeEgyptianPhone(phone);
    if (!normalized) throw new ApiError(400, "رقم الموبايل غير صحيح");

    const settings = await getLoyaltySettings(cafeId);
    const customer = await db.customer.findUnique({
      where: { cafeId_normalizedPhone: { cafeId, normalizedPhone: normalized } },
    });

    return NextResponse.json({
      loyalty: loyaltyCalcSettings(settings),
      customer: customer
        ? {
            id: customer.id,
            name: customer.name,
            phone: customer.normalizedPhone,
            loyaltyPointsBalance: customer.loyaltyPointsBalance,
            totalOrders: customer.totalOrders,
            lastOrderAt: customer.lastOrderAt,
            isActive: customer.isActive,
          }
        : null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
