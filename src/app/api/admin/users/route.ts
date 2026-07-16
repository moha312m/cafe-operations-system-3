import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, handleApiError } from "@/lib/api";
import type { Prisma, Role } from "@prisma/client";

// Cross-cafe user directory for the platform owner.
//   ?q=       name/email/phone contains
//   ?role=    exact role
//   ?cafeId=  restrict to one cafe
//   ?status=  ACTIVE | INACTIVE | ARCHIVED
export async function GET(request: NextRequest) {
  try {
    await requirePermission("platform:manage");
    const p = request.nextUrl.searchParams;
    const q = p.get("q")?.trim();
    const role = p.get("role");
    const cafeId = p.get("cafeId");
    const status = p.get("status");

    const where: Prisma.UserWhereInput = {
      role: { not: "SUPER_ADMIN" },
      ...(cafeId ? { cafeId } : {}),
      ...(role ? { role: role as Role } : {}),
      ...(status === "ARCHIVED"
        ? { NOT: { archivedAt: null } }
        : status === "INACTIVE"
          ? { isActive: false, archivedAt: null }
          : status === "ACTIVE"
            ? { isActive: true, archivedAt: null }
            : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
            ],
          }
        : {}),
    };

    const users = await db.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        isActive: true, archivedAt: true, lastLoginAt: true,
        cafe: { select: { id: true, name: true } },
        branch: { select: { name: true } },
      },
    });

    return NextResponse.json({ users });
  } catch (error) {
    return handleApiError(error);
  }
}
