import { NextResponse, type NextRequest } from "next/server";
import { ApiError, handleApiError } from "@/lib/api";
import { resolvePermissions } from "@/lib/perms/effective";
import { accountingScope } from "@/lib/accounting/api-scope";
import { exportQuery } from "@/lib/accounting/chart-export";
import { chartExportFile } from "@/lib/accounting/chart-export-queries";

// GET /api/accounting/chart-of-accounts/export?format=xlsx|csv&scope=full|filtered&q=
//   [&includeMapping=1 (xlsx) | &dataset=mapping (csv)]
// Read-only download of the chart, independent of any screen pagination or collapsed group.
// Needs accounting.export; the mapping sheet also needs expenses.view — both checked here, not in the UI.
export async function GET(request: NextRequest) {
  try {
    const { session, scope } = await accountingScope(request);
    const { keys } = await resolvePermissions(session);
    if (!keys.has("accounting.export")) throw new ApiError(403, "ليس لديك صلاحية تصدير المحاسبة");
    const params = Object.fromEntries(["format", "scope", "q", "dataset", "includeMapping"].flatMap((k) => { const v = request.nextUrl.searchParams.get(k); return v === null ? [] : [[k, v]]; }));
    const query = exportQuery.parse(params);
    if (query.scope === "filtered" && !query.q) throw new ApiError(400, "اكتب كلمة بحث لتصدير النتائج الحالية، أو اختار الدليل كاملًا");
    const wantsMapping = query.includeMapping === "1" || query.dataset === "mapping";
    if (wantsMapping && !keys.has("expenses.view")) throw new ApiError(403, "ربط تصنيفات المصروفات لمن عنده صلاحية عرض المصاريف");
    const file = await chartExportFile(scope, query);
    return new NextResponse(new Uint8Array(file.body), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
