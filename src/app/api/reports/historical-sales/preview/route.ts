import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, requireAllKeys, resolveCafeId } from "@/lib/api";
import {
  mapHistoricalRowHeaders,
  validateHistoricalSaleRow,
  calculateHistoricalImportStats,
  type ValidatedHistoricalSaleRow,
} from "@/lib/historical-sales-import";

const MAX_PREVIEW_ROWS = 25000;

const bodySchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, "الملف فارغ"),
  cafeId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requireAllKeys("reports.view", "finance.view_revenue");
    if (session.role !== "CAFE_OWNER" && session.role !== "SUPER_ADMIN") {
      throw new ApiError(403, "معاينة المبيعات المستوردة متاحة لمالك الكافيه فقط");
    }

    const body = bodySchema.parse(await request.json());
    if (body.rows.length > MAX_PREVIEW_ROWS) {
      throw new ApiError(400, `الحد الأقصى ${MAX_PREVIEW_ROWS} صف في الملف الواحد`);
    }

    const validated: ValidatedHistoricalSaleRow[] = body.rows.map((raw, i) =>
      validateHistoricalSaleRow(mapHistoricalRowHeaders(raw), i + 1)
    );

    const stats = calculateHistoricalImportStats(validated);

    return NextResponse.json({
      success: true,
      stats,
      sampleRows: validated.slice(0, 30),
      errorRows: validated.filter((r) => r.status === "error").slice(0, 20),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
