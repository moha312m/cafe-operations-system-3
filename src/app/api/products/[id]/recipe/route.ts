import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { unitsCompatible, productCost, profitFor } from "@/lib/costing";
import type { SessionUser } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

async function findOwnedProduct(id: string, session: SessionUser) {
  const product = await db.product.findUnique({ where: { id } });
  if (!product) throw new ApiError(404, "المنتج مش موجود");
  if (session.role !== "SUPER_ADMIN" && product.cafeId !== session.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
  }
  return product;
}

// GET the product's recipe with live cost/margin. Requires cost:read.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("cost:read");
    const { id } = await params;
    const product = await findOwnedProduct(id, session);

    const items = await db.productRecipeItem.findMany({
      where: { productId: id },
      include: {
        inventoryItem: {
          select: { id: true, name: true, unit: true, costPerUnit: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const cost = productCost(items);
    const profit = profitFor(Number(product.basePrice), cost, items.length > 0);

    return NextResponse.json({
      recipe: items,
      sellingPrice: Number(product.basePrice),
      ...profit, // { cost, profit, margin, tier }
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const recipeSchema = z.object({
  items: z
    .array(
      z.object({
        inventoryItemId: z.string(),
        quantity: z.number().positive("الكمية لازم تكون أكبر من صفر"),
        unit: z.enum(["GRAM", "KG", "ML", "LITER", "PIECE", "BOX", "BAG"]),
        wastePercentage: z.number().min(0).max(100).default(0),
      })
    )
    .default([]),
});

// PUT replaces the whole recipe (add/update/remove in one save).
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("recipe:manage");
    const { id } = await params;
    const product = await findOwnedProduct(id, session);
    const data = recipeSchema.parse(await request.json());

    // Validate every ingredient: same cafe + unit compatible with the item.
    const ids = data.items.map((i) => i.inventoryItemId);
    const invItems = await db.inventoryItem.findMany({
      where: { id: { in: ids }, cafeId: product.cafeId },
      select: { id: true, name: true, unit: true },
    });
    const invById = new Map(invItems.map((i) => [i.id, i]));

    for (const row of data.items) {
      const inv = invById.get(row.inventoryItemId);
      if (!inv) throw new ApiError(400, "خامة مش موجودة في الكافيه");
      if (!unitsCompatible(row.unit, inv.unit)) {
        throw new ApiError(400, "وحدة القياس غير متوافقة مع الخامة");
      }
    }
    // Guard against duplicate ingredient rows.
    if (new Set(ids).size !== ids.length) {
      throw new ApiError(400, "في خامة مكررة في الوصفة");
    }

    const beforeCount = await db.productRecipeItem.count({ where: { productId: id } });

    await db.$transaction(async (tx) => {
      await tx.productRecipeItem.deleteMany({ where: { productId: id } });
      if (data.items.length > 0) {
        await tx.productRecipeItem.createMany({
          data: data.items.map((row) => ({
            cafeId: product.cafeId,
            productId: id,
            inventoryItemId: row.inventoryItemId,
            quantity: row.quantity,
            unit: row.unit,
            wastePercentage: row.wastePercentage,
          })),
        });
      }
    });

    // Recompute & persist the product's costPrice for reports.
    const fresh = await db.productRecipeItem.findMany({
      where: { productId: id },
      include: { inventoryItem: { select: { unit: true, costPerUnit: true } } },
    });
    const cost = productCost(fresh);
    await db.product.update({
      where: { id },
      data: { costPrice: fresh.length > 0 ? cost : null },
    });

    await audit({
      cafeId: product.cafeId,
      userId: session.id,
      action: beforeCount === 0 ? "PRODUCT_RECIPE_CREATED" : "PRODUCT_RECIPE_UPDATED",
      entity: "Product",
      entityId: id,
      details: {
        productName: product.name,
        ingredientCount: data.items.length,
        oldValue: beforeCount,
        newValue: data.items.length,
      },
    });
    await audit({
      cafeId: product.cafeId,
      userId: session.id,
      action: "PRODUCT_COST_RECALCULATED",
      entity: "Product",
      entityId: id,
      details: { productName: product.name, cost },
    });

    const profit = profitFor(Number(product.basePrice), cost, fresh.length > 0);
    return NextResponse.json({ ...profit }); // { cost, profit, margin, tier }
  } catch (error) {
    return handleApiError(error);
  }
}
