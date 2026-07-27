import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, resolveCafeId, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { ensureCafeRoles, modulesForKeys } from "@/lib/perms/roles";
import { resolvePermissions } from "@/lib/perms/effective";
import { CAFE_KEYS } from "@/lib/perms/catalog";

// GET /api/roles — list this cafe's permission roles (system + custom).
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("users.manage_permissions");
    const cafeId = resolveCafeId(session, request.nextUrl.searchParams.get("cafeId"));

    // Seed the system defaults on first access.
    await ensureCafeRoles(cafeId);

    const roles = await db.cafeRole.findMany({
      where: { cafeId },
      orderBy: [{ isSystemDefault: "desc" }, { createdAt: "asc" }],
      include: {
        permissions: { where: { allowed: true }, select: { permissionKey: true } },
        _count: { select: { users: true } },
      },
    });

    return NextResponse.json({
      roles: roles.map((r) => {
        const keys = r.permissions.map((p) => p.permissionKey);
        return {
          id: r.id,
          name: r.name,
          code: r.code,
          description: r.description,
          isSystemDefault: r.isSystemDefault,
          isActive: r.isActive,
          archivedAt: r.archivedAt,
          userCount: r._count.users,
          permissionKeys: keys,
          modules: modulesForKeys(keys),
        };
      }),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const createRoleSchema = z.object({
  name: z.string().min(2, "اسم الدور مطلوب"),
  code: z.string().regex(/^[A-Za-z0-9_-]+$/, "كود غير صالح").max(40).optional(),
  description: z.string().max(300).optional(),
  isActive: z.boolean().default(true),
  permissionKeys: z.array(z.string()).default([]),
  cafeId: z.string().optional(),
});

// POST /api/roles — create a custom role. The acting user can only grant
// keys they personally hold (no privilege escalation) and only valid cafe
// keys (platform.manage can never be granted inside a cafe).
export async function POST(request: NextRequest) {
  try {
    const session = await requireKey("users.manage_permissions");
    const data = createRoleSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    const requested = [...new Set(data.permissionKeys)].filter((k) => CAFE_KEYS.includes(k));
    const { keys: myKeys } = await resolvePermissions(session);
    const notAllowed = requested.filter((k) => !myKeys.has(k));
    if (notAllowed.length > 0) {
      throw new ApiError(403, "لا يمكنك منح صلاحيات لا تملكها بنفسك");
    }

    const code = data.code?.trim() || `role_${Math.random().toString(16).slice(2, 10)}`;
    const clash = await db.cafeRole.findUnique({
      where: { cafeId_code: { cafeId, code } },
    });
    if (clash) throw new ApiError(409, "كود الدور مستخدم بالفعل");

    const role = await db.cafeRole.create({
      data: {
        cafeId,
        name: data.name.trim(),
        code,
        description: data.description?.trim() || null,
        isSystemDefault: false,
        isActive: data.isActive,
        permissions: {
          create: requested.map((permissionKey) => ({ permissionKey, allowed: true })),
        },
      },
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "CAFE_ROLE_CREATED",
      entity: "CafeRole",
      entityId: role.id,
      details: { roleId: role.id, name: role.name, code: role.code, permissionKeys: requested },
    });

    return NextResponse.json({ id: role.id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
