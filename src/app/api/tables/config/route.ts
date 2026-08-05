import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requireKey, resolveCafeId, resolveBranchId, handleApiError, ApiError, requireFeature,
} from "@/lib/api";
import { audit } from "@/lib/audit";

const TABLE_DENIED = "ليس لديك صلاحية لإدارة الترابيزات";

// GET /api/tables/config — configured tables for a branch (+ summary cards)
// for the setup page. Gated by tables.manage (the POS picker uses the
// separate /selector endpoint, which only needs tables.view).
export async function GET(request: NextRequest) {
  try {
    const session = await requireKey("tables.manage");
    await requireFeature(session, "enableTables");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = session.branchId ?? params.get("branchId") ?? undefined;
    const includeArchived = params.get("includeArchived") === "1";

    const tables = await db.cafeTable.findMany({
      where: {
        cafeId,
        ...(branchId ? { branchId } : {}),
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    // Occupied = active tables whose number has an OPEN session in the branch.
    let occupied = 0;
    if (branchId) {
      const openSessions = await db.tableSession.findMany({
        where: { cafeId, branchId, status: "OPEN" },
        select: { tableNumber: true },
      });
      const openNums = new Set(openSessions.map((s) => s.tableNumber));
      occupied = tables.filter((t) => t.isActive && !t.archivedAt && openNums.has(t.tableNumber)).length;
    }

    const active = tables.filter((t) => t.isActive && !t.archivedAt).length;
    const inactive = tables.filter((t) => !t.isActive && !t.archivedAt).length;

    return NextResponse.json({
      summary: { total: tables.filter((t) => !t.archivedAt).length, active, inactive, occupied },
      tables: tables.map((t) => ({
        id: t.id,
        tableNumber: t.tableNumber,
        displayName: t.displayName,
        area: t.area,
        seatsCount: t.seatsCount,
        isActive: t.isActive,
        sortOrder: t.sortOrder,
        archivedAt: t.archivedAt,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  branchId: z.string().optional(),
  cafeId: z.string().optional(),
  tableNumber: z.string().trim().min(1, "رقم الترابيزة مطلوب").max(20),
  displayName: z.string().trim().max(60).optional(),
  area: z.string().trim().max(60).optional(),
  seatsCount: z.number().int().min(0).max(100).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().default(true),
});

// POST /api/tables/config — create a single table.
export async function POST(request: NextRequest) {
  try {
    const session = await requireKey("tables.create");
    await requireFeature(session, "enableTables");
    const data = createSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);
    const branchId = resolveBranchId(session, data.branchId);

    const clash = await db.cafeTable.findUnique({
      where: { branchId_tableNumber: { branchId, tableNumber: data.tableNumber } },
    });
    if (clash) throw new ApiError(409, "رقم الترابيزة موجود بالفعل في هذا الفرع");

    const table = await db.cafeTable.create({
      data: {
        cafeId, branchId,
        tableNumber: data.tableNumber,
        displayName: data.displayName || null,
        area: data.area || null,
        seatsCount: data.seatsCount ?? null,
        sortOrder: data.sortOrder ?? (Number(data.tableNumber) || 0),
        isActive: data.isActive,
      },
    });

    await audit({
      cafeId, userId: session.id, action: "TABLE_CREATED",
      entity: "CafeTable", entityId: table.id,
      details: { branchId, tableId: table.id, tableNumber: table.tableNumber },
    });

    return NextResponse.json({ id: table.id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

export { TABLE_DENIED };
