import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

// Platform owner: reset password / (de)activate / archive ANY tenant user
// (owner down to barista). SUPER_ADMIN accounts are never targetable here.
const patchSchema = z.object({
  password: z.string().min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل").optional(),
  isActive: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("platform:manage");
    const { id } = await params;

    const target = await db.user.findUnique({ where: { id } });
    if (!target) throw new ApiError(404, "المستخدم غير موجود");
    if (target.role === "SUPER_ADMIN") {
      throw new ApiError(403, "لا يمكن تعديل حساب سوبر أدمن من هنا");
    }

    const data = patchSchema.parse(await request.json());
    const update: Prisma.UserUpdateInput = {};
    if (data.password) update.passwordHash = await hashPassword(data.password);
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if (data.archived === true) {
      update.archivedAt = new Date();
      update.isActive = false;
    } else if (data.archived === false) {
      update.archivedAt = null;
    }

    await db.user.update({ where: { id }, data: update });

    const meta = {
      cafeId: target.cafeId,
      userId: session.id,
      entity: "User",
      entityId: id,
    };
    const who = { targetUserId: id, targetName: target.name, byName: session.name };

    if (data.password) {
      await audit({ ...meta, action: "SUPER_ADMIN_PASSWORD_RESET", details: who });
    }
    if (data.archived === true) {
      await audit({ ...meta, action: "USER_DEACTIVATED", details: { ...who, archived: true } });
    } else if (data.isActive === false && target.isActive) {
      await audit({ ...meta, action: "USER_DEACTIVATED", details: who });
    } else if ((data.isActive === true && !target.isActive) || data.archived === false) {
      await audit({ ...meta, action: "USER_ACTIVATED", details: who });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
