import type { InventoryUnit, Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api";
import { round2 } from "@/lib/inventory";

export interface LinkedRecipeInfo {
  id: string;
  recipeId: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  sellingPrice: number;
}

export interface DirectSaleInfo {
  isSoldDirectly: boolean;
  productId?: string;
  sellingPrice?: number;
  menuCategoryId?: string;
  portionSize?: number;
}

export const directSaleFingerprint = (inventoryItemId: string) =>
  `DIRECT_ITEM_${inventoryItemId}`;

/**
 * Validates direct sale parameters before saving.
 * Throws 400 ApiError if required fields for direct sale are missing or invalid.
 */
export function validateDirectSaleParams(params: {
  isSoldDirectly?: boolean;
  unit?: string;
  portionSize?: number | null;
  sellingPrice?: number | null;
}) {
  if (!params.isSoldDirectly) return;

  if (
    params.sellingPrice === undefined ||
    params.sellingPrice === null ||
    params.sellingPrice < 0 ||
    !Number.isFinite(params.sellingPrice)
  ) {
    throw new ApiError(400, "يجب تحديد سعر بيع صالح للمنتج");
  }

  if (params.unit === "GRAM" || params.unit === "ML") {
    if (
      params.portionSize === undefined ||
      params.portionSize === null ||
      params.portionSize <= 0 ||
      !Number.isFinite(params.portionSize)
    ) {
      throw new ApiError(
        400,
        "يجب تحديد حجم الحصة المباعة إذا كانت وحدة القياس بالجرام أو المليلتر"
      );
    }
  }
}

/**
 * Retrieves all menu recipes that consume this inventory item as an ingredient,
 * excluding the auto-generated direct sale single-ingredient recipe itself.
 */
export async function getLinkedRecipes(
  client: Prisma.TransactionClient | PrismaClient,
  inventoryItemId: string,
  cafeId: string
): Promise<LinkedRecipeInfo[]> {
  const directFp = directSaleFingerprint(inventoryItemId);

  const recipeItems = await client.recipeItem.findMany({
    where: {
      inventoryItemId,
      recipe: {
        cafeId,
        NOT: {
          verifiedFingerprint: directFp,
        },
      },
    },
    include: {
      recipe: {
        include: {
          product: {
            include: { category: true },
          },
          variant: true,
        },
      },
    },
  });

  return recipeItems
    .filter((ri) => ri.recipe.product !== null)
    .map((ri) => ({
      id: ri.recipe.product!.id,
      recipeId: ri.recipe.id,
      name: ri.recipe.variant
        ? `${ri.recipe.product!.name} (${ri.recipe.variant.name})`
        : ri.recipe.product!.name,
      category: ri.recipe.product!.category?.name ?? "",
      quantity: Number(ri.quantity),
      unit: ri.unit,
      sellingPrice: Number(
        ri.recipe.variant?.price ?? ri.recipe.product!.basePrice ?? 0
      ),
    }));
}

/**
 * Checks if an item is configured for direct sale, either via ProductStockBinding (PIECE)
 * or via dedicated single-ingredient direct recipe (non-PIECE).
 */
export async function getDirectSaleInfo(
  client: Prisma.TransactionClient | PrismaClient,
  inventoryItemId: string,
  cafeId: string
): Promise<DirectSaleInfo> {
  // 1. Check ProductStockBinding (for PIECE finished goods)
  const binding = await client.productStockBinding.findFirst({
    where: { inventoryItemId, cafeId },
    include: { product: true },
  });

  if (binding && binding.product) {
    return {
      isSoldDirectly: true,
      productId: binding.productId,
      sellingPrice: Number(binding.product.basePrice),
      menuCategoryId: binding.product.categoryId,
      portionSize: 1,
    };
  }

  // 2. Check dedicated direct recipe for this inventory item (for non-PIECE)
  const directFp = directSaleFingerprint(inventoryItemId);
  const directRecipe = await client.recipe.findFirst({
    where: {
      cafeId,
      verifiedFingerprint: directFp,
    },
    include: {
      product: true,
      items: true,
    },
  });

  if (directRecipe && directRecipe.product) {
    const ri = directRecipe.items.find(
      (item) => item.inventoryItemId === inventoryItemId
    );
    return {
      isSoldDirectly: true,
      productId: directRecipe.productId!,
      sellingPrice: Number(directRecipe.product.basePrice),
      menuCategoryId: directRecipe.product.categoryId,
      portionSize: ri ? Number(ri.quantity) : 1,
    };
  }

  return { isSoldDirectly: false };
}

export interface SyncDirectSaleOptions {
  inventoryItemId: string;
  cafeId: string;
  branchId: string;
  name: string;
  unit: string;
  costPerUnit: number;
  isSoldDirectly: boolean;
  sellingPrice?: number;
  portionSize?: number;
  menuCategoryId?: string;
  categoryName?: string;
}

/**
 * Atomically creates, updates, or unlinks direct sale Product and ProductStockBinding / Recipe.
 */
export async function syncDirectSale(
  tx: Prisma.TransactionClient,
  opts: SyncDirectSaleOptions
) {
  const {
    inventoryItemId,
    cafeId,
    branchId,
    name,
    unit,
    costPerUnit,
    isSoldDirectly,
    sellingPrice,
    portionSize,
    menuCategoryId,
    categoryName,
  } = opts;

  const directFp = directSaleFingerprint(inventoryItemId);

  if (!isSoldDirectly) {
    // Unlink PIECE bindings safely
    const bindings = await tx.productStockBinding.findMany({
      where: { inventoryItemId, cafeId },
    });
    if (bindings.length > 0) {
      const productIds = Array.from(new Set(bindings.map((b) => b.productId)));
      await tx.productStockBinding.deleteMany({
        where: { inventoryItemId, cafeId },
      });
      // Only deactivate a product if it has no remaining bindings in any branch
      for (const pid of productIds) {
        const remaining = await tx.productStockBinding.count({
          where: { productId: pid },
        });
        if (remaining === 0) {
          await tx.product.updateMany({
            where: { id: pid, cafeId, stockMode: "FINISHED_GOOD" },
            data: { isActive: false, isAvailable: false },
          });
        }
      }
    }

    // Unlink dedicated direct recipe (non-PIECE) safely
    const directRecipe = await tx.recipe.findFirst({
      where: { cafeId, verifiedFingerprint: directFp },
      include: { product: true },
    });
    if (directRecipe) {
      const prodId = directRecipe.productId;
      await tx.recipe.delete({ where: { id: directRecipe.id } });
      if (prodId) {
        await tx.product.updateMany({
          where: { id: prodId, cafeId },
          data: { isActive: false, isAvailable: false },
        });
      }
    }
    return;
  }

  // isSoldDirectly is TRUE
  validateDirectSaleParams({
    isSoldDirectly,
    unit,
    portionSize,
    sellingPrice,
  });

  // Resolve Category
  let categoryId = menuCategoryId;
  if (categoryId) {
    const cat = await tx.menuCategory.findFirst({
      where: { id: categoryId, cafeId },
    });
    if (!cat) throw new ApiError(400, "التصنيف غير موجود في هذه المنشأة");
  } else {
    const existing = await tx.menuCategory.findFirst({
      where: { cafeId },
      orderBy: { sortOrder: "asc" },
    });
    if (existing) {
      categoryId = existing.id;
    } else {
      const createdCat = await tx.menuCategory.create({
        data: {
          cafeId,
          name: categoryName || "عام",
        },
      });
      categoryId = createdCat.id;
    }
  }

  const effectivePortion =
    unit === "GRAM" || unit === "ML"
      ? portionSize!
      : (portionSize ?? 1);
  const costPrice = round2(costPerUnit * effectivePortion);

  if (unit === "PIECE") {
    // 1. Check if there is an existing binding for this inventory item
    const existingBinding = await tx.productStockBinding.findFirst({
      where: { inventoryItemId, cafeId },
      include: { product: true },
    });

    let productId: string;
    if (existingBinding && existingBinding.product) {
      productId = existingBinding.productId;
      await tx.product.update({
        where: { id: productId },
        data: {
          name,
          basePrice: sellingPrice!,
          costPrice,
          categoryId,
          stockMode: "FINISHED_GOOD",
          isActive: true,
          isAvailable: true,
        },
      });
    } else {
      const newProd = await tx.product.create({
        data: {
          cafeId,
          name,
          basePrice: sellingPrice!,
          costPrice,
          categoryId,
          stockMode: "FINISHED_GOOD",
          isActive: true,
          isAvailable: true,
          showInPOS: true,
          showInCustomerMenu: true,
        },
      });
      productId = newProd.id;
    }

    // Ensure binding is in place for this branch
    await tx.productStockBinding.deleteMany({
      where: { inventoryItemId, cafeId, branchId },
    });
    await tx.productStockBinding.create({
      data: {
        cafeId,
        branchId,
        productId,
        inventoryItemId,
        unit: "PIECE",
      },
    });
  } else {
    // Non-PIECE (e.g. GRAM or ML): dedicated single-ingredient direct recipe
    const directRecipe = await tx.recipe.findFirst({
      where: {
        cafeId,
        verifiedFingerprint: directFp,
      },
      include: {
        product: true,
        items: true,
      },
    });

    if (directRecipe && directRecipe.productId) {
      await tx.product.update({
        where: { id: directRecipe.productId },
        data: {
          name,
          basePrice: sellingPrice!,
          costPrice,
          categoryId,
          isActive: true,
          isAvailable: true,
        },
      });
      const ri = directRecipe.items.find(
        (item) => item.inventoryItemId === inventoryItemId
      );
      if (ri) {
        await tx.recipeItem.update({
          where: { id: ri.id },
          data: {
            quantity: effectivePortion,
            unit: unit as InventoryUnit,
          },
        });
      } else {
        await tx.recipeItem.create({
          data: {
            recipeId: directRecipe.id,
            inventoryItemId,
            quantity: effectivePortion,
            unit: unit as InventoryUnit,
          },
        });
      }
    } else {
      const newProd = await tx.product.create({
        data: {
          cafeId,
          name,
          basePrice: sellingPrice!,
          costPrice,
          categoryId,
          stockMode: "RECIPE",
          isActive: true,
          isAvailable: true,
          showInPOS: true,
          showInCustomerMenu: true,
        },
      });
      await tx.recipe.create({
        data: {
          cafeId,
          productId: newProd.id,
          verifiedFingerprint: directFp,
          items: {
            create: {
              inventoryItemId,
              quantity: effectivePortion,
              unit: unit as InventoryUnit,
            },
          },
        },
      });
    }
  }
}
