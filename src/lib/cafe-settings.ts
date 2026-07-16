import { db } from "@/lib/db";
import type { CafeSettings, CafeWorkflowMode, QrOrderRoutingMode } from "@prisma/client";

// ── Feature flags catalog ────────────────────────────────────────────
// The boolean columns on CafeSettings that gate a module. Order here is
// the display order in the super-admin panel.
export const FEATURE_FLAGS = [
  "aiAssistantEnabled",
  "qrMenuEnabled",
  "waiterApprovalEnabled",
  "kitchenScreenEnabled",
  "inventoryEnabled",
  "shiftManagementEnabled",
  "advancedReportsEnabled",
  "excelImportEnabled",
  "recipeCostingEnabled",
  "staffManagementEnabled",
  "branchManagementEnabled",
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export const FEATURE_LABELS: Record<FeatureFlag, string> = {
  aiAssistantEnabled: "تفعيل المساعد الذكي",
  qrMenuEnabled: "تفعيل منيو QR",
  waiterApprovalEnabled: "تفعيل موافقة الويتر",
  kitchenScreenEnabled: "تفعيل شاشة البار",
  inventoryEnabled: "تفعيل المخزون",
  shiftManagementEnabled: "تفعيل الشيفتات",
  advancedReportsEnabled: "تفعيل التقارير المتقدمة",
  excelImportEnabled: "تفعيل استيراد Excel",
  recipeCostingEnabled: "تفعيل تكلفة الوصفات",
  staffManagementEnabled: "تفعيل إدارة الموظفين",
  branchManagementEnabled: "تفعيل إدارة الفروع",
};

// Extra workflow switches (checkboxes).
export const WORKFLOW_SWITCHES = [
  "requireShiftForQrOrders",
  "allowCashierToPrepareOrders",
  "allowCashierToServeOrders",
  "enableTables",
] as const;

export type WorkflowSwitch = (typeof WORKFLOW_SWITCHES)[number];

export const SWITCH_LABELS: Record<WorkflowSwitch, string> = {
  requireShiftForQrOrders: "إلزام الشيفت قبل الدفع",
  allowCashierToPrepareOrders: "السماح للكاشير بتحضير الطلبات",
  allowCashierToServeOrders: "السماح للكاشير بتسليم الطلبات",
  enableTables: "تفعيل الترابيزات",
};

export const WORKFLOW_MODE_LABELS: Record<CafeWorkflowMode, string> = {
  FULL_SERVICE: "كافيه كامل",
  SMALL_CAFE: "كافيه صغير",
  TAKEAWAY_ONLY: "تيك أواي فقط",
  RESTAURANT: "مطعم",
};

export const QR_ROUTING_LABELS: Record<QrOrderRoutingMode, string> = {
  WAITER_APPROVAL: "موافقة الويتر",
  CASHIER_DIRECT: "الكاشير مباشرة",
  KITCHEN_DIRECT: "البار مباشرة",
  AUTO_CONFIRMED: "تأكيد تلقائي",
};

export const FEATURE_DISABLED_MESSAGE = "هذه الميزة غير مفعلة لهذا الكافيه";

// The public boolean map the client/sidebar uses (no timestamps/ids).
export type CafeFeatures = Record<FeatureFlag, boolean> &
  Record<WorkflowSwitch, boolean> & {
    workflowMode: CafeWorkflowMode;
    qrOrderRoutingMode: QrOrderRoutingMode;
  };

export function toFeatureMap(s: CafeSettings): CafeFeatures {
  return {
    aiAssistantEnabled: s.aiAssistantEnabled,
    qrMenuEnabled: s.qrMenuEnabled,
    waiterApprovalEnabled: s.waiterApprovalEnabled,
    kitchenScreenEnabled: s.kitchenScreenEnabled,
    inventoryEnabled: s.inventoryEnabled,
    shiftManagementEnabled: s.shiftManagementEnabled,
    advancedReportsEnabled: s.advancedReportsEnabled,
    excelImportEnabled: s.excelImportEnabled,
    recipeCostingEnabled: s.recipeCostingEnabled,
    staffManagementEnabled: s.staffManagementEnabled,
    branchManagementEnabled: s.branchManagementEnabled,
    requireShiftForQrOrders: s.requireShiftForQrOrders,
    allowCashierToPrepareOrders: s.allowCashierToPrepareOrders,
    allowCashierToServeOrders: s.allowCashierToServeOrders,
    enableTables: s.enableTables,
    workflowMode: s.workflowMode,
    qrOrderRoutingMode: s.qrOrderRoutingMode,
  };
}

// Returns the cafe's settings, lazily creating a defaults row the first
// time (so cafes made before this feature still work).
export async function getCafeSettings(cafeId: string): Promise<CafeSettings> {
  const existing = await db.cafeSettings.findUnique({ where: { cafeId } });
  if (existing) return existing;
  return db.cafeSettings.create({ data: { cafeId } });
}

export async function getCafeFeatures(cafeId: string): Promise<CafeFeatures> {
  return toFeatureMap(await getCafeSettings(cafeId));
}
