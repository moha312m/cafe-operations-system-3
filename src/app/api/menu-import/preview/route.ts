import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, requireFeature, resolveCafeId, handleApiError, ApiError } from "@/lib/api";
import {
  validateRow,
  MAX_IMPORT_ROWS,
  type RawImportRow,
} from "@/lib/menu-import";

const bodySchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, "الملف فارغ"),
  cafeId: z.string().optional(), // super admin only
});

// Validates parsed rows against this cafe's data and returns the
// preview: per-row status/errors plus whether each product would be
// created or updated. Nothing is written here.
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("menu:manage");
    await requireFeature(session, "excelImportEnabled");
    const body = bodySchema.parse(await request.json());
    const cafeId = resolveCafeId(session, body.cafeId);

    if (body.rows.length > MAX_IMPORT_ROWS) {
      throw new ApiError(400, `الحد الأقصى ${MAX_IMPORT_ROWS} صف في الملف الواحد`);
    }

    const [branches, existingProducts] = await Promise.all([
      db.branch.findMany({ where: { cafeId }, select: { id: true, name: true } }),
      db.product.findMany({
        where: { cafeId },
        select: { name: true, category: { select: { name: true } } },
      }),
    ]);
    const branchNames = new Map(branches.map((b) => [b.name.trim(), b.id]));
    const existingKeys = new Set(
      existingProducts.map((p) => `${p.category.name}::${p.name}`)
    );

    const rows = body.rows.map((raw, i) => {
      const row = validateRow(raw as RawImportRow, i + 1);
      // Tenant-aware checks: branch must exist in THIS cafe.
      if (row.branchName && !branchNames.has(row.branchName)) {
        row.errors.push("الفرع غير موجود");
      }
      const exists = existingKeys.has(`${row.category}::${row.productName}`);
      return {
        ...row,
        status: row.errors.length > 0 ? ("error" as const) : ("ready" as const),
        existing: exists,
      };
    });

    const readyRows = rows.filter((r) => r.status === "ready");
    const productKeys = new Set(readyRows.map((r) => `${r.category}::${r.productName}`));
    const newProducts = [...productKeys].filter((k) => !existingKeys.has(k)).length;

    return NextResponse.json({
      rows,
      stats: {
        total: rows.length,
        ready: readyRows.length,
        errors: rows.length - readyRows.length,
        products: productKeys.size,
        newProducts,
        existingProducts: productKeys.size - newProducts,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
