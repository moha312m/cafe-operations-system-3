import type { Role } from "@prisma/client";

// Central permission catalog. API routes and UI both check against these,
// so adding a capability means adding it here once.
export const PERMISSIONS = [
  "platform:manage", // create/suspend cafes (super admin only)
  "cafe:manage", // cafe settings, tax rate, currency
  "branches:manage",
  "users:manage",
  "menu:manage", // categories, products, variants, add-ons
  "menu:read",
  "orders:create",
  "orders:read",
  "orders:update-status",
  "orders:cancel",
  "orders:approve", // approve/reject QR menu orders
  "payments:create",
  "payments:read",
  "shifts:operate", // open/close own shift, take POS orders under it
  "shifts:read", // view shift reports across the branch/cafe
  "dashboard:read",
  "reports:read",
  "inventory:manage",
  "inventory:read",
  "recipe:manage", // define product recipes (uses inventory)
  "cost:read", // view product cost / profit / margin
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS] as Permission[];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  // Platform operator. Cross-tenant: may act on any cafe.
  SUPER_ADMIN: ALL,

  // Everything inside their own cafe except platform administration.
  CAFE_OWNER: ALL.filter((p) => p !== "platform:manage"),

  // Runs one branch: staff, day-to-day orders, reports, stock, and
  // (per owner policy) menu & pricing.
  BRANCH_MANAGER: [
    "branches:manage",
    "users:manage",
    "menu:manage",
    "menu:read",
    "orders:create",
    "orders:read",
    "orders:update-status",
    "orders:cancel",
    "orders:approve",
    "payments:create",
    "payments:read",
    "shifts:operate",
    "shifts:read",
    "dashboard:read",
    "reports:read",
    "inventory:manage",
    "inventory:read",
    "recipe:manage",
    "cost:read",
    "audit:read",
  ],

  // Takes orders at the table and reviews QR menu orders.
  WAITER: [
    "menu:read",
    "orders:create",
    "orders:read",
    "orders:update-status",
    "orders:approve",
    "payments:create",
    "payments:read",
  ],

  // POS operator. Note: cannot approve QR orders.
  CASHIER: [
    "menu:read",
    "orders:create",
    "orders:read",
    "orders:update-status",
    "payments:create",
    "payments:read",
    "shifts:operate",
  ],

  // Kitchen / barista display: sees the queue, advances statuses.
  BARISTA: ["menu:read", "orders:read", "orders:update-status"],

  INVENTORY_MANAGER: [
    "menu:read",
    "inventory:manage",
    "inventory:read",
    "recipe:manage",
    "cost:read",
  ],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  // Optional chaining guards against stale JWTs carrying renamed roles.
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

// Roles a given role is allowed to create/manage. Prevents privilege
// escalation (e.g. a branch manager creating an owner account).
export const MANAGEABLE_ROLES: Record<Role, Role[]> = {
  SUPER_ADMIN: [
    "SUPER_ADMIN",
    "CAFE_OWNER",
    "BRANCH_MANAGER",
    "WAITER",
    "CASHIER",
    "BARISTA",
    "INVENTORY_MANAGER",
  ],
  CAFE_OWNER: ["BRANCH_MANAGER", "WAITER", "CASHIER", "BARISTA", "INVENTORY_MANAGER"],
  BRANCH_MANAGER: ["WAITER", "CASHIER", "BARISTA", "INVENTORY_MANAGER"],
  WAITER: [],
  CASHIER: [],
  BARISTA: [],
  INVENTORY_MANAGER: [],
};

// Display names live in the i18n constants (src/lib/i18n.ts).
import { t } from "@/lib/i18n";

export const ROLE_LABELS: Record<Role, string> = t.roles;
