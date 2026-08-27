import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handleApiError } from "@/lib/api";
import { loadRecipeForWrite } from "@/lib/recipe-access";
import { publicRecipeItems } from "@/lib/public-shape";
import { audit } from "@/lib/audit";
import { validateItems, recipeFingerprint } from "@/lib/recipes";

type Params = { params: Promise<{ id: string }> };

const itemSchema = z.object({
  inventoryItemId: z.string(),
  quantity: z.number().positive(),
  unit: z.enum(["GRAM", "KG", "ML", "LITER", "PIECE", "BOX", "BAG"]),
  wastePercentage: z.number().min(0).max(100).optional(),
});
const putSchema = z.object({
  items: z.array(itemSchema),
  appliesToAllVariants: z.boolean().optional(),
});

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const { recipe } = await loadRecipeForWrite(id);
    return NextResponse.json({
      recipe: { ...recipe, items: publicRecipeItems(recipe.items) },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

// Replace the ingredient lines. Any material change clears the confirmation:
// the previous sign-off described a different recipe, and carrying it forward
// would let an edited recipe keep borrowing someone's word for it.
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const { session, recipe } = await loadRecipeForWrite(id);
    const data = putSchema.parse(await request.json());

    const before = recipeFingerprint(recipe.items, {
      appliesToAllVariants: recipe.appliesToAllVariants,
    });
    const after = recipeFingerprint(data.items, {
      appliesToAllVariants: data.appliesToAllVariants ?? recipe.appliesToAllVariants,
    });
    const changed = before !== after;

    const updated = await db.$transaction(async (tx) => {
      await tx.recipeItem.deleteMany({ where: { recipeId: id } });
      if (data.items.length) {
        await tx.recipeItem.createMany({
          data: data.items.map((i) => ({ recipeId: id, ...i })),
        });
      }
      return tx.recipe.update({
        where: { id },
        data: {
          updatedById: session.id,
          ...(data.appliesToAllVariants !== undefined
            ? { appliesToAllVariants: data.appliesToAllVariants }
            : {}),
          // Editing a not-applicable recipe means it does consume something.
          ...(data.items.length ? { notApplicable: false, notApplicableReason: null } : {}),
        },
        include: { items: { include: { inventoryItem: true } } },
      });
    });

    if (changed) {
      await audit({
        cafeId: recipe.cafeId, userId: session.id, action: "RECIPE_UPDATED",
        entity: "Recipe", entityId: id,
        details: {
          byName: session.name,
          productId: recipe.productId, variantId: recipe.variantId, addOnId: recipe.addOnId,
          invalidatedConfirmation: recipe.verifiedAt !== null,
        },
      });
    }

    return NextResponse.json({
      recipe: { ...updated, items: publicRecipeItems(updated.items) },
      issues: validateItems(updated.items),
      confirmationInvalidated: changed && recipe.verifiedAt !== null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
