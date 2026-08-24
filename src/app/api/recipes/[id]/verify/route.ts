import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { validateItems, recipeFingerprint } from "@/lib/recipes";
import { loadRecipeForWrite } from "@/lib/recipe-access";

type Params = { params: Promise<{ id: string }> };

// Operational confirmation: a person saying "this is the recipe we actually
// use". The system cannot know that, which is why the signature exists — but
// a signature cannot repair a recipe the system knows is broken, so structural
// validation has to pass first. Otherwise "verified" would only mean somebody
// clicked a button.
//
// The confirmation is stored against a fingerprint of the recipe's contents.
// A later edit changes that fingerprint and the confirmation stops counting,
// without needing a trigger or a version table.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const { session, recipe } = await loadRecipeForWrite(id);

    if (recipe.notApplicable) {
      throw new ApiError(400, "الوصفة معلّمة كغير مطلوبة — مفيش حاجة تتأكد");
    }
    const issues = validateItems(recipe.items);
    if (issues.length > 0) {
      throw new ApiError(
        400,
        `مينفعش تأكيد وصفة فيها مشاكل: ${issues.join("، ")}`
      );
    }

    const updated = await db.recipe.update({
      where: { id },
      data: {
        verifiedById: session.id,
        verifiedAt: new Date(),
        verifiedFingerprint: recipeFingerprint(recipe.items, {
          appliesToAllVariants: recipe.appliesToAllVariants,
        }),
      },
    });

    await audit({
      cafeId: recipe.cafeId, userId: session.id, action: "RECIPE_VERIFIED",
      entity: "Recipe", entityId: id,
      details: {
        byName: session.name,
        productId: recipe.productId, variantId: recipe.variantId, addOnId: recipe.addOnId,
        appliesToAllVariants: recipe.appliesToAllVariants,
        ingredientCount: recipe.items.length,
      },
    });

    return NextResponse.json({
      recipe: { id: updated.id, verifiedAt: updated.verifiedAt, verifiedById: updated.verifiedById },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

// Withdraw a confirmation without touching the ingredients.
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const { session, recipe } = await loadRecipeForWrite(id);
    await db.recipe.update({
      where: { id },
      data: { verifiedById: null, verifiedAt: null, verifiedFingerprint: null },
    });
    await audit({
      cafeId: recipe.cafeId, userId: session.id, action: "RECIPE_UNVERIFIED",
      entity: "Recipe", entityId: id, details: { byName: session.name },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
