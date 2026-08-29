import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requireRecipeCafe } from "@/lib/recipe-access";

// Copy a product's default recipe onto its sizes as a starting point.
//
// This exists because configuring a menu one size at a time is tedious, and
// tedium is what makes people click "verify all" on numbers they never read.
// The copy is deliberately unconfirmed: a large latte almost certainly does
// NOT use the same milk as a small, so what lands here is a draft to correct,
// not an answer. Confirmation stays a separate, deliberate act on each size.
const schema = z.object({
  productId: z.string(),
  variantIds: z.array(z.string()).min(1),
  /** Leave existing variant recipes alone unless explicitly told otherwise. */
  overwrite: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requireRecipeCafe();
    const { productId, variantIds, overwrite } = schema.parse(await request.json());

    const product = await db.product.findUnique({
      where: { id: productId },
      include: { variants: { select: { id: true } } },
    });
    if (!product) throw new ApiError(404, "المنتج مش موجود");
    if (session.role !== "SUPER_ADMIN" && product.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية على هذا المنتج");
    }
    const owned = new Set(product.variants.map((v) => v.id));
    if (variantIds.some((v) => !owned.has(v))) {
      throw new ApiError(400, "حجم مش تابع للمنتج ده");
    }

    const source = await db.recipe.findFirst({
      where: { productId, variantId: null, addOnId: null },
      include: { items: true },
    });
    if (!source || source.items.length === 0) {
      throw new ApiError(400, "مفيش وصفة أساسية تتنسخ");
    }

    const created: string[] = [];
    const skipped: string[] = [];
    for (const variantId of variantIds) {
      const existing = await db.recipe.findFirst({ where: { productId, variantId } });
      if (existing && !overwrite) { skipped.push(variantId); continue; }

      await db.$transaction(async (tx) => {
        const target = existing
          ? await tx.recipe.update({
              where: { id: existing.id },
              data: {
                updatedById: session.id,
                // A fresh copy is a fresh draft, whatever was confirmed before.
                verifiedById: null, verifiedAt: null, verifiedFingerprint: null,
                notApplicable: false, notApplicableReason: null,
              },
            })
          : await tx.recipe.create({
              data: {
                cafeId: product.cafeId, productId, variantId, createdById: session.id,
              },
            });
        await tx.recipeItem.deleteMany({ where: { recipeId: target.id } });
        await tx.recipeItem.createMany({
          data: source.items.map((i) => ({
            recipeId: target.id,
            inventoryItemId: i.inventoryItemId,
            quantity: i.quantity,
            unit: i.unit,
            wastePercentage: i.wastePercentage,
          })),
        });
      });
      created.push(variantId);
    }

    await audit({
      cafeId: product.cafeId, userId: session.id, action: "RECIPE_COPIED_TO_VARIANTS",
      entity: "Product", entityId: productId,
      details: {
        byName: session.name, productName: product.name,
        copied: created.length, skipped: skipped.length,
        note: "drafts — not confirmed",
      },
    });

    return NextResponse.json({ copied: created, skipped, confirmed: false });
  } catch (error) {
    return handleApiError(error);
  }
}
