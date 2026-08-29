import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

// The café-wide default, which every branch inherits unless it overrides.
// Scoped to the caller's own café: the cafeId is taken from the session and
// never from the request, so one tenant cannot address another's settings.
function cafeIdOf(session: { role: string; cafeId: string | null }) {
  if (!session.cafeId) throw new ApiError(400, "المستخدم غير مرتبط بكافيه");
  return session.cafeId;
}

export async function GET() {
  try {
    const session = await requirePermission("orders:create");
    const cafeId = cafeIdOf(session);
    const settings = await db.cafeSettings.findUnique({
      where: { cafeId },
      select: { dineInServingPolicy: true, takeawayServingPolicy: true },
    });
    // A café with no settings row has never opted in; the stricter rule
    // applies rather than inventing a permissive default.
    return NextResponse.json({
      policy: {
        dineIn: settings?.dineInServingPolicy ?? "REQUIRE_PAYMENT_FIRST",
        takeaway: settings?.takeawayServingPolicy ?? "REQUIRE_PAYMENT_FIRST",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const policyValue = z.enum(["ALLOW_BEFORE_PAYMENT", "REQUIRE_PAYMENT_FIRST"]);
const patchSchema = z.object({
  dineInServingPolicy: policyValue.optional(),
  takeawayServingPolicy: policyValue.optional(),
});

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireKey("settings.edit");
    const cafeId = cafeIdOf(session);
    const data = patchSchema.parse(await request.json());

    const prev = await db.cafeSettings.findUnique({ where: { cafeId } });
    const updated = await db.cafeSettings.upsert({
      where: { cafeId },
      create: { cafeId, ...data },
      update: data,
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "SERVING_POLICY_UPDATED",
      entity: "CafeSettings",
      entityId: updated.id,
      details: {
        byName: session.name,
        scope: "CAFE",
        oldValue: {
          dineIn: prev?.dineInServingPolicy ?? null,
          takeaway: prev?.takeawayServingPolicy ?? null,
        },
        newValue: {
          dineIn: updated.dineInServingPolicy,
          takeaway: updated.takeawayServingPolicy,
        },
      },
    });

    return NextResponse.json({
      policy: {
        dineIn: updated.dineInServingPolicy,
        takeaway: updated.takeawayServingPolicy,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
