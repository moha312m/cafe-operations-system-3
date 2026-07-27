// ── Cafe permission catalog ──────────────────────────────────────────
// The canonical list of permission KEYS (module.action) used by custom
// cafe roles, per-user overrides, route guards, and the roles UI.
//
// A key is enforced server-side by resolving the acting user's effective
// key set (role permissions ± overrides, gated by cafe feature flags) and
// checking membership. See src/lib/perms/effective.ts.

import type { FeatureFlag, WorkflowSwitch } from "@/lib/cafe-settings";

// Modules gate on a Super-Admin feature flag or a workflow switch column.
type GateFlag = FeatureFlag | WorkflowSwitch;

export type ModuleCode =
  | "DASHBOARD" | "TABLES" | "POS" | "KITCHEN" | "SALES" | "ORDERS"
  | "QR_ORDERS" | "MENU" | "INVENTORY" | "PURCHASES" | "EXPENSES"
  | "SHIFTS" | "FINANCE" | "USERS" | "EDIT_CENTER" | "AUDIT"
  | "SETTINGS" | "CUSTOMER_ORDERS" | "EXCEL" | "HANDOVER" | "REPORTS"
  | "AI_ASSISTANT" | "BRANCHES";

export type PermModule = {
  code: ModuleCode;
  label: string; // Arabic
  icon: string;
  // When set, every key in this module is locked off if the cafe has the
  // feature flag disabled (Super-Admin controlled).
  feature?: GateFlag;
};

export type PermKey = {
  key: string; // "module.action"
  module: ModuleCode;
  label: string; // Arabic
  sensitive?: boolean; // shown with a "صلاحية حساسة" warning badge
};

// Display + feature-flag gating per module.
export const MODULES: PermModule[] = [
  { code: "DASHBOARD", label: "لوحة التحكم", icon: "📊" },
  { code: "POS", label: "الكاشير", icon: "🧾" },
  { code: "ORDERS", label: "الطلبات", icon: "🔔" },
  { code: "QR_ORDERS", label: "طلبات المنيو", icon: "📱", feature: "qrMenuEnabled" },
  { code: "KITCHEN", label: "شاشة البار", icon: "☕", feature: "kitchenScreenEnabled" },
  { code: "TABLES", label: "الترابيزات", icon: "🍽️", feature: "enableTables" },
  { code: "MENU", label: "المنيو والمنتجات", icon: "📖" },
  { code: "INVENTORY", label: "المخزون", icon: "📦", feature: "inventoryEnabled" },
  { code: "PURCHASES", label: "المشتريات", icon: "🛒", feature: "inventoryEnabled" },
  { code: "EXPENSES", label: "المصاريف", icon: "💸" },
  { code: "SHIFTS", label: "الشيفتات", icon: "🕒", feature: "shiftManagementEnabled" },
  { code: "FINANCE", label: "المالية", icon: "💰" },
  { code: "SALES", label: "المبيعات", icon: "📈" },
  { code: "REPORTS", label: "التقارير", icon: "🧮" },
  { code: "USERS", label: "المستخدمين", icon: "👥", feature: "staffManagementEnabled" },
  { code: "SETTINGS", label: "الإعدادات", icon: "⚙️" },
  { code: "AUDIT", label: "سجل الحركات", icon: "📜" },
  { code: "EDIT_CENTER", label: "مركز التعديلات", icon: "✏️" },
  { code: "CUSTOMER_ORDERS", label: "طلبات العملاء", icon: "🧑‍🍳", feature: "qrMenuEnabled" },
  { code: "EXCEL", label: "استيراد Excel", icon: "📄", feature: "excelImportEnabled" },
  { code: "HANDOVER", label: "التسليم والاستلام", icon: "🤝" },
  { code: "AI_ASSISTANT", label: "المساعد الذكي", icon: "🤖", feature: "aiAssistantEnabled" },
  { code: "BRANCHES", label: "الفروع", icon: "🏬", feature: "branchManagementEnabled" },
];

export const MODULE_MAP: Record<ModuleCode, PermModule> = Object.fromEntries(
  MODULES.map((m) => [m.code, m])
) as Record<ModuleCode, PermModule>;

