import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { normalizeEgyptianPhone } from "@/lib/phone";
import { getLoyaltySettingsSafe, loyaltyCalcSettings } from "@/lib/loyalty";

// GET /api/customers/lookup?phone= — single-customer lookup for the POS
// order screen. Gated by customers.lookup (NOT customers.view): cashiers
// can identify the customer in front of them without being able to browse
// the whole customer list. Cafe-scoped, so another cafe's customer (same
// phone) can never surface here.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("customers.lookup");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const phone = params.get("phone")?.trim() ?? "";

    const normalized = normalizeEgyptianPhone(phone);
    if (!normalized) throw new ApiError(400, "رقم الموبايل غير صحيح");

    const settings = await getLoyaltySettingsSafe(cafeId);
    const customer = await db.customer.findUnique({
      where: { cafeId_normalizedPhone: { cafeId, normalizedPhone: normalized } },
    });

    if (customer) {
      await audit({
        cafeId, userId: session.id,
        action: "CUSTOMER_LOOKED_UP_BY_PHONE",
        entity: "Customer", entityId: customer.id,
        details: { customerId: customer.id, phone: normalized },
      });
    }

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
