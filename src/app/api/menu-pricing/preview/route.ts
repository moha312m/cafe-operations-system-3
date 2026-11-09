import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  resolveCafeId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { hasPermission } from "@/lib/permissions";
import { configurationFinancials } from "@/lib/recipes";
import {
  suggestPrice,
  isValidMultiplier,
  isValidRoundingStep,
  generatePreviewFingerprint,
  type PreviewFingerprintItem,
  type RoundingMode,
} from "@/lib/menu-pricing";

const previewSchema = z.object({
  cafeId: z.string().optional(),
  referenceBranchId: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  multiplier: z.number().min(0.001).max(100),
  roundingMode: z.enum(["NONE", "NEAREST", "UP"]).default("NONE"),
  roundingStep: z.number().positive().max(1000).nullable().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("menu:read");
    if (!hasPermission(session.role, "cost:read")) {
      throw new ApiError(403, "صلاحية قراءة التكاليف مطلوبة لمعاينة الأسعار");
    }

    const body = previewSchema.parse(await request.json());
    if (!isValidMultiplier(body.multiplier)) {
      throw new ApiError(400, "معامل التسعير غير صالح (يجب أن يكون بين 0.001 و 100 وبحد أقصى 3 منازل عشرية)");
    }
    if (body.roundingMode !== "NONE" && !isValidRoundingStep(body.roundingStep)) {
      throw new ApiError(400, "خطوة التقريب غير صالحة");
    }

    const cafeId = resolveCafeId(session, body.cafeId);

    if (body.referenceBranchId) {
      const branch = await db.branch.findFirst({
        where: { id: body.referenceBranchId, cafeId },
        select: { id: true },
      });
      if (!branch) {
        throw new ApiError(400, "الفرع المرجعي غير موجود في هذه المنشأة");
      }
    }

    const products = await db.product.findMany({
      where: {
        cafeId,
        isActive: true,
        ...(body.categoryId ? { categoryId: body.categoryId } : {}),
      },
      include: {
        category: { select: { id: true, name: true } },
        variants: {
          where: { isActive: true },
          orderBy: [{ sortOrder: "asc" }, { price: "asc" }],
        },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

    const rows = [];
    const fingerprintItems: PreviewFingerprintItem[] = [];

    for (const product of products) {
      if (product.variants.length > 0) {
        // Multi-variant product: calculate per variant independently
        for (const variant of product.variants) {
          const financials = await configurationFinancials({
            productId: product.id,
            variantId: variant.id,
            sellingPrice: Number(variant.price),
            branchId: body.referenceBranchId,
          });

          const currentPrice = Number(variant.price);
          const hasEligibleCost =
            financials.costStatus === "AVAILABLE" &&
            financials.cost !== null &&
            financials.cost > 0;

          let suggested = null;
          if (hasEligibleCost) {
            suggested = suggestPrice(
              financials.cost!,
              body.multiplier,
              body.roundingMode as RoundingMode,
              body.roundingStep
            );

            fingerprintItems.push({
              targetType: "VARIANT",
              targetId: variant.id,
              unitCost: financials.cost!,
              suggestedPrice: suggested.suggestedPrice.toNumber(),
            });
          }

          rows.push({
            targetType: "VARIANT" as const,
            targetKey: `VARIANT:${product.id}:${variant.id}`,
            productId: product.id,
            productName: product.name,
            variantId: variant.id,
            variantName: variant.name,
            targetName: `${product.name} (${variant.name})`,
            categoryName: product.category?.name ?? "",
            costSource: hasEligibleCost ? ("RECIPE" as const) : ("NONE" as const),
            costStatus: financials.costStatus,
            unitCost: financials.cost,
            currentPrice,
            rawSuggestedPrice: suggested ? suggested.rawPrice.toNumber() : null,
            suggestedPrice: suggested ? suggested.suggestedPrice.toNumber() : null,
            currentProfit: financials.profit,
            currentMargin: financials.margin,
            currentTier: financials.tier,
            suggestedProfit: suggested ? suggested.profit.toNumber() : null,
            suggestedMargin: suggested ? suggested.margin.toNumber() : null,
            suggestedTier: suggested ? suggested.tier : null,
            issues: financials.issues,
          });
        }
      } else {
        // Single SKU product: calculate from base recipe or direct cost
        const financials = await configurationFinancials({
          productId: product.id,
          variantId: null,
          sellingPrice: Number(product.basePrice),
          branchId: body.referenceBranchId,
        });

        const currentPrice = Number(product.basePrice);
        let eligibleCost: number | null = null;
        let costStatus: string = financials.costStatus;
        let costSource: "RECIPE" | "DIRECT" | "NONE" = "NONE";

        if (financials.costStatus === "AVAILABLE" && financials.cost !== null && financials.cost > 0) {
          eligibleCost = financials.cost;
          costSource = "RECIPE";
        } else if (
          financials.recipeSource === "NONE" &&
          product.costPrice &&
          Number(product.costPrice) > 0
        ) {
          // Direct cost is only allowed if there is NO recipe defined for this product.
          // Missing or incomplete recipes must NOT silently fallback to direct cost.
          eligibleCost = Number(product.costPrice);
          costStatus = "DIRECT_COST";
          costSource = "DIRECT";
        }

        let suggested = null;
        if (eligibleCost !== null && eligibleCost > 0) {
          suggested = suggestPrice(
            eligibleCost,
            body.multiplier,
            body.roundingMode as RoundingMode,
            body.roundingStep
          );

          fingerprintItems.push({
            targetType: "PRODUCT",
            targetId: product.id,
            unitCost: eligibleCost,
            suggestedPrice: suggested.suggestedPrice.toNumber(),
          });
        }

        rows.push({
          targetType: "PRODUCT" as const,
          targetKey: `PRODUCT:${product.id}`,
          productId: product.id,
          productName: product.name,
          variantId: null,
          variantName: null,
          targetName: product.name,
          categoryName: product.category?.name ?? "",
          costSource,
          costStatus,
          unitCost: eligibleCost,
          currentPrice,
          rawSuggestedPrice: suggested ? suggested.rawPrice.toNumber() : null,
          suggestedPrice: suggested ? suggested.suggestedPrice.toNumber() : null,
          currentProfit: financials.profit,
          currentMargin: financials.margin,
          currentTier: financials.tier,
          suggestedProfit: suggested ? suggested.profit.toNumber() : null,
          suggestedMargin: suggested ? suggested.margin.toNumber() : null,
          suggestedTier: suggested ? suggested.tier : null,
          issues: financials.issues,
        });
      }
    }

    const previewFingerprint = generatePreviewFingerprint({
      cafeId,
      referenceBranchId: body.referenceBranchId ?? null,
      multiplier: body.multiplier,
      roundingMode: body.roundingMode as RoundingMode,
      roundingStep: body.roundingStep ?? null,
      items: fingerprintItems,
    });

    return NextResponse.json({
      rows,
      previewFingerprint,
      totalCount: rows.length,
      eligibleCount: fingerprintItems.length,
      multiplier: body.multiplier,
      roundingMode: body.roundingMode,
      roundingStep: body.roundingStep ?? null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