// The full key catalog. `sensitive` marks operations that grant money,
// access, or the ability to grant access to others.
export const PERMISSION_KEYS: PermKey[] = [
  // Dashboard
  { key: "dashboard.view", module: "DASHBOARD", label: "عرض لوحة التحكم" },

  // POS / cashier
  { key: "pos.view", module: "POS", label: "فتح الكاشير" },
  { key: "pos.create_order", module: "POS", label: "إنشاء طلب" },
  { key: "pos.apply_discount", module: "POS", label: "تطبيق خصم", sensitive: true },
  { key: "pos.collect_payment", module: "POS", label: "تحصيل الدفع", sensitive: true },
  { key: "pos.view_payments", module: "POS", label: "عرض المدفوعات" },

  // Orders
  { key: "orders.view", module: "ORDERS", label: "عرض الطلبات" },
  { key: "orders.update_status", module: "ORDERS", label: "تحديث حالة الطلب" },
  { key: "orders.cancel", module: "ORDERS", label: "إلغاء الطلب", sensitive: true },
  { key: "orders.refund", module: "ORDERS", label: "استرجاع مبلغ", sensitive: true },

  // QR / customer orders
  { key: "qr_orders.view", module: "QR_ORDERS", label: "عرض طلبات المنيو" },
  { key: "qr_orders.approve", module: "QR_ORDERS", label: "موافقة/رفض طلبات المنيو" },

  // Kitchen / bar
  { key: "kitchen.view", module: "KITCHEN", label: "شاشة البار" },
  { key: "kitchen.update_status", module: "KITCHEN", label: "تحديث حالة التحضير" },

  // Menu / products
  { key: "menu.view", module: "MENU", label: "عرض المنيو" },
  { key: "menu.create", module: "MENU", label: "إضافة منتج" },
  { key: "menu.edit", module: "MENU", label: "تعديل المنتجات" },
  { key: "menu.delete", module: "MENU", label: "حذف المنتجات", sensitive: true },
  { key: "menu.edit_prices", module: "MENU", label: "تعديل الأسعار", sensitive: true },
  { key: "menu.import_excel", module: "MENU", label: "استيراد Excel" },
  { key: "menu.manage_recipes", module: "MENU", label: "إدارة الوصفات" },

  // Inventory
  { key: "inventory.view", module: "INVENTORY", label: "عرض المخزون" },
  { key: "inventory.edit", module: "INVENTORY", label: "تعديل الأصناف" },
  { key: "inventory.transactions", module: "INVENTORY", label: "حركات المخزون", sensitive: true },

  // Purchases
  { key: "purchases.view", module: "PURCHASES", label: "عرض المشتريات" },
  { key: "purchases.manage", module: "PURCHASES", label: "إدارة المشتريات" },

  // Expenses
  { key: "expenses.view", module: "EXPENSES", label: "عرض المصاريف" },
  { key: "expenses.manage", module: "EXPENSES", label: "إدارة المصاريف", sensitive: true },

  // Shifts
  { key: "shifts.view_current", module: "SHIFTS", label: "عرض الشيفت الحالي" },
  { key: "shifts.open", module: "SHIFTS", label: "فتح شيفت" },
  { key: "shifts.close", module: "SHIFTS", label: "قفل شيفت" },
  { key: "shifts.view_reports", module: "SHIFTS", label: "تقارير الشيفتات" },
  { key: "shifts.close_others", module: "SHIFTS", label: "قفل شيفت موظف آخر", sensitive: true },

  // Finance
  { key: "finance.view_revenue", module: "FINANCE", label: "عرض الإيرادات" },
  { key: "finance.view_profit", module: "FINANCE", label: "عرض الأرباح", sensitive: true },

  // Sales
  { key: "sales.view", module: "SALES", label: "عرض المبيعات" },

  // Reports
  { key: "reports.view", module: "REPORTS", label: "عرض التقارير" },
  { key: "reports.export", module: "REPORTS", label: "تصدير التقارير", sensitive: true },

  // Users / staff
  { key: "users.view", module: "USERS", label: "عرض الموظفين" },
  { key: "users.create", module: "USERS", label: "إضافة موظف" },
  { key: "users.edit", module: "USERS", label: "تعديل الموظف" },
  { key: "users.reset_password", module: "USERS", label: "تغيير كلمة المرور", sensitive: true },
  { key: "users.deactivate", module: "USERS", label: "إيقاف/تفعيل الحساب", sensitive: true },
  { key: "users.manage_permissions", module: "USERS", label: "إدارة الأدوار والصلاحيات", sensitive: true },

  // Settings
  { key: "settings.view", module: "SETTINGS", label: "عرض الإعدادات" },
  { key: "settings.edit", module: "SETTINGS", label: "تعديل الإعدادات (الضريبة/السيرفيس)", sensitive: true },

  // Branches
  { key: "branches.view", module: "BRANCHES", label: "عرض الفروع" },
  { key: "branches.manage", module: "BRANCHES", label: "إدارة الفروع", sensitive: true },

  // Audit
  { key: "audit.view", module: "AUDIT", label: "عرض سجل الحركات" },

  // Excel
  { key: "excel.import", module: "EXCEL", label: "استيراد ملفات Excel" },
  { key: "excel.export", module: "EXCEL", label: "تصدير ملفات Excel" },

  // Handover
  { key: "handover.view", module: "HANDOVER", label: "عرض التسليم" },
  { key: "handover.manage", module: "HANDOVER", label: "تسليم واستلام" },

  // Tables
  { key: "tables.view", module: "TABLES", label: "عرض الترابيزات" },
  { key: "tables.manage", module: "TABLES", label: "إدارة الترابيزات", sensitive: true },
  { key: "tables.open", module: "TABLES", label: "فتح ترابيزة (أول طلب)" },
  { key: "tables.close", module: "TABLES", label: "قفل الترابيزة" },
  { key: "tables.collect_payment", module: "TABLES", label: "تحصيل حساب الترابيزة", sensitive: true },
  { key: "tables.partial_payment", module: "TABLES", label: "تحصيل جزئي" },
  { key: "tables.item_payment", module: "TABLES", label: "تحصيل أصناف محددة" },
  { key: "tables.transfer", module: "TABLES", label: "نقل الترابيزة" },
  { key: "tables.merge", module: "TABLES", label: "دمج الترابيزات" },

  // AI assistant
  { key: "ai.use", module: "AI_ASSISTANT", label: "استخدام المساعد الذكي" },

  // Platform (super admin only — never granted inside a cafe role)
  { key: "platform.manage", module: "SETTINGS", label: "إدارة المنصة", sensitive: true },
];

