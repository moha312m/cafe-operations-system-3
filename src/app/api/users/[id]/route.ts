import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { MANAGEABLE_ROLES } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

type Params = { params: Promise<{ id: string }> };

const NOT_ALLOWED = "ليس لديك صلاحية لتنفيذ هذا الإجراء";

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().max(30).nullable().optional(),
  password: z.string().min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل").optional(),
  role: z
    .enum(["CAFE_OWNER", "BRANCH_MANAGER", "CASHIER", "WAITER", "BARISTA", "INVENTORY_MANAGER"])
    .optional(),
  branchId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  archived: z.boolean().optional(), // true = أرشفة، false = إلغاء الأرشفة
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("users:manage");
    const { id } = await params;

    const target = await db.user.findUnique({ where: { id } });
    if (!target) throw new ApiError(404, "User not found");
    if (session.role !== "SUPER_ADMIN" && target.cafeId !== session.cafeId) {
      throw new ApiError(403, NOT_ALLOWED);
    }
    // Can only manage users whose role is below yours (owners can't be
    // touched by branch managers, super admins by owners…). Editing your
    // own profile fields is allowed.
    if (id !== session.id && !MANAGEABLE_ROLES[session.role].includes(target.role)) {
      throw new ApiError(403, NOT_ALLOWED);
    }
    if (session.branchId && target.branchId !== session.branchId) {
      throw new ApiError(403, NOT_ALLOWED);
    }

    const data = updateUserSchema.parse(await request.json());

    // ── Anti-escalation rules ──
    if (data.role && data.role !== target.role) {
      // You can never change your own role, and the NEW role must also be
      // one you're allowed to manage (a branch manager can't mint owners).
      if (id === session.id) throw new ApiError(403, NOT_ALLOWED);
      if (!MANAGEABLE_ROLES[session.role].includes(data.role)) {
        throw new ApiError(403, NOT_ALLOWED);
      }
    }
    // You can't deactivate or archive yourself.
    if ((data.isActive === false || data.archived === true) && id === session.id) {
      throw new ApiError(403, NOT_ALLOWED);
    }
    // Branch managers can't move staff to another branch.
    if (
      data.branchId !== undefined &&
      session.branchId &&
      data.branchId !== session.branchId
    ) {
      throw new ApiError(403, NOT_ALLOWED);
    }
    // Target branch must belong to the same cafe.
    if (data.branchId) {
      const branch = await db.branch.findFirst({
        where: { id: data.branchId, cafeId: target.cafeId ?? undefined },
      });
      if (!branch) throw new ApiError(400, "Branch not found in this cafe");
    }

    const update: Prisma.UserUpdateInput = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.phone !== undefined) update.phone = data.phone?.trim() || null;
    if (data.role !== undefined) update.role = data.role;
    if (data.branchId !== undefined) {
      update.branch = data.branchId
        ? { connect: { id: data.branchId } }
        : { disconnect: true };
    }
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if (data.password) update.passwordHash = await hashPassword(data.password);
    if (data.archived === true) {
      update.archivedAt = new Date();
      update.isActive = false; // archived accounts can never log in
    } else if (data.archived === false) {
      update.archivedAt = null;
    }

    const user = await db.user.update({
      where: { id },
      data: update,
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        isActive: true,
        archivedAt: true,
        branchId: true,
      },
    });

    // ── Specific audit events (one per meaningful change) ──
    const base = {
      cafeId: target.cafeId,
      userId: session.id,
      entity: "User",
      entityId: id,
    };
    const who = { targetUserId: id, targetName: target.name, byName: session.name };

    if (data.password) {
      await audit({ ...base, action: "STAFF_PASSWORD_CHANGED", details: who });
    }
    if (data.archived === true) {
      await audit({ ...base, action: "STAFF_ARCHIVED", details: who });
    } else if (data.archived === false) {
      await audit({ ...base, action: "STAFF_REACTIVATED", details: who });
    } else if (data.isActive === false && target.isActive) {
      await audit({ ...base, action: "STAFF_DEACTIVATED", details: who });
    } else if (data.isActive === true && !target.isActive) {
      await audit({ ...base, action: "STAFF_REACTIVATED", details: who });
    }
    if (data.role && data.role !== target.role) {
      await audit({
        ...base,
        action: "STAFF_ROLE_CHANGED",
        details: { ...who, oldValue: target.role, newValue: data.role },
      });
    }
    if (data.branchId !== undefined && data.branchId !== target.branchId) {
      await audit({
        ...base,
        action: "STAFF_BRANCH_CHANGED",
        details: { ...who, oldValue: target.branchId, newValue: data.branchId },
      });
    }
    if (data.name !== undefined || data.phone !== undefined) {
      await audit({
        ...base,
        action: "STAFF_UPDATED",
        details: {
          ...who,
          ...(data.name !== undefined
            ? { oldValue: target.name, newValue: data.name }
            : {}),
        },
      });
    }

    return NextResponse.json({ user });
  } catch (error) {
    return handleApiError(error);
  }
}
