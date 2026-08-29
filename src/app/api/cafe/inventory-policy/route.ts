import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  DEFAULT_ENFORCEMENT_MODE,
  INVENTORY_ENFORCEMENT_MODES,
} from "@/lib/inventory-policy";

// How hard this café enforces inventory and recipe completeness at the till.
//
// Scoped to the caller's own café: the cafeId is taken from the session and
// never from the request, so one tenant cannot address another's policy. The
// same rule the serving-policy route works to, and for the same reason.
function cafeIdOf(session: { role: string; cafeId: string | null }) {
  if (!session.cafeId) throw new ApiError(400, "المستخدم غير مرتبط بكافيه");
  return session.cafeId;
}

export async function GET() {
  try {
    // Anyone who can take an order may READ the policy — the POS needs it to
    // explain a refusal. Changing it is a different power, below.
    const session = await requirePermission("orders:create");
    const cafeId = cafeIdOf(session);
    const settings = await db.cafeSettings.findUnique({
      where: { cafeId },
      select: { inventoryEnforcementMode: true },
    });
    // A café with no settings row has never opted in, so the stricter rule
    // applies rather than a permissive default being invented for it.
    return NextResponse.json({
      mode: settings?.inventoryEnforcementMode ?? DEFAULT_ENFORCEMENT_MODE,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z.object({
  mode: z.enum(INVENTORY_ENFORCEMENT_MODES),
});

export async function PATCH(request: NextRequest) {
  try {
    // `settings.edit` is the café-configuration power, which rides with
    // cafe:manage (the owner) and can be granted to a custom admin role. A
    // cashier does not hold it, and this is deliberately not something a till
    // can relax for itself.
    const session = await requireKey("settings.edit");
    const cafeId = cafeIdOf(session);
    const { mode } = patchSchema.parse(await request.json());

    const prev = await db.cafeSettings.findUnique({
      where: { cafeId },
      select: { inventoryEnforcementMode: true },
    });
    const updated = await db.cafeSettings.upsert({
      where: { cafeId },
      create: { cafeId, inventoryEnforcementMode: mode },
      update: { inventoryEnforcementMode: mode },
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "INVENTORY_ENFORCEMENT_MODE_CHANGED",
      entity: "CafeSettings",
      entityId: updated.id,
      details: {
        byName: session.name,
        scope: "CAFE",
        oldValue: prev?.inventoryEnforcementMode ?? null,
        newValue: updated.inventoryEnforcementMode,
      },
    });

    return NextResponse.json({ mode: updated.inventoryEnforcementMode });
  } catch (error) {
    return handleApiError(error);
  }
}
