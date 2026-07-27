import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { resolvePermissions } from "@/lib/perms/effective";
import { CAFE_KEYS } from "@/lib/perms/catalog";
import { modulesForKeys } from "@/lib/perms/roles";

type Params = { params: Promise<{ id: string }> };

// Load a role scoped to the acting user's cafe (tenant isolation).
async function loadOwnRole(cafeId: string, id: string) {
  const role = await db.cafeRole.findFirst({
    where: { id, cafeId },
    include: { permissions: { select: { permissionKey: true, allowed: true } }, _count: { select: { users: true } } },
  });
  if (!role) throw new ApiError(404, "الدور غير موجود");
  return role;
}

// GET /api/roles/[id] — one role with its full permission set.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("users.manage_permissions");
    if (!session.cafeId) throw new ApiError(400, "الحساب مش مرتبط بكافيه");
    const { id } = await params;
    const role = await loadOwnRole(session.cafeId, id);
    const keys = role.permissions.filter((p) => p.allowed).map((p) => p.permissionKey);
    return NextResponse.json({
      role: {
        id: role.id,
        name: role.name,
        code: role.code,
        description: role.description,
        isSystemDefault: role.isSystemDefault,
        isActive: role.isActive,
        userCount: role._count.users,
        permissionKeys: keys,
        modules: modulesForKeys(keys),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().max(300).nullable().optional(),
  isActive: z.boolean().optional(),
  permissionKeys: z.array(z.string()).optional(),
});

// PATCH /api/roles/[id] — edit name/description/active state and/or replace
// the permission set. Enforces no-escalation (can't grant keys you lack).
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("users.manage_permissions");
    if (!session.cafeId) throw new ApiError(400, "الحساب مش مرتبط بكافيه");
    const { id } = await params;
    const role = await loadOwnRole(session.cafeId, id);
    const data = patchSchema.parse(await request.json());

    const meta: Record<string, unknown> = {};
    if (data.name !== undefined) meta.name = data.name.trim();
    if (data.description !== undefined) meta.description = data.description?.trim() || null;

    // Deactivating vs reactivating.
    if (data.isActive !== undefined && data.isActive !== role.isActive) {
      meta.isActive = data.isActive;
    }

    await db.$transaction(async (tx) => {
      if (Object.keys(meta).length > 0) {
        await tx.cafeRole.update({ where: { id }, data: meta });
      }

      if (data.permissionKeys) {
        const requested = [...new Set(data.permissionKeys)].filter((k) => CAFE_KEYS.includes(k));
        const { keys: myKeys } = await resolvePermissions(session);
        const notAllowed = requested.filter((k) => !myKeys.has(k));
        if (notAllowed.length > 0) {
          throw new ApiError(403, "لا يمكنك منح صلاحيات لا تملكها بنفسك");
        }
        // Replace the whole permission set.
        await tx.cafeRolePermission.deleteMany({ where: { cafeRoleId: id } });
        if (requested.length > 0) {
          await tx.cafeRolePermission.createMany({
            data: requested.map((permissionKey) => ({ cafeRoleId: id, permissionKey, allowed: true })),
          });
        }
      }
    });

    // Audit: role updated + activation state changes.
    const base = { cafeId: session.cafeId, userId: session.id, entity: "CafeRole", entityId: id };
    await audit({
      ...base,
      action: "CAFE_ROLE_UPDATED",
      details: { roleId: id, name: (meta.name as string) ?? role.name, permissionKeys: data.permissionKeys },
    });
    if (data.isActive === false && role.isActive) {
      await audit({ ...base, action: "CAFE_ROLE_DEACTIVATED", details: { roleId: id } });
    } else if (data.isActive === true && !role.isActive) {
      await audit({ ...base, action: "CAFE_ROLE_REACTIVATED", details: { roleId: id } });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}

// DELETE /api/roles/[id] — archive (soft) if the role has assigned users or
// is a system default; otherwise hard-delete a custom, unused role.
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("users.manage_permissions");
    if (!session.cafeId) throw new ApiError(400, "الحساب مش مرتبط بكافيه");
    const { id } = await params;
    const role = await loadOwnRole(session.cafeId, id);

    const base = { cafeId: session.cafeId, userId: session.id, entity: "CafeRole", entityId: id };

    if (role._count.users > 0 || role.isSystemDefault) {
      // Never orphan assigned users or destroy a system default — archive.
      await db.cafeRole.update({
        where: { id },
        data: { isActive: false, archivedAt: new Date() },
      });
      await audit({ ...base, action: "CAFE_ROLE_ARCHIVED", details: { roleId: id, reason: "has_users_or_system" } });
      return NextResponse.json({ ok: true, archived: true });
    }

    await db.cafeRole.delete({ where: { id } });
    await audit({ ...base, action: "CAFE_ROLE_ARCHIVED", details: { roleId: id, deleted: true } });
    return NextResponse.json({ ok: true, deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
