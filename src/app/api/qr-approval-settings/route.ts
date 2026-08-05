import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireKey, resolveCafeId, resolveBranchId, handleApiError, ApiError, requireFeature,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { getApprovalSettings } from "@/lib/qr-approval";
import { getCafeSettings } from "@/lib/cafe-settings";

const ROLES = ["BRANCH_MANAGER", "WAITER", "CASHIER", "BARISTA", "INVENTORY_MANAGER"] as const;

// GET /api/qr-approval-settings?branchId= — current settings + feature locks
// + candidate approver users (for SPECIFIC_USER).
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("settings.edit_qr_approval");
    await requireFeature(session, "qrMenuEnabled");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    if (!branchId) throw new ApiError(400, "اختار الفرع الأول");

    const [settings, cafe, users] = await Promise.all([
      getApprovalSettings(cafeId, branchId),
      getCafeSettings(cafeId),
      db.user.findMany({
        where: { cafeId, archivedAt: null, isActive: true, branchId: session.branchId ? branchId : { in: [branchId] } },
        select: { id: true, name: true, role: true },
        orderBy: { name: "asc" },
      }),
    ]);

    return NextResponse.json({
      settings: {
        enabled: settings.enabled,
        approvalMode: settings.approvalMode,
        targetRole: settings.targetRole,
        targetUserId: settings.targetUserId,
        autoConfirm: settings.autoConfirm,
        allowApproverToEditOrder: settings.allowApproverToEditOrder,
        allowApproverToRejectOrder: settings.allowApproverToRejectOrder,
        sendToKitchenAfterApproval: settings.sendToKitchenAfterApproval,
      },
      locks: {
        waiterApprovalEnabled: cafe.waiterApprovalEnabled,
        kitchenScreenEnabled: cafe.kitchenScreenEnabled,
      },
      users,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const putSchema = z.object({
  branchId: z.string().optional(),
  cafeId: z.string().optional(),
  enabled: z.boolean().optional(),
  approvalMode: z.enum([
    "AUTO_CONFIRM", "ROLE_BASED", "SPECIFIC_USER", "ANY_AUTHORIZED_USER",
    "CASHIER_DIRECT", "WAITER_APPROVAL", "MANAGER_APPROVAL", "KITCHEN_DIRECT",
  ]),
  targetRole: z.enum(ROLES).nullable().optional(),
  targetUserId: z.string().nullable().optional(),
  allowApproverToEditOrder: z.boolean().optional(),
  allowApproverToRejectOrder: z.boolean().optional(),
  sendToKitchenAfterApproval: z.boolean().optional(),
});

// PUT /api/qr-approval-settings — save the branch's approval routing.
export async function PUT(request: NextRequest) {
  try {
    const session = await requireKey("settings.edit_qr_approval");
    await requireFeature(session, "qrMenuEnabled");
    const data = putSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);
    const branchId = resolveBranchId(session, data.branchId);

    // Mode-specific requirements.
    if (data.approvalMode === "SPECIFIC_USER" && !data.targetUserId) {
      throw new ApiError(400, "اختار الموظف المسؤول");
    }
    if (data.approvalMode === "ROLE_BASED" && !data.targetRole) {
      throw new ApiError(400, "اختار الدور المسؤول");
    }
    if (data.targetUserId) {
      const u = await db.user.findFirst({ where: { id: data.targetUserId, cafeId }, select: { id: true } });
      if (!u) throw new ApiError(400, "الموظف غير موجود");
    }

    // Feature locks.
    const cafe = await getCafeSettings(cafeId);
    if (data.approvalMode === "WAITER_APPROVAL" && !cafe.waiterApprovalEnabled) {
      throw new ApiError(400, "موافقة الويتر غير مفعلة لهذا الكافيه");
    }
    if (data.approvalMode === "KITCHEN_DIRECT" && !cafe.kitchenScreenEnabled) {
      throw new ApiError(400, "شاشة البار غير مفعلة لهذا الكافيه");
    }

    const prev = await getApprovalSettings(cafeId, branchId);
    const autoConfirm = data.approvalMode === "AUTO_CONFIRM";
    // Clear the wrong assignment field for the chosen mode.
    const targetRole = data.approvalMode === "ROLE_BASED" ? (data.targetRole ?? null) : null;
    const targetUserId = data.approvalMode === "SPECIFIC_USER" ? (data.targetUserId ?? null) : null;

    const updated = await db.qrOrderApprovalSettings.update({
      where: { branchId },
      data: {
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        approvalMode: data.approvalMode,
        targetRole, targetUserId, autoConfirm,
        ...(data.allowApproverToEditOrder !== undefined ? { allowApproverToEditOrder: data.allowApproverToEditOrder } : {}),
        ...(data.allowApproverToRejectOrder !== undefined ? { allowApproverToRejectOrder: data.allowApproverToRejectOrder } : {}),
        ...(data.sendToKitchenAfterApproval !== undefined ? { sendToKitchenAfterApproval: data.sendToKitchenAfterApproval } : {}),
      },
    });

    await audit({
      cafeId, userId: session.id, action: "QR_APPROVAL_SETTINGS_UPDATED",
      entity: "QrOrderApprovalSettings", entityId: updated.id,
      details: {
        branchId,
        oldValue: { mode: prev.approvalMode, targetRole: prev.targetRole, targetUserId: prev.targetUserId, enabled: prev.enabled },
        newValue: { mode: updated.approvalMode, targetRole: updated.targetRole, targetUserId: updated.targetUserId, enabled: updated.enabled },
        assignedApproverRole: updated.targetRole,
        assignedApproverUserId: updated.targetUserId,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
