import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, requireFeature, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { unitsCompatible, productCostStrict, profitFor } from "@/lib/costing";
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
    await requireFeature(session, "recipeCostingEnabled");
    const { id } = await params;
    const product = await findOwnedProduct(id, session);

    const defaultRecipe = await db.recipe.findFirst({
      where: { productId: id, variantId: null, addOnId: null },
      select: { id: true },
    });
    const items = await db.recipeItem.findMany({
      where: { recipeId: defaultRecipe?.id ?? "__none__" },
      include: {
        inventoryItem: {
          select: { id: true, name: true, unit: true, costPerUnit: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const strict = productCostStrict(items);
    const profit = strict.ok ? profitFor(Number(product.basePrice), strict.total, true) : null;

    return NextResponse.json({
      recipe: items,
      sellingPrice: Number(product.basePrice),
      costStatus: strict.ok ? "AVAILABLE" : "RECIPE_INCOMPLETE",
      issues: strict.ok ? [] : strict.issues,
      cost: profit?.cost ?? null,
      profit: profit?.profit ?? null,
      margin: profit?.margin ?? null,
      tier: profit?.tier ?? null,
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
    await requireFeature(session, "recipeCostingEnabled");
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

    // The editor still edits the product's DEFAULT recipe; sizes are
    // configured from the recipe review screen, which knows about variants.
    const defaultRecipe = await db.recipe.upsert({
      where: { id: (await db.recipe.findFirst({
        where: { productId: id, variantId: null, addOnId: null }, select: { id: true },
      }))?.id ?? "__create__" },
      create: { cafeId: product.cafeId, productId: id, createdById: session.id },
      update: { updatedById: session.id },
    });
    const beforeCount = await db.recipeItem.count({ where: { recipeId: defaultRecipe.id } });

    await db.$transaction(async (tx) => {
      await tx.recipeItem.deleteMany({ where: { recipeId: defaultRecipe.id } });
      // Any edit retires the previous confirmation: it described a different
      // recipe (RECIPE-002).
      await tx.recipe.update({
        where: { id: defaultRecipe.id },
        data: { verifiedById: null, verifiedAt: null, verifiedFingerprint: null, updatedById: session.id },
      });
      if (data.items.length > 0) {
        await tx.recipeItem.createMany({
          data: data.items.map((row) => ({
            recipeId: defaultRecipe.id,
            inventoryItemId: row.inventoryItemId,
            quantity: row.quantity,
            unit: row.unit,
            wastePercentage: row.wastePercentage,
          })),
        });
      }
    });

    // Recompute & persist the product's costPrice for reports.
    const fresh = await db.recipeItem.findMany({
      where: { recipeId: defaultRecipe.id },
      include: { inventoryItem: { select: { unit: true, costPerUnit: true } } },
    });
    const strict = productCostStrict(fresh);
    const cost = strict.ok ? strict.total : null;
    const scope = await db.recipe.findUniqueOrThrow({ where: { id: defaultRecipe.id } });
    const variantCount = await db.productVariant.count({ where: { productId: id } });
    await db.product.update({
      where: { id },
      data: { costPrice: strict.ok && (variantCount === 0 || scope.appliesToAllVariants) ? strict.total : null },
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
      details: { productName: product.name, cost, costIssues: strict.ok ? [] : strict.issues },
    });

    const profit = strict.ok ? profitFor(Number(product.basePrice), strict.total, true) : null;
    return NextResponse.json({
      costStatus: strict.ok ? "AVAILABLE" : "RECIPE_INCOMPLETE",
      issues: strict.ok ? [] : strict.issues,
      cost: profit?.cost ?? null,
      profit: profit?.profit ?? null,
      margin: profit?.margin ?? null,
      tier: profit?.tier ?? null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
