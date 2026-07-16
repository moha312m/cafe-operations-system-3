import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  getCafeSettings,
  toFeatureMap,
  FEATURE_FLAGS,
  WORKFLOW_SWITCHES,
} from "@/lib/cafe-settings";
import type { Prisma } from "@prisma/client";

type Params = { params: Promise<{ cafeId: string }> };

// SUPER_ADMIN only — the platform owner toggles modules & workflow per
// cafe. Every change is audited with old/new values.
const boolSchema = z.boolean();
const patchSchema = z.object({
  workflowMode: z.enum(["FULL_SERVICE", "SMALL_CAFE", "TAKEAWAY_ONLY", "RESTAURANT"]).optional(),
  qrOrderRoutingMode: z
    .enum(["WAITER_APPROVAL", "CASHIER_DIRECT", "KITCHEN_DIRECT", "AUTO_CONFIRMED"])
    .optional(),
  aiAssistantEnabled: boolSchema.optional(),
  qrMenuEnabled: boolSchema.optional(),
  waiterApprovalEnabled: boolSchema.optional(),
  kitchenScreenEnabled: boolSchema.optional(),
  inventoryEnabled: boolSchema.optional(),
  shiftManagementEnabled: boolSchema.optional(),
  advancedReportsEnabled: boolSchema.optional(),
  excelImportEnabled: boolSchema.optional(),
  recipeCostingEnabled: boolSchema.optional(),
  staffManagementEnabled: boolSchema.optional(),
  branchManagementEnabled: boolSchema.optional(),
  requireShiftForQrOrders: boolSchema.optional(),
  allowCashierToPrepareOrders: boolSchema.optional(),
  allowCashierToServeOrders: boolSchema.optional(),
  enableTables: boolSchema.optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("platform:manage");
    const { cafeId } = await params;
    const cafe = await db.cafe.findUnique({ where: { id: cafeId }, select: { id: true, name: true } });
    if (!cafe) throw new ApiError(404, "الكافيه غير موجود");

    const prev = await getCafeSettings(cafeId);
    const data = patchSchema.parse(await request.json());

    const updated = await db.cafeSettings.update({
      where: { cafeId },
      data: data as Prisma.CafeSettingsUpdateInput,
    });

    const base = { cafeId, userId: session.id, entity: "CafeSettings", entityId: updated.id };
    const who = { cafeName: cafe.name, byName: session.name };

    // Feature flags → CAFE_FEATURE_ENABLED / _DISABLED per changed flag.
    for (const flag of [...FEATURE_FLAGS, ...WORKFLOW_SWITCHES]) {
      if (data[flag] !== undefined && data[flag] !== prev[flag]) {
        await audit({
          ...base,
          action: data[flag] ? "CAFE_FEATURE_ENABLED" : "CAFE_FEATURE_DISABLED",
          details: { ...who, feature: flag, oldValue: prev[flag], newValue: data[flag] },
        });
      }
    }
    if (data.workflowMode !== undefined && data.workflowMode !== prev.workflowMode) {
      await audit({
        ...base,
        action: "CAFE_WORKFLOW_CHANGED",
        details: { ...who, oldValue: prev.workflowMode, newValue: data.workflowMode },
      });
    }
    if (data.qrOrderRoutingMode !== undefined && data.qrOrderRoutingMode !== prev.qrOrderRoutingMode) {
      await audit({
        ...base,
        action: "QR_ROUTING_CHANGED",
        details: { ...who, oldValue: prev.qrOrderRoutingMode, newValue: data.qrOrderRoutingMode },
      });
    }
    await audit({ ...base, action: "CAFE_SETTINGS_UPDATED", details: who });

    return NextResponse.json({ settings: toFeatureMap(updated) });
  } catch (error) {
    return handleApiError(error);
  }
}

// Reset to schema defaults ("استرجاع الإعدادات الافتراضية").
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("platform:manage");
    const { cafeId } = await params;
    const cafe = await db.cafe.findUnique({ where: { id: cafeId }, select: { id: true, name: true } });
    if (!cafe) throw new ApiError(404, "الكافيه غير موجود");

    await db.cafeSettings.delete({ where: { cafeId } }).catch(() => {});
    const fresh = await getCafeSettings(cafeId);

    await audit({
      cafeId,
      userId: session.id,
      action: "CAFE_SETTINGS_UPDATED",
      entity: "CafeSettings",
      entityId: fresh.id,
      details: { cafeName: cafe.name, byName: session.name, reset: true },
    });

    return NextResponse.json({ settings: toFeatureMap(fresh) });
  } catch (error) {
    return handleApiError(error);
  }
}
