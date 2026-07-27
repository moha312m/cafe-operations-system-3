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
    select: { code: true },
  });
  const have = new Set(existing.map((r) => r.code));
  const missing = SYSTEM_ROLES.filter((r) => !have.has(r.code));
  if (missing.length === 0) return;

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
