import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, requireFeature, requireKey, resolveCafeId } from "@/lib/api";
import { db } from "@/lib/db";
import { DEFAULT_TZ } from "@/lib/date-range";
import { resolvePermissions } from "@/lib/perms/effective";
import { handoverDetailPayload } from "@/lib/handover-detail-payload";
import { buildHandoverReport, reportHtml, reportWorkbook, stamp } from "@/lib/handover-report";

type Params = { params: Promise<{ id: string }> };
const query = z.object({ format: z.enum(["xlsx", "html"]), cafeId: z.string().optional() }).strict();

// GET /api/handovers/:id/report?format=xlsx|html
// The report is built from the same payload as the detail screen, so blind-count
// disclosure, financial access and branch/tenant scope are exactly the screen's.
// `handover.view` to read it at all, plus `reports.export` to take it out of the app.
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("handover.view");
    await requireFeature(session, "inventoryEnabled");
    const { keys } = await resolvePermissions(session);
    if (!keys.has("reports.export")) throw new ApiError(403, "ليس لديك صلاحية تصدير التقارير");
    const { id } = await params;
    const q = query.parse(Object.fromEntries(request.nextUrl.searchParams));
    const cafeId = resolveCafeId(session, q.cafeId ?? null);
    const payload = await handoverDetailPayload(session, id, cafeId);
    const [cafe, reporting] = await Promise.all([
      db.cafe.findUniqueOrThrow({ where: { id: cafeId }, select: { name: true, currency: true } }),
      db.branchReportingVersion.findFirst({ where: { branchId: payload.branchId }, orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }], select: { timezone: true } }),
    ]);
    const meta = { businessName: cafe.name, currency: cafe.currency, timezone: reporting?.timezone ?? DEFAULT_TZ, generatedAt: new Date(), viewerName: session.name };
    const report = buildHandoverReport(payload, meta);
    const day = stamp(meta.generatedAt, meta.timezone).slice(0, 10);
    const base = `handover-shift-${payload.financialSummary?.shiftNumber ?? payload.overview.shiftNumber}-${day}`;
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (q.format === "xlsx") {
      return new NextResponse(new Uint8Array(reportWorkbook(report)), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${base}.xlsx"` } });
    }
    return new NextResponse(reportHtml(report), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `inline; filename="${base}.html"`, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } });
  } catch (error) {
    return handleApiError(error);
  }
}
