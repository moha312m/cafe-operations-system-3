// ── QR order approval routing ────────────────────────────────────────
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import type { QrApprovalMode, Role, CafeWorkflowMode } from "@prisma/client";
import { getCafeSettings } from "@/lib/cafe-settings";

export const APPROVAL_MODE_LABEL: Record<QrApprovalMode, string> = {
  AUTO_CONFIRM: "تأكيد تلقائي",
  ROLE_BASED: "حسب الدور",
  SPECIFIC_USER: "موظف معين",
  ANY_AUTHORIZED_USER: "أي موظف عنده صلاحية التأكيد",
  CASHIER_DIRECT: "الكاشير مباشرة",
  WAITER_APPROVAL: "موافقة الويتر",
  MANAGER_APPROVAL: "موافقة المدير",
  KITCHEN_DIRECT: "البار مباشرة",
};

export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  NOT_REQUIRED: "لا يحتاج تأكيد",
  PENDING_APPROVAL: "في انتظار التأكيد",
  APPROVED: "تم التأكيد",
  REJECTED: "مرفوض",
};

export type ApprovalSettings = {
  id: string;
  branchId: string;
  enabled: boolean;
  approvalMode: QrApprovalMode;
  targetRole: Role | null;
  targetUserId: string | null;
  autoConfirm: boolean;
  allowApproverToEditOrder: boolean;
  allowApproverToRejectOrder: boolean;
  sendToKitchenAfterApproval: boolean;
};

// Sensible default mode for a cafe's workflow (used when lazily creating).
function defaultMode(workflow: CafeWorkflowMode): QrApprovalMode {
  return workflow === "SMALL_CAFE" || workflow === "TAKEAWAY_ONLY"
    ? "CASHIER_DIRECT"
    : "ANY_AUTHORIZED_USER";
}

// Load a branch's approval settings, creating a workflow-appropriate default
// row the first time (so branches made before this feature still work).
export async function getApprovalSettings(
  cafeId: string,
  branchId: string
): Promise<ApprovalSettings> {
  const existing = await db.qrOrderApprovalSettings.findUnique({ where: { branchId } });
  if (existing) return existing;
  const cafe = await getCafeSettings(cafeId);
  return db.qrOrderApprovalSettings.create({
    data: { cafeId, branchId, approvalMode: defaultMode(cafe.workflowMode) },
  });
}

// Resolve how a new QR order should be routed given the branch settings and
// the cafe feature flags. Returns the OrderStatus + approval fields to set.
export type RoutingResult = {
  orderStatus: "PENDING_WAITER_APPROVAL" | "CONFIRMED";
  approvalStatus: "NOT_REQUIRED" | "PENDING_APPROVAL";
  approvalModeSnapshot: QrApprovalMode;
  assignedApproverRole: Role | null;
  assignedApproverUserId: string | null;
};

export function resolveRouting(
  settings: ApprovalSettings,
  flags: { waiterApprovalEnabled: boolean; kitchenScreenEnabled: boolean }
): RoutingResult {
  // Disabled routing → legacy behaviour (require any-authorized approval).
  let mode = settings.enabled ? settings.approvalMode : "ANY_AUTHORIZED_USER";

  // Feature-flag guards: a locked mode degrades gracefully.
  if (mode === "WAITER_APPROVAL" && !flags.waiterApprovalEnabled) mode = "ANY_AUTHORIZED_USER";
  if (mode === "KITCHEN_DIRECT" && !flags.kitchenScreenEnabled) mode = "CASHIER_DIRECT";

  const direct = (): RoutingResult => ({
    orderStatus: "CONFIRMED", approvalStatus: "NOT_REQUIRED",
    approvalModeSnapshot: mode, assignedApproverRole: null, assignedApproverUserId: null,
  });
  const pending = (role: Role | null, userId: string | null): RoutingResult => ({
    orderStatus: "PENDING_WAITER_APPROVAL", approvalStatus: "PENDING_APPROVAL",
    approvalModeSnapshot: mode, assignedApproverRole: role, assignedApproverUserId: userId,
  });

  switch (mode) {
    case "AUTO_CONFIRM":
    case "KITCHEN_DIRECT":
      return direct();
    case "WAITER_APPROVAL":
      return pending("WAITER", null);
    case "MANAGER_APPROVAL":
      return pending("BRANCH_MANAGER", null);
    case "CASHIER_DIRECT":
      return pending("CASHIER", null);
    case "ROLE_BASED":
      return pending(settings.targetRole ?? null, null);
    case "SPECIFIC_USER":
      return pending(null, settings.targetUserId ?? null);
    case "ANY_AUTHORIZED_USER":
    default:
      return pending(null, null);
  }
}

// Can the acting user approve/reject THIS pending order? Owners and the
// order's branch manager always may (scope override); otherwise the caller
// must hold qr_orders.approve AND match the order's assignment.
export function canApproveOrder(
  session: SessionUser,
  order: { assignedApproverRole: Role | null; assignedApproverUserId: string | null; branchId: string; cafeId: string },
  hasApproveKey: boolean
): boolean {
  if (session.role === "SUPER_ADMIN") return true;
  if (order.cafeId !== session.cafeId) return false;
  if (session.branchId && order.branchId !== session.branchId) return false;

  // Owner / branch-manager override (within their scope).
  if (session.role === "CAFE_OWNER" || session.role === "BRANCH_MANAGER") return true;

  if (!hasApproveKey) return false;

  // Specific-user assignment: only that user.
  if (order.assignedApproverUserId) return order.assignedApproverUserId === session.id;
  // Role assignment: only that role.
  if (order.assignedApproverRole) return order.assignedApproverRole === session.role;
  // Any-authorized: anyone holding the approve key.
  return true;
}

// Build the Prisma `where` clause for the pending-approval queue a user may
// act on. Mirrors canApproveOrder for list filtering.
export function approvalQueueWhere(session: SessionUser, hasApproveKey: boolean) {
  const base = {
    cafeId: session.cafeId ?? undefined,
    status: "PENDING_WAITER_APPROVAL" as const,
    ...(session.branchId ? { branchId: session.branchId } : {}),
  };
  // Owner / branch manager see the whole (scoped) queue.
  if (session.role === "CAFE_OWNER" || session.role === "BRANCH_MANAGER" || session.role === "SUPER_ADMIN") {
    return base;
  }
  if (!hasApproveKey) return { ...base, id: "__none__" }; // matches nothing
  // Others: assigned to me, my role, or unassigned (any-authorized) — plus
  // legacy orders with no assignment stored.
  return {
    ...base,
    OR: [
      { assignedApproverUserId: session.id },
      { assignedApproverRole: session.role },
      { assignedApproverUserId: null, assignedApproverRole: null },
    ],
  };
}
