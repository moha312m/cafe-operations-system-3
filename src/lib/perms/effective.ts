// ── Effective permission resolver ────────────────────────────────────
// Final access = cafe feature flags ∩ (role permissions ± user overrides).
// Resolved server-side from the DB so role edits take effect immediately
// (no stale JWT). Used by both API guards and the server layout that seeds
// the client `can()`.

import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import { getCafeSettings } from "@/lib/cafe-settings";
import { CAFE_KEYS, MODULES, PERMISSION_KEYS } from "./catalog";
import { defaultKeysForRole } from "./templates";

export type EffectivePermissions = {
  keys: Set<string>;
  cafeRoleId: string | null;
};

// Which permission keys a disabled feature flag removes.
function featureBlockedKeys(settings: Record<string, unknown>): Set<string> {
  const disabledModules = new Set(
    MODULES.filter((m) => m.feature && settings[m.feature] === false).map((m) => m.code)
  );
  const blocked = new Set<string>();
  for (const p of PERMISSION_KEYS) {
    if (disabledModules.has(p.module)) blocked.add(p.key);
  }
  return blocked;
}

// Resolve the acting user's final permission-key set.
export async function resolvePermissions(
  session: SessionUser
): Promise<EffectivePermissions> {
  // Super admin operates cross-tenant with every capability.
  if (session.role === "SUPER_ADMIN") {
    return { keys: new Set([...CAFE_KEYS, "platform.manage"]), cafeRoleId: null };
  }

  const user = await db.user.findUnique({
    where: { id: session.id },
    select: {
      role: true,
      cafeRoleId: true,
      cafeRole: {
        select: {
          isActive: true,
          permissions: { select: { permissionKey: true, allowed: true } },
        },
      },
      permissionOverrides: { select: { permissionKey: true, allowed: true } },
    },
  });

  if (!user) return { keys: new Set(), cafeRoleId: null };

  // Base: an active custom role's granted keys, else the legacy-role default.
  let base: Set<string>;
  if (user.cafeRole && user.cafeRole.isActive) {
    base = new Set(
      user.cafeRole.permissions.filter((p) => p.allowed).map((p) => p.permissionKey)
    );
  } else {
    // No role (or a deactivated one) → fall back to the legacy role defaults.
    base = new Set(defaultKeysForRole(user.role));
  }

  // Per-user overrides win over the role.
  for (const o of user.permissionOverrides) {
    if (o.allowed) base.add(o.permissionKey);
    else base.delete(o.permissionKey);
  }

  // Feature-flag gate (Super-Admin controlled) — applies to everyone.
  if (session.cafeId) {
    const settings = await getCafeSettings(session.cafeId);
    const blocked = featureBlockedKeys(settings as unknown as Record<string, unknown>);
    for (const k of blocked) base.delete(k);
  }

  return { keys: base, cafeRoleId: user.cafeRoleId };
}

// Convenience: just the key set.
export async function resolvePermissionKeys(session: SessionUser): Promise<string[]> {
  return [...(await resolvePermissions(session)).keys];
}
