import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, handleApiError } from "@/lib/api";
import type { Prisma } from "@prisma/client";

// Cross-cafe audit trail for the platform owner.
//   ?cafeId=  ?action=  ?from=  ?to=
export async function GET(request: NextRequest) {
  try {
    await requirePermission("platform:manage");
    const p = request.nextUrl.searchParams;
    const cafeId = p.get("cafeId") || undefined;
    const action = p.get("action") || undefined;
    const from = p.get("from") ? new Date(p.get("from")!) : undefined;
    const to = p.get("to") ? new Date(p.get("to")!) : undefined;
    if (to) to.setHours(23, 59, 59, 999);

    const where: Prisma.AuditLogWhereInput = {
      ...(cafeId ? { cafeId } : {}),
      ...(action ? { action } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    };

    const [logs, cafes, actions] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true, action: true, entity: true, entityId: true, details: true, createdAt: true,
          cafe: { select: { name: true } },
          user: { select: { name: true, role: true } },
        },
      }),
      db.cafe.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
      db.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } }),
    ]);

    return NextResponse.json({
      logs,
      cafes,
      actions: actions.map((a) => a.action),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
