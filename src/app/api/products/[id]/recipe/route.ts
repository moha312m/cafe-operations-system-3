import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, requireFeature, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { unitsCompatible, productCostStrict } from "@/lib/costing";
import { configurationFinancials, resolveEffectiveRecipe } from "@/lib/recipes";
import { publicRecipeItems } from "@/lib/public-shape";
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
    const variantId = _request.nextUrl.searchParams.get("variantId");
    const variant = variantId
      ? await db.productVariant.findFirst({ where: { id: variantId, productId: id } })
      : null;
    if (variantId && !variant) throw new ApiError(400, "الحجم لا يتبع هذا المنتج");

    // Open the recipe that actually governs this size. A size covered by an
    // all-variant default must show that default's ingredients: the board
    // called such a row trusted because of them, so presenting an empty form
    // would invite someone to "fix" a recipe that was already right — and the
    // save would silently create an override that shadowed it.
    const resolved = await resolveEffectiveRecipe(id, variantId ?? null);
    const items = resolved.items;

    const sellingPrice = Number(variant?.price ?? product.basePrice);
    // Money comes from the same gate the board uses, so a structurally tidy
    // but unconfirmed recipe reports no cost here either.
    const financials = await configurationFinancials({
      productId: id,
      variantId: variantId ?? null,
      sellingPrice,
    });

    return NextResponse.json({
      recipe: publicRecipeItems(items),
      recipeSource: resolved.source,
      sellingPrice,
      costStatus: financials.costStatus,
      issues: financials.issues,
      cost: financials.cost,
      profit: financials.profit,
      margin: financials.margin,
      tier: financials.tier,
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
    const variantId = request.nextUrl.searchParams.get("variantId");
    const variant = variantId
      ? await db.productVariant.findFirst({ where: { id: variantId, productId: id } })
      : null;
    if (variantId && !variant) throw new ApiError(400, "الحجم لا يتبع هذا المنتج");

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

    const selectedRecipe = await db.recipe.upsert({
      where: { id: (await db.recipe.findFirst({
        where: { productId: id, variantId: variantId ?? null, addOnId: null }, select: { id: true },
      }))?.id ?? "__create__" },
      create: {
        cafeId: product.cafeId,
        productId: id,
        variantId: variantId ?? null,
        createdById: session.id,
      },
      update: { updatedById: session.id },
    });
    const beforeCount = await db.recipeItem.count({ where: { recipeId: selectedRecipe.id } });

    await db.$transaction(async (tx) => {
      await tx.recipeItem.deleteMany({ where: { recipeId: selectedRecipe.id } });
      // Any edit retires the previous confirmation: it described a different
      // recipe (RECIPE-002).
      await tx.recipe.update({
        where: { id: selectedRecipe.id },
        data: { verifiedById: null, verifiedAt: null, verifiedFingerprint: null, updatedById: session.id },
      });
      if (data.items.length > 0) {
        await tx.recipeItem.createMany({
          data: data.items.map((row) => ({
            recipeId: selectedRecipe.id,
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
      where: { recipeId: selectedRecipe.id },
      include: { inventoryItem: { select: { unit: true, costPerUnit: true } } },
    });
    const strict = productCostStrict(fresh);
    const cost = strict.ok ? strict.total : null;
    const scope = await db.recipe.findUniqueOrThrow({ where: { id: selectedRecipe.id } });
    const variantCount = await db.productVariant.count({ where: { productId: id } });
    await db.product.update({
      where: { id },
      data: {
        costPrice: variantId
          ? null
          : strict.ok && (variantCount === 0 || scope.appliesToAllVariants)
            ? strict.total
            : null,
      },
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

    const sellingPrice = Number(variant?.price ?? product.basePrice);
    // A save always retires the confirmation above, so the honest answer here
    // is "not trusted yet" until someone confirms the new numbers.
    const savedFinancials = await configurationFinancials({
      productId: id,
      variantId: variantId ?? null,
      sellingPrice,
    });
    return NextResponse.json({
      costStatus: savedFinancials.costStatus,
      issues: savedFinancials.issues,
      cost: savedFinancials.cost,
      profit: savedFinancials.profit,
      margin: savedFinancials.margin,
      tier: savedFinancials.tier,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
