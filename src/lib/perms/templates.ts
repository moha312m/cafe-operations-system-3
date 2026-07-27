// ── System role templates ────────────────────────────────────────────
// The default cafe roles seeded per cafe. `code` is stable & used to map a
// user's legacy Role enum onto a default key set when they have no custom
// CafeRole assigned. Owners may duplicate/edit these into custom roles.

import type { Role } from "@prisma/client";
import { CAFE_KEYS, LEGACY_TO_KEYS } from "./catalog";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

export type SystemRoleCode =
  | "OWNER" | "MANAGER" | "CASHIER" | "WAITER" | "BARISTA" | "ACCOUNTANT" | "INVENTORY";

export type SystemRole = {
  code: SystemRoleCode;
  name: string; // Arabic
  description: string;
  keys: string[]; // "*" via CAFE_KEYS for the owner
};

const MANAGER_KEYS = [
  "dashboard.view",
  "pos.view", "pos.create_order", "pos.apply_discount", "pos.collect_payment", "pos.view_payments",
  "orders.view", "orders.update_status", "orders.cancel",
  "qr_orders.view", "qr_orders.approve",
  "kitchen.view", "kitchen.update_status",
  "tables.view", "tables.manage", "tables.open", "tables.close",
  "tables.collect_payment", "tables.partial_payment", "tables.item_payment",
  "tables.transfer", "tables.merge",
  "menu.view", "menu.create", "menu.edit", "menu.edit_prices", "menu.import_excel", "menu.manage_recipes",
  "inventory.view", "inventory.edit", "inventory.transactions",
  "purchases.view", "purchases.manage",
  "expenses.view", "expenses.manage",
  "shifts.view_current", "shifts.open", "shifts.close", "shifts.view_reports",
  "finance.view_revenue", "finance.view_profit",
  "sales.view", "reports.view", "reports.export",
  "users.view", "users.create", "users.edit",
  "settings.view",
  "audit.view",
  "excel.import", "excel.export",
  "handover.view", "handover.manage",
];

const CASHIER_KEYS = [
  "pos.view", "pos.create_order", "pos.collect_payment", "pos.view_payments",
  "orders.view", "orders.update_status",
  "tables.view", "tables.open", "tables.close",
  "tables.collect_payment", "tables.partial_payment", "tables.item_payment",
  "menu.view",
  "shifts.view_current", "shifts.open", "shifts.close",
];

const WAITER_KEYS = [
  "pos.view", "pos.create_order",
  "orders.view", "orders.update_status",
  "qr_orders.view", "qr_orders.approve",
  "tables.view", "tables.open",
  "menu.view",
];

const BARISTA_KEYS = [
  "kitchen.view", "kitchen.update_status",
  "orders.view",
  "menu.view",
];

const ACCOUNTANT_KEYS = [
  "dashboard.view",
  "sales.view",
  "reports.view", "reports.export",
  "finance.view_revenue", "finance.view_profit",
  "expenses.view", "expenses.manage",
  "shifts.view_reports",
  "orders.view", "pos.view_payments",
  "audit.view",
  "excel.export",
];

const INVENTORY_KEYS = [
  "menu.view",
  "inventory.view", "inventory.edit", "inventory.transactions",
  "purchases.view", "purchases.manage",
  "handover.view", "handover.manage",
];

export const SYSTEM_ROLES: SystemRole[] = [
  { code: "OWNER", name: "مالك", description: "صلاحية كاملة على الكافيه", keys: CAFE_KEYS },
  { code: "MANAGER", name: "مدير", description: "إدارة الفرع والعمليات اليومية", keys: MANAGER_KEYS },
  { code: "CASHIER", name: "كاشير", description: "الكاشير وتحصيل المدفوعات وإدارة الشيفت", keys: CASHIER_KEYS },
  { code: "WAITER", name: "ويتر", description: "طلبات الصالة وموافقة طلبات المنيو", keys: WAITER_KEYS },
  { code: "BARISTA", name: "بارستا", description: "شاشة البار وتحديث حالة التحضير", keys: BARISTA_KEYS },
  { code: "ACCOUNTANT", name: "محاسب", description: "المبيعات والتقارير والمالية", keys: ACCOUNTANT_KEYS },
  { code: "INVENTORY", name: "مسؤول مخزون", description: "المخزون والمشتريات والتسليم", keys: INVENTORY_KEYS },
];

export const SYSTEM_ROLE_MAP: Record<SystemRoleCode, SystemRole> = Object.fromEntries(
  SYSTEM_ROLES.map((r) => [r.code, r])
) as Record<SystemRoleCode, SystemRole>;

// Maps the legacy User.role enum to a system-role template code. Used to
// give users a sensible default key set when they have no custom CafeRole.
export const ROLE_TO_SYSTEM: Record<Role, SystemRoleCode | "SUPER"> = {
  SUPER_ADMIN: "SUPER",
  CAFE_OWNER: "OWNER",
  BRANCH_MANAGER: "MANAGER",
  CASHIER: "CASHIER",
  WAITER: "WAITER",
  BARISTA: "BARISTA",
  INVENTORY_MANAGER: "INVENTORY",
};

// Default key set for a legacy role when the user has NO custom CafeRole.
// Derived directly from the legacy role→permission grants (via LEGACY_TO_KEYS)
// so behaviour is byte-for-byte identical to the pre-roles system — assigning
// a custom role is the only thing that changes a user's access.
export function defaultKeysForRole(role: Role): string[] {
  if (role === "SUPER_ADMIN") return [...CAFE_KEYS, "platform.manage"];
  const keys = new Set<string>();
  for (const legacy of ROLE_PERMISSIONS[role] ?? []) {
    for (const k of LEGACY_TO_KEYS[legacy] ?? []) keys.add(k);
  }
  return [...keys];
}
