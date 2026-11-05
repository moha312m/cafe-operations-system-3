import { NextResponse, type NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/api";
import { accountabilityFromParams } from "@/lib/reports/handover-accountability-request";
import { TABLE_KEYS, exportFileName, reportHtml, reportTables, reportXlsx, tableCsv, type TableKey } from "@/lib/reports/handover-accountability-output";

// Exports re-run the report under the caller's own permissions rather than
// trusting a client snapshot, so a masked value stays masked in every file.
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const format = p.get("format");
    if (format !== "xlsx" && format !== "csv" && format !== "html") throw new ApiError(400, "صيغة التصدير غير معروفة");
    const table = (p.get("table") ?? "employees") as TableKey;
    if (format === "csv" && !TABLE_KEYS.includes(table)) throw new ApiError(400, "الجدول غير معروف");
    const report = await accountabilityFromParams(p, { export: true });
    const headers = (type: string, name: string) => ({
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="report.${name.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    });
    if (format === "xlsx") {
      return new NextResponse(new Uint8Array(reportXlsx(report)), { headers: headers("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", exportFileName(report, "xlsx")) });
    }
    if (format === "csv") {
      const t = reportTables(report).find((x) => x.key === table)!;
      return new NextResponse(tableCsv(t), { headers: headers("text/csv; charset=utf-8", exportFileName(report, "csv", t.title)) });
    }
    return new NextResponse(reportHtml(report), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
