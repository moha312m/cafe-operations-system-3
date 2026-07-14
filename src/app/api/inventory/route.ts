import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  resolveCafeId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { round2 } from "@/lib/inventory";
import type { Prisma } from "@prisma/client";

const itemSelect = {
  id: true,
  name: true,
  category: true,
  unit: true,
  currentStock: true,
  minimumStock: true,
  costPerUnit: true,
  supplierName: true,
  expiryDate: true,
  isActive: true,
  archivedAt: true,
  updatedAt: true,
  branchId: true,
  branch: { select: { id: true, name: true } },
} as const;

// Branch scoping: managers/inventory staff pinned to a branch only ever
// see that branch; owners may pass ?branchId= to filter, else all branches.
function scopeBranch(
  session: { branchId: string | null },
  requested: string | null
): string | undefined {
  if (session.branchId) return session.branchId;
  return requested ?? undefined;
}

// GET /api/inventory — items with filters
//   ?branchId= ?category= ?status=(ok|low|out) ?q= ?includeArchived=1
export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("inventory:read");
    const params = request.nextUrl.searchParams;
    const cafeId = resolveCafeId(session, params.get("cafeId"));
    const branchId = scopeBranch(session, params.get("branchId"));

    const where: Prisma.InventoryItemWhereInput = {
      cafeId,
      ...(branchId ? { branchId } : {}),
      ...(params.get("category") ? { category: params.get("category") } : {}),
      ...(params.get("includeArchived") === "1" ? {} : { archivedAt: null }),
      ...(params.get("q")
        ? { name: { contains: params.get("q")!, mode: "insensitive" } }
        : {}),
    };

    const items = await db.inventoryItem.findMany({
      where,
      select: itemSelect,
      orderBy: [{ name: "asc" }],
    });

    // Status filter is derived, so apply it in JS after fetch.
    const status = params.get("status");
    const withStatus = items.map((i) => {
      const cur = Number(i.currentStock);
      const min = Number(i.minimumStock);
      return {
        ...i,
        status: cur <= 0 ? "out" : cur <= min ? "low" : "ok",
        stockValue: round2(cur * Number(i.costPerUnit)),
      };
    });
    const filtered = status
      ? withStatus.filter((i) => i.status === status)
      : withStatus;

    // Summary cards (over the unfiltered branch scope).
    const totalItems = withStatus.length;
    const lowCount = withStatus.filter((i) => i.status === "low").length;
    const outCount = withStatus.filter((i) => i.status === "out").length;
    const totalValue = round2(
      withStatus.reduce((s, i) => s + i.stockValue, 0)
    );

    return NextResponse.json({
      items: filtered,
      summary: { totalItems, lowCount, outCount, totalValue },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  name: z.string().min(1, "اسم الخامة مطلوب"),
  category: z.string().optional(),
  branchId: z.string().min(1, "الفرع مطلوب"),
  unit: z.enum(["GRAM", "KG", "ML", "LITER", "PIECE", "BOX", "BAG"], {
    message: "وحدة القياس مطلوبة",
  }),
  currentStock: z.number({ message: "الكمية يجب أن تكون رقم" }).min(0),
  minimumStock: z.number().min(0).default(0),
  costPerUnit: z.number({ message: "تكلفة الوحدة يجب أن تكون رقم" }).min(0),
  supplierName: z.string().optional(),
  expiryDate: z.string().optional(),
  cafeId: z.string().optional(), // super admin only
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("inventory:manage");
    const data = createSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    // Branch-pinned staff can only add to their own branch.
    const branchId = session.branchId ?? data.branchId;
    if (session.branchId && data.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }
    const branch = await db.branch.findFirst({ where: { id: branchId, cafeId } });
    if (!branch) throw new ApiError(400, "الفرع مش موجود في الكافيه");

    const item = await db.inventoryItem.create({
      data: {
        cafeId,
        branchId,
        name: data.name,
        category: data.category || null,
        unit: data.unit,
        currentStock: data.currentStock,
        minimumStock: data.minimumStock,
        costPerUnit: data.costPerUnit,
        supplierName: data.supplierName || null,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
      },
      select: itemSelect,
    });

    // Opening balance → an initial PURCHASE row in the ledger.
    if (data.currentStock > 0) {
      await db.inventoryTransaction.create({
        data: {
          cafeId,
          branchId,
          inventoryItemId: item.id,
          type: "PURCHASE",
          quantity: data.currentStock,
          unitCost: data.costPerUnit,
          totalCost: round2(data.currentStock * data.costPerUnit),
          note: "رصيد افتتاحي",
          createdById: session.id,
        },
      });
    }

    await audit({
      cafeId,
      userId: session.id,
      action: "INVENTORY_ITEM_CREATED",
      entity: "InventoryItem",
      entityId: item.id,
      details: { name: item.name, branchId, currentStock: data.currentStock },
    });

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
