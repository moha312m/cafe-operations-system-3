import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError, ApiError } from "@/lib/api";
import { auditActionLabel } from "@/lib/audit-action-labels";
import { csvCell } from "@/lib/report-output";
import { addDays, DEFAULT_TZ, zonedDayStart } from "@/lib/date-range";

const PAGE = 200;
const EXPORT_LIMIT = 5000;
const localStamp = new Intl.DateTimeFormat("sv-SE", { timeZone: DEFAULT_TZ, dateStyle: "short", timeStyle: "medium" });

/** A `YYYY-MM-DD` business day in the café's time zone; the end bound is the next day's start. */
function day(value: string | null, end: boolean): Date | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, "تاريخ غير صالح");
  return zonedDayStart(end ? addDays(value, 1) : value);
}

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

    // `cursor` is the last row already shown: the next page starts right after it, ties included.
    const cursor = params.get("cursor");
    const from = day(params.get("from"), false);
    const to = day(params.get("to"), true);
    const csv = params.get("format") === "csv";

    const logs = await db.auditLog.findMany({
      where: {
        ...where,
        ...(params.get("action")
          ? { action: { startsWith: params.get("action")! } }
          : {}),
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      },
      include: { user: { select: { name: true, email: true, role: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor && !csv ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: csv ? EXPORT_LIMIT : PAGE + 1,
    });

    if (csv) {
      const rows = [["الوقت", "المستخدم", "الحركة", "كود الحركة", "الكيان", "التفاصيل"].map(csvCell).join(",")];
      for (const log of logs) {
        rows.push([
          localStamp.format(log.createdAt),
          log.user?.name ?? "",
          auditActionLabel(log.action),
          log.action,
          log.entity,
          log.details ? JSON.stringify(log.details) : "",
        ].map(csvCell).join(","));
      }
      return new NextResponse("﻿" + rows.join("\r\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="audit-log.csv"`,
          "x-audit-truncated": logs.length >= EXPORT_LIMIT ? "1" : "0",
        },
      });
    }

    const hasMore = logs.length > PAGE;
    return NextResponse.json({ logs: logs.slice(0, PAGE), hasMore });
  } catch (error) {
    return handleApiError(error);
  }
}
