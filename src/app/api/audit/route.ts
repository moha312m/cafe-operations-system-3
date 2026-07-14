import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError } from "@/lib/api";

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("audit:read");
    const params = request.nextUrl.searchParams;

    // Super admin without a cafeId filter sees platform-wide logs.
    const requestedCafeId = params.get("cafeId");
    const where =
      session.role === "SUPER_ADMIN" && !requestedCafeId
        ? {}
        : { cafeId: resolveCafeId(session, requestedCafeId) };

    const logs = await db.auditLog.findMany({
      where: {
        ...where,
        ...(params.get("action")
          ? { action: { startsWith: params.get("action")! } }
          : {}),
      },
      include: { user: { select: { name: true, email: true, role: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return NextResponse.json({ logs });
  } catch (error) {
    return handleApiError(error);
  }
}
