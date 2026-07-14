import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  resolveCafeId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { MANAGEABLE_ROLES } from "@/lib/permissions";
import { audit } from "@/lib/audit";

const userSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  isActive: true,
  archivedAt: true,
  lastLoginAt: true,
  branchId: true,
  branch: { select: { name: true } },
  createdAt: true,
} as const;

// GET /api/users — staff list with search & filters.
//   ?q=            name/email/phone contains
//   ?role=         exact role
//   ?branchId=     exact branch (owners only; managers are pinned)
//   ?status=       ACTIVE | INACTIVE | ARCHIVED (default: hides archived)
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("users:manage");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));

    const q = params.get("q")?.trim();
    const role = params.get("role");
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    const status = params.get("status");

    const users = await db.user.findMany({
      where: {
        cafeId,
        ...(branchId ? { branchId } : {}),
        ...(role ? { role: role as never } : {}),
        // Archived staff are hidden unless explicitly requested.
        ...(status === "ARCHIVED"
          ? { archivedAt: { not: null } }
          : status === "INACTIVE"
            ? { archivedAt: null, isActive: false }
            : status === "ACTIVE"
              ? { archivedAt: null, isActive: true }
              : { archivedAt: null }),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" as const } },
                { email: { contains: q, mode: "insensitive" as const } },
                { phone: { contains: q } },
              ],
            }
          : {}),
      },
      select: userSelect,
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ users });
  } catch (error) {
    return handleApiError(error);
  }
}

const createUserSchema = z.object({
  name: z.string().min(2, "الاسم مطلوب"),
  email: z.string().email("البريد الإلكتروني مطلوب"),
  phone: z.string().max(30).optional(),
  password: z.string().min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل"),
  role: z.enum([
    "CAFE_OWNER",
    "BRANCH_MANAGER",
    "CASHIER",
    "WAITER",
    "BARISTA",
    "INVENTORY_MANAGER",
  ]),
  branchId: z.string().nullable().optional(),
  cafeId: z.string().optional(), // super admin only
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("users:manage");
    const data = createUserSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    if (!MANAGEABLE_ROLES[session.role].includes(data.role)) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }

    // Branch managers can only hire into their own branch.
    const branchId = session.branchId ?? data.branchId ?? null;
    if (branchId) {
      const branch = await db.branch.findFirst({
        where: { id: branchId, cafeId },
      });
      if (!branch) throw new ApiError(400, "Branch not found in this cafe");
    }
    // Staff roles must be pinned to a branch.
    if (!branchId && data.role !== "CAFE_OWNER") {
      throw new ApiError(400, "الفرع مطلوب");
    }

    const existing = await db.user.findUnique({
      where: { email: data.email.toLowerCase() },
    });
    if (existing) {
      return NextResponse.json(
        { error: "البريد الإلكتروني مستخدم بالفعل" },
        { status: 409 }
      );
    }

    const user = await db.user.create({
      data: {
        cafeId,
        branchId,
        email: data.email.toLowerCase(),
        name: data.name,
        phone: data.phone?.trim() || null,
        passwordHash: await hashPassword(data.password),
        role: data.role,
      },
      select: userSelect,
    });

    await audit({
      cafeId,
      userId: session.id,
      action: data.role === "CAFE_OWNER" ? "OWNER_ACCOUNT_CREATED" : "STAFF_CREATED",
      entity: "User",
      entityId: user.id,
      details: {
        targetUserId: user.id,
        email: user.email,
        role: user.role,
        branchId,
        createdByName: session.name,
      },
    });

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