export const ALL_KEYS = PERMISSION_KEYS.map((p) => p.key);
export const KEY_MAP: Record<string, PermKey> = Object.fromEntries(
  PERMISSION_KEYS.map((p) => [p.key, p])
);

// Every cafe-scoped key (everything a cafe owner may hold — excludes the
// platform key that only Super Admins ever have).
export const CAFE_KEYS = PERMISSION_KEYS
  .filter((p) => p.key !== "platform.manage")
  .map((p) => p.key);

export const SENSITIVE_KEYS = new Set(
  PERMISSION_KEYS.filter((p) => p.sensitive).map((p) => p.key)
);

export function keysForModule(code: ModuleCode): PermKey[] {
  return PERMISSION_KEYS.filter((p) => p.module === code);
}

// ── Legacy ↔ new bridge ──────────────────────────────────────────────
// Existing route guards call requirePermission("menu:manage" | ...). Each
// legacy permission maps to one-or-more new keys; the FIRST is the primary
// key that requirePermission() checks. deriveKeysFromLegacyRole() also uses
// the full list so a role's default key set matches its legacy grants
// exactly (no behavioural change for users without a custom role).
export const LEGACY_TO_KEYS: Record<string, string[]> = {
  "platform:manage": ["platform.manage"],
  "cafe:manage": ["settings.view", "settings.edit"],
  "branches:manage": ["branches.view", "branches.manage", "tables.manage", "tables.transfer", "tables.merge"],
  "users:manage": [
    "users.view", "users.create", "users.edit",
    "users.reset_password", "users.deactivate", "users.manage_permissions",
  ],
  "menu:manage": [
    "menu.view", "menu.create", "menu.edit", "menu.delete",
    "menu.edit_prices", "menu.import_excel", "excel.import",
  ],
  "menu:read": ["menu.view"],
  "orders:create": ["pos.view", "pos.create_order", "pos.collect_payment", "pos.view_payments", "tables.view", "tables.open", "pos.apply_discount"],
  "orders:read": ["orders.view"],
  "orders:update-status": ["orders.update_status", "kitchen.view", "kitchen.update_status"],
  "orders:cancel": ["orders.cancel", "orders.refund"],
  "orders:approve": ["qr_orders.view", "qr_orders.approve"],
  "payments:create": [
    "pos.collect_payment",
    "tables.collect_payment", "tables.partial_payment", "tables.item_payment", "tables.close",
  ],
  "payments:read": ["pos.view_payments"],
  "shifts:operate": ["shifts.view_current", "shifts.open", "shifts.close"],
  "shifts:read": ["shifts.view_reports"],
  "dashboard:read": ["dashboard.view"],
  "reports:read": ["reports.view", "sales.view", "reports.export", "excel.export"],
  "inventory:manage": ["inventory.view", "inventory.edit", "inventory.transactions", "purchases.view", "purchases.manage", "handover.view", "handover.manage"],
  "inventory:read": ["inventory.view"],
  "recipe:manage": ["menu.manage_recipes"],
  "cost:read": ["finance.view_revenue", "finance.view_profit", "sales.view"],
  "audit:read": ["audit.view"],
};

// Primary key a legacy permission maps to (used by requirePermission).
export function primaryKey(legacy: string): string | null {
  return LEGACY_TO_KEYS[legacy]?.[0] ?? null;
}
