import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { MANAGEABLE_ROLES } from "@/lib/permissions";
import { resolvePermissions } from "@/lib/perms/effective";
import { defaultKeysForRole } from "@/lib/perms/templates";
import { CAFE_KEYS } from "@/lib/perms/catalog";

type Params = { params: Promise<{ id: string }> };
const NOT_ALLOWED = "ليس لديك صلاحية لتنفيذ هذا الإجراء";

// Guard shared by GET/PUT: only manageable staff in the acting user's cafe,
// never yourself.
async function loadTarget(session: Awaited<ReturnType<typeof requireKey>>, id: string) {
  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, name: true, role: true, cafeId: true, branchId: true, cafeRoleId: true },
  });
  if (!target) throw new ApiError(404, "الموظف غير موجود");
  if (session.role !== "SUPER_ADMIN" && target.cafeId !== session.cafeId) throw new ApiError(403, NOT_ALLOWED);
  if (id === session.id) throw new ApiError(403, "لا يمكنك تعديل صلاحياتك بنفسك");
  if (!MANAGEABLE_ROLES[session.role].includes(target.role)) throw new ApiError(403, NOT_ALLOWED);
  if (session.branchId && target.branchId !== session.branchId) throw new ApiError(403, NOT_ALLOWED);
  return target;
}

// GET /api/users/[id]/permissions — the target's role, overrides and the
// resulting effective key set (for the "صلاحيات مخصصة" editor).
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("users.manage_permissions");
    const { id } = await params;
    const target = await loadTarget(session, id);

    const [role, overrides] = await Promise.all([
      target.cafeRoleId
        ? db.cafeRole.findUnique({
            where: { id: target.cafeRoleId },
            include: { permissions: { where: { allowed: true }, select: { permissionKey: true } } },
          })
        : null,
      db.userPermissionOverride.findMany({
        where: { userId: id },
        select: { permissionKey: true, allowed: true },
      }),
    ]);

    const roleKeys = role
      ? role.permissions.map((p) => p.permissionKey)
      : defaultKeysForRole(target.role);

    return NextResponse.json({
      user: { id: target.id, name: target.name, role: target.role, cafeRoleId: target.cafeRoleId },
      roleName: role?.name ?? null,
      roleKeys,
      overrides,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const putSchema = z.object({
  // Optional role (re)assignment. null clears back to the legacy-role default.
  cafeRoleId: z.string().nullable().optional(),
  // Full replacement set of overrides.
  overrides: z.array(z.object({ key: z.string(), allowed: z.boolean() })).optional(),
});

// PUT /api/users/[id]/permissions — assign a role and/or replace the user's
// permission overrides.
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("users.manage_permissions");
    const { id } = await params;
    const target = await loadTarget(session, id);
    const data = putSchema.parse(await request.json());
    const { keys: myKeys } = await resolvePermissions(session);

    // ── Role assignment ──
    if (data.cafeRoleId !== undefined && data.cafeRoleId !== target.cafeRoleId) {
      if (data.cafeRoleId) {
        const role = await db.cafeRole.findFirst({
          where: { id: data.cafeRoleId, cafeId: target.cafeId ?? undefined },
          include: { permissions: { where: { allowed: true }, select: { permissionKey: true } } },
        });
        if (!role) throw new ApiError(400, "الدور غير موجود في هذا الكافيه");
        if (!role.isActive) throw new ApiError(400, "الدور موقوف — فعّله أولاً");
        // Can't assign a role that grants keys you don't hold yourself.
        const escalates = role.permissions.some((p) => !myKeys.has(p.permissionKey));
        if (escalates) throw new ApiError(403, "لا يمكنك إسناد دور يمنح صلاحيات لا تملكها");
      }
      await db.user.update({ where: { id }, data: { cafeRoleId: data.cafeRoleId } });
      await audit({
        cafeId: target.cafeId,
        userId: session.id,
        entity: "User",
        entityId: id,
        action: "USER_ROLE_ASSIGNED",
        details: { targetUserId: id, oldValue: target.cafeRoleId, newValue: data.cafeRoleId },
      });
    }

    // ── Overrides ──
    if (data.overrides) {
      const cleaned = data.overrides.filter((o) => CAFE_KEYS.includes(o.key));
      // Granting (allowed:true) a key you don't hold is escalation. Denials
      // (allowed:false) are always permitted (they only restrict).
      const escalates = cleaned.some((o) => o.allowed && !myKeys.has(o.key));
      if (escalates) throw new ApiError(403, "لا يمكنك منح صلاحيات لا تملكها بنفسك");

      await db.$transaction(async (tx) => {
        await tx.userPermissionOverride.deleteMany({ where: { userId: id } });
        if (cleaned.length > 0) {
          await tx.userPermissionOverride.createMany({
            data: cleaned.map((o) => ({ userId: id, permissionKey: o.key, allowed: o.allowed })),
          });
        }
      });
      await audit({
        cafeId: target.cafeId,
        userId: session.id,
        entity: "User",
        entityId: id,
        action: "USER_PERMISSION_OVERRIDE_UPDATED",
        details: { targetUserId: id, overrides: cleaned },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
