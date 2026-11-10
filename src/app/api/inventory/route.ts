import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  resolveCafeId,
  handleApiError,
  ApiError,
  requireFeature,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { round2 } from "@/lib/inventory";
import { applyStockMutation, lockItemForUpdate } from "@/lib/ledger";
import { round3 } from "@/lib/costing";
import { withStockAlerts } from "@/lib/low-stock";
import { syncDirectSale } from "@/lib/inventory-pricing-linkage";
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
  isCritical: true,
  archivedAt: true,
  updatedAt: true,
  branchId: true,
  branch: { select: { id: true, name: true } },
  stockBindings: { select: { id: true, productId: true } },
  recipeItems: {
    where: {
      recipe: {
        verifiedFingerprint: { not: null },
      },
    },
    select: { id: true, recipe: { select: { verifiedFingerprint: true } } },
  },
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
    const hasFinishedHistory =
      (await db.orderItem.count({
        where: {
          stockModeSnapshot: "FINISHED_GOOD",
          stockAcceptedAt: { not: null },
          order: { cafeId, ...(branchId ? { branchId } : {}) },
        },
      })) > 0;
    if (!hasFinishedHistory) await requireFeature(session, "inventoryEnabled");

    const where: Prisma.InventoryItemWhereInput = {
      cafeId,
      ...(branchId ? { branchId } : {}),
      ...(params.get("category") ? { category: params.get("category") } : {}),
      ...(params.get("includeArchived") === "1" ? {} : { archivedAt: null }),
      ...(params.get("q")
        ? { name: { contains: params.get("q")!, mode: "insensitive" } }
        : {}),
    };

    // Self-healing: synchronize any owner-approved count corrections into physical stock:
    try {
      const pendingApproved = await db.stockCountCorrection.findMany({
        where: {
          status: "APPROVED",
          line: {
            session: {
              cafeId,
              ...(branchId ? { branchId } : {}),
              status: { in: ["DRAFT", "IN_PROGRESS", "SUBMITTED", "CONFIRMED"] },
            },
          },
        },
        select: {
          id: true,
          newCountedQuantity: true,
          line: {
            select: {
              inventoryItemId: true,
              session: { select: { branchId: true, handoverId: true } },
              inventoryItem: { select: { currentStock: true } },
            },
          },
        },
        orderBy: { approvedAt: "desc" },
        take: 10,
      });

      for (const corr of pendingApproved) {
        const targetQty = Number(corr.newCountedQuantity);
        const currentQty = Number(corr.line.inventoryItem.currentStock);
        if (Math.abs(targetQty - currentQty) > 0.0001) {
          try {
            await db.$transaction(async (tx) => {
              const locked = await lockItemForUpdate(tx, corr.line.inventoryItemId);
              const delta = round3(targetQty - Number(locked.currentStock));
              if (Math.abs(delta) > 0.0001) {
                await applyStockMutation(tx, {
                  inventoryItemId: corr.line.inventoryItemId,
                  type: "ADJUSTMENT",
                  quantity: delta,
                  cafeId,
                  branchId: corr.line.session.branchId,
                  createdById: session.id,
                  note: "مزامنة رصيد المخزن مع تصحيح الجرد المعتمد من المالك",
                  allowNegative: true,
                  freezeToken: corr.line.session.handoverId ?? undefined,
                });
              }
            });
          } catch {
            // Keep serving even if individual lock/freeze is in transit
          }
        }
      }
    } catch {
      // Non-blocking fallback
    }

    const items = await db.inventoryItem.findMany({
      where,
      select: itemSelect,
      orderBy: [{ name: "asc" }],
    });

    // Status filter is derived, so apply it in JS after fetch.
    const status = params.get("status");
    const withStatus = (await withStockAlerts(cafeId, items)).map((i) => ({
      ...i,
      stockValue: round2(Number(i.currentStock) * Number(i.costPerUnit)),
      isSoldDirectly:
        Boolean(i.stockBindings && i.stockBindings.length > 0) ||
        Boolean(
          i.recipeItems &&
            i.recipeItems.some(
              (ri) => ri.recipe?.verifiedFingerprint === `DIRECT_ITEM_${i.id}`
            )
        ),
    }));
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
      hasFinishedHistory,
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
  isCritical: z.boolean().optional(),
  cafeId: z.string().optional(), // super admin only
  // Finished Good / Menu Auto-Pricing Linkage
  isSoldDirectly: z.boolean().optional(),
  sellingPrice: z.number().min(0).optional(),
  portionSize: z.number().positive().optional(),
  menuCategoryId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("inventory:manage");
    await requireFeature(session, "inventoryEnabled");
    const data = createSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    // Branch-pinned staff can only add to their own branch.
    const branchId = session.branchId ?? data.branchId;
    if (session.branchId && data.branchId !== session.branchId) {
      throw new ApiError(403, "ليس لديك صلاحية على فرع تاني");
    }
    const branch = await db.branch.findFirst({
      where: { id: branchId, cafeId },
    });
    if (!branch) throw new ApiError(400, "الفرع مش موجود في الكافيه");

    // One transaction for the item, its opening ledger row, and direct menu product linkage.
    const item = await db.$transaction(async (tx) => {
      const created = await tx.inventoryItem.create({
        data: {
          cafeId,
          branchId,
          name: data.name,
          category: data.category || null,
          unit: data.unit,
          currentStock: 0,
          minimumStock: data.minimumStock,
          costPerUnit: data.costPerUnit,
          supplierName: data.supplierName || null,
          expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
          isCritical: data.isCritical ?? false,
        },
        select: { id: true },
      });

      if (data.currentStock > 0) {
        await applyStockMutation(tx, {
          inventoryItemId: created.id,
          cafeId,
          branchId,
          type: "PURCHASE",
          quantity: data.currentStock,
          unitCost: data.costPerUnit,
          totalCost: round2(data.currentStock * data.costPerUnit),
          note: "رصيد افتتاحي",
          createdById: session.id,
        });
      }

      if (data.isSoldDirectly) {
        await syncDirectSale(tx, {
          inventoryItemId: created.id,
          cafeId,
          branchId,
          name: data.name,
          unit: data.unit,
          costPerUnit: data.costPerUnit,
          isSoldDirectly: true,
          sellingPrice: data.sellingPrice,
          portionSize: data.portionSize,
          menuCategoryId: data.menuCategoryId,
          categoryName: data.category,
        });
      }

      return tx.inventoryItem.findUniqueOrThrow({
        where: { id: created.id },
        select: itemSelect,
      });
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "INVENTORY_ITEM_CREATED",
      entity: "InventoryItem",
      entityId: item.id,
      details: {
        name: item.name,
        branchId,
        currentStock: data.currentStock,
        isSoldDirectly: data.isSoldDirectly,
      },
    });

    return NextResponse.json(
      { item: { ...item, isSoldDirectly: !!data.isSoldDirectly } },
      { status: 201 }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
