import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireKey, resolveCafeId, resolveBranchId, handleApiError, ApiError, requireFeature,
} from "@/lib/api";
import { audit } from "@/lib/audit";

const bulkSchema = z.object({
  branchId: z.string().optional(),
  cafeId: z.string().optional(),
  from: z.number().int().min(0, "رقم البداية مطلوب"),
  to: z.number().int().min(0, "رقم النهاية مطلوب"),
  namePrefix: z.string().trim().max(40).optional(),
  area: z.string().trim().max(60).optional(),
  seatsCount: z.number().int().min(0).max(100).optional(),
});

// POST /api/tables/config/bulk — create a numeric range of tables, skipping
// any numbers that already exist in the branch.
export async function POST(request: NextRequest) {
  try {
    const session = await requireKey("tables.bulk_create");
    await requireFeature(session, "enableTables");
    const data = bulkSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);
    const branchId = resolveBranchId(session, data.branchId);

    if (data.from > data.to) throw new ApiError(400, "رقم البداية يجب أن يكون أقل من أو يساوي رقم النهاية");
    const count = data.to - data.from + 1;
    if (count > 100) throw new ApiError(400, "لا يمكن إنشاء أكثر من 100 ترابيزة مرة واحدة");

    const wanted = Array.from({ length: count }, (_, i) => String(data.from + i));

    // Skip numbers that already exist in this branch.
    const existing = await db.cafeTable.findMany({
      where: { branchId, tableNumber: { in: wanted } },
      select: { tableNumber: true },
    });
    const existingSet = new Set(existing.map((t) => t.tableNumber));
    const toCreate = wanted.filter((n) => !existingSet.has(n));

    if (toCreate.length > 0) {
      await db.cafeTable.createMany({
        data: toCreate.map((tableNumber) => ({
          cafeId, branchId, tableNumber,
          displayName: data.namePrefix ? `${data.namePrefix} ${tableNumber}` : null,
          area: data.area || null,
          seatsCount: data.seatsCount ?? null,
          sortOrder: Number(tableNumber) || 0,
          isActive: true,
        })),
      });
    }

    await audit({
      cafeId, userId: session.id, action: "TABLES_BULK_CREATED",
      entity: "CafeTable", entityId: null,
      details: { branchId, from: data.from, to: data.to, created: toCreate.length, skipped: existingSet.size },
    });

    return NextResponse.json({ created: toCreate.length, skipped: existingSet.size });
  } catch (error) {
    return handleApiError(error);
  }
}
