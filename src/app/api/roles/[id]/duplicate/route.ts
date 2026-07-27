import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// POST /api/roles/[id]/duplicate — clone a role into a new custom (editable)
// role in the same cafe. The copy is never a system default.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("users.manage_permissions");
    if (!session.cafeId) throw new ApiError(400, "الحساب مش مرتبط بكافيه");
    const { id } = await params;

    const source = await db.cafeRole.findFirst({
      where: { id, cafeId: session.cafeId },
      include: { permissions: { select: { permissionKey: true, allowed: true } } },
    });
    if (!source) throw new ApiError(404, "الدور غير موجود");

    const code = `role_${Math.random().toString(16).slice(2, 10)}`;
    const copy = await db.cafeRole.create({
      data: {
        cafeId: session.cafeId,
        name: `${source.name} (نسخة)`,
        code,
        description: source.description,
        isSystemDefault: false,
        isActive: true,
        permissions: {
          create: source.permissions.map((p) => ({ permissionKey: p.permissionKey, allowed: p.allowed })),
        },
      },
    });

    await audit({
      cafeId: session.cafeId,
      userId: session.id,
      action: "CAFE_ROLE_CREATED",
      entity: "CafeRole",
      entityId: copy.id,
      details: { roleId: copy.id, duplicatedFrom: source.id, name: copy.name },
    });

    return NextResponse.json({ id: copy.id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
