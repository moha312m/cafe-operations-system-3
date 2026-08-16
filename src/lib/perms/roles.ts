// ── Cafe role service ────────────────────────────────────────────────
import { db } from "@/lib/db";
import { SYSTEM_ROLES } from "./templates";
import { MODULES, KEY_MAP, type ModuleCode } from "./catalog";

// Idempotently seed the system-default roles for a cafe. Safe to call on
// demand (e.g. when the roles page first loads) so cafes created before this
// feature get their defaults without a data migration.
export async function ensureCafeRoles(cafeId: string): Promise<void> {
  const existing = await db.cafeRole.findMany({
    where: { cafeId },
    select: { id: true, code: true, isSystemDefault: true, permissions: { select: { permissionKey: true } } },
  });
  const have = new Set(existing.map((r) => r.code));
  const missing = SYSTEM_ROLES.filter((r) => !have.has(r.code));

  for (const tpl of missing) {
    await db.cafeRole.create({
      data: {
        cafeId,
        name: tpl.name,
        code: tpl.code,
        description: tpl.description,
        isSystemDefault: true,
        isActive: true,
        permissions: {
          create: tpl.keys.map((permissionKey) => ({ permissionKey, allowed: true })),
        },
      },
    });
  }

  // Catalog growth back-fill: when new permission keys join a system role's
  // template, existing cafes' system-default roles get them too. Only rows
  // the role has never seen are inserted — an explicit allowed=false set by
  // an admin is left untouched.
  for (const role of existing) {
    if (!role.isSystemDefault) continue;
    const tpl = SYSTEM_ROLES.find((r) => r.code === role.code);
    if (!tpl) continue;
    const known = new Set(role.permissions.map((p) => p.permissionKey));
    const toAdd = tpl.keys.filter((k) => !known.has(k));
    if (toAdd.length === 0) continue;
    await db.cafeRolePermission.createMany({
      data: toAdd.map((permissionKey) => ({ cafeRoleId: role.id, permissionKey, allowed: true })),
      skipDuplicates: true,
    });
  }
}

// Distinct module codes a key set touches (for role-row module badges).
export function modulesForKeys(keys: string[]): ModuleCode[] {
  const set = new Set<ModuleCode>();
  for (const k of keys) {
    const meta = KEY_MAP[k];
    if (meta) set.add(meta.module);
  }
  // Preserve catalog order.
  return MODULES.filter((m) => set.has(m.code)).map((m) => m.code);
}
