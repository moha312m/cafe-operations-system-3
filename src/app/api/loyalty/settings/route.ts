import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getLoyaltySettings } from "@/lib/loyalty";

function serialize(s: Awaited<ReturnType<typeof getLoyaltySettings>>) {
  return {
    enabled: s.enabled,
    earnPointsPerAmount: s.earnPointsPerAmount,
    earnAmountStep: Number(s.earnAmountStep),
    pointValueAmount: Number(s.pointValueAmount),
    minPointsToRedeem: s.minPointsToRedeem,
    maxRedeemPercentageOfOrder: s.maxRedeemPercentageOfOrder,
    pointsExpireDays: s.pointsExpireDays,
    earnOnPaidOrdersOnly: s.earnOnPaidOrdersOnly,
    customerPhoneRequiredForQr: s.customerPhoneRequiredForQr,
  };
}

// GET /api/loyalty/settings — read the cafe's loyalty configuration.
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("loyalty.view");
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));
    const settings = await getLoyaltySettings(cafeId);
    return NextResponse.json({ settings: serialize(settings) });
  } catch (error) {
    return handleApiError(error);
  }
}

const putSchema = z.object({
  enabled: z.boolean(),
  earnPointsPerAmount: z.number().int().min(0).max(1000),
  earnAmountStep: z.number().min(0.01).max(100000),
  pointValueAmount: z.number().min(0).max(100000),
  minPointsToRedeem: z.number().int().min(0).max(1000000),
  maxRedeemPercentageOfOrder: z.number().int().min(0).max(100),
  pointsExpireDays: z.number().int().min(1).max(3650).nullable().optional(),
  earnOnPaidOrdersOnly: z.boolean(),
  customerPhoneRequiredForQr: z.boolean(),
});

// PUT /api/loyalty/settings — owner-level edit (loyalty.settings_edit).
export async function PUT(request: NextRequest) {
  try {
    const session = await requireKey("loyalty.settings_edit", "ليس لديك صلاحية لتعديل إعدادات الولاء");
    const cafeId = resolveCafeId(session, null);
    const data = putSchema.parse(await request.json());

    const before = await getLoyaltySettings(cafeId);
    const updated = await db.loyaltySettings.update({
      where: { cafeId },
      data: {
        enabled: data.enabled,
        earnPointsPerAmount: data.earnPointsPerAmount,
        earnAmountStep: data.earnAmountStep,
        pointValueAmount: data.pointValueAmount,
        minPointsToRedeem: data.minPointsToRedeem,
        maxRedeemPercentageOfOrder: data.maxRedeemPercentageOfOrder,
        pointsExpireDays: data.pointsExpireDays ?? null,
        earnOnPaidOrdersOnly: data.earnOnPaidOrdersOnly,
        customerPhoneRequiredForQr: data.customerPhoneRequiredForQr,
      },
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "LOYALTY_SETTINGS_UPDATED",
      entity: "LoyaltySettings",
      entityId: updated.id,
      details: { oldValue: serialize(before), newValue: serialize(updated) },
    });

    return NextResponse.json({ settings: serialize(updated) });
  } catch (error) {
    return handleApiError(error);
  }
}
