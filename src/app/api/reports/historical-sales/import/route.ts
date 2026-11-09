import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { ApiError, handleApiError, requireAllKeys, resolveCafeId } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import {
  mapHistoricalRowHeaders,
  validateHistoricalSaleRow,
  calculateHistoricalImportStats,
  type ValidatedHistoricalSaleRow,
} from "@/lib/historical-sales-import";

const BATCH_SIZE = 500;
const MAX_IMPORT_ROWS = 50000;

const bodySchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, "الملف فارغ"),
  fileName: z.string().max(250).default("sales-export"),
  mode: z.enum(["append", "replace_year", "replace_all"]).default("append"),
  targetYear: z.number().int().min(2000).max(2100).optional(),
  cafeId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requireAllKeys("reports.view", "finance.view_revenue");
    if (session.role !== "CAFE_OWNER" && session.role !== "SUPER_ADMIN") {
      throw new ApiError(403, "استيراد المبيعات السابقة متاح لمالك الكافيه فقط");
    }

    const body = bodySchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);

    if (body.rows.length > MAX_IMPORT_ROWS) {
      throw new ApiError(400, `الحد الأقصى ${MAX_IMPORT_ROWS} صف في العملية الواحدة`);
    }

    const validated: ValidatedHistoricalSaleRow[] = body.rows.map((raw, i) =>
      validateHistoricalSaleRow(mapHistoricalRowHeaders(raw), i + 1)
    );

    const readyRows = validated.filter((r) => r.status === "ready");
    if (readyRows.length === 0) {
      throw new ApiError(400, "لم يتم العثور على أي سطور بيع صالحة في الملف");
    }

    const stats = calculateHistoricalImportStats(validated);

    // Compute deterministic sourceHash based on file name, first 50 rows, and count
    const hashPayload = `${body.fileName}:${readyRows.length}:${JSON.stringify(readyRows.slice(0, 50))}`;
    const sourceHash = createHash("sha256").update(hashPayload).digest("hex").slice(0, 32);

    await db.$transaction(
      async (tx) => {
        if (body.mode === "replace_year") {
          const year = body.targetYear ?? stats.years[0];
          if (!year) throw new ApiError(400, "سنة الاستبدال غير محددة");
          await tx.historicalSaleLine.deleteMany({
            where: { cafeId, saleMonth: { gte: `${year}-01`, lte: `${year}-12` } },
          });
        } else if (body.mode === "replace_all") {
          await tx.historicalSaleLine.deleteMany({
            where: { cafeId },
          });
        }

        // Insert in batches of 500
        for (let i = 0; i < readyRows.length; i += BATCH_SIZE) {
          const batch = readyRows.slice(i, i + BATCH_SIZE);
          await tx.historicalSaleLine.createMany({
            data: batch.map((r) => ({
              cafeId,
              sourceHash,
              sourceRow: r.sourceRow,
              sku: r.sku,
              productName: r.productName,
              invoiceNo: r.invoiceNo,
              saleLocalDate: r.saleLocalDate,
              saleDate: r.saleDate,
              saleMonth: r.saleMonth,
              quantity: r.quantity,
              quantityUnit: r.quantityUnit,
              unitPrice: r.unitPrice,
              discount: r.discount,
              tax: r.tax,
              priceIncTax: r.priceIncTax,
              total: r.total,
              paymentMethod: r.paymentMethod,
              customerName: r.customerName,
              contactNumber: r.contactNumber,
              location: r.location,
            })),
            skipDuplicates: true,
          });
        }

        await auditInTransaction(tx, {
          cafeId,
          userId: session.id,
          action: "HISTORICAL_SALES_IMPORTED",
          entity: "HistoricalSaleLine",
          entityId: sourceHash,
          details: {
            fileName: body.fileName,
            mode: body.mode,
            targetYear: body.targetYear,
            importedCount: readyRows.length,
            totalRevenue: stats.totalRevenue,
            minDate: stats.minDate,
            maxDate: stats.maxDate,
            uniqueProducts: stats.uniqueProducts,
            uniqueInvoices: stats.uniqueInvoices,
          },
        });
      },
      { timeout: 120000, maxWait: 10000 }
    );

    return NextResponse.json({
      success: true,
      importedCount: readyRows.length,
      skippedErrors: validated.length - readyRows.length,
      totalRevenue: stats.totalRevenue,
      minDate: stats.minDate,
      maxDate: stats.maxDate,
      years: stats.years,
      sourceHash,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
