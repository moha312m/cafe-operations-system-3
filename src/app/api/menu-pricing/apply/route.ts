import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  requirePermission,
  resolveCafeId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { requireCatalogPriceAuthority } from "@/lib/price-authorization";
import { validCurrencyInput } from "@/lib/money";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { auditInTransaction } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

const applyItemSchema = z.object({
  targetType: z.enum(["PRODUCT", "VARIANT"]),
  productId: z.string().min(1),
  variantId: z.string().nullable().optional(),
  newPrice: z
    .number()
    .min(0)
    .refine(validCurrencyInput, "Invalid currency amount"),
  currentPrice: z.number().min(0).optional(),
});

const applySchema = z.object({
  cafeId: z.string().optional(),
  intentKey: z.string().min(8).max(128).optional(),
  previewFingerprint: z.string().optional(),
  items: z.array(applyItemSchema).min(1).max(100),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("menu:manage");
    const rawBody = await request.json();
    const data = applySchema.parse(rawBody);
    const cafeId = resolveCafeId(session, data.cafeId);

    // Require price editing authority for the catalog
    await requireCatalogPriceAuthority(session, cafeId);

    // Idempotency key handling: accepts header or body intentKey
    const headerKey = request.headers.get("Idempotency-Key")?.trim();
    const effectiveKey = headerKey || data.intentKey;

    if (!effectiveKey || effectiveKey.length < 8 || effectiveKey.length > 128) {
      throw new ApiError(400, "مفتاح العملية مطلوب، من ٨ إلى ١٢٨ حرف");
    }

    if (headerKey && data.intentKey && headerKey !== data.intentKey) {
      throw new ApiError(400, "مفتاح العملية في الطلب مختلف عن المرسل في العنوان");
    }

    // Build effective request with Idempotency-Key header populated
    const effectiveRequest = headerKey
      ? request
      : new Request(request.url, {
          method: request.method,
          headers: new Headers({
            ...Object.fromEntries(request.headers.entries()),
            "Idempotency-Key": effectiveKey,
          }),
        });

    const scope = requestScope(session, "POST /api/menu-pricing/apply");

    return await withIdempotency(
      effectiveRequest,
      scope,
      { cafeId, items: data.items, previewFingerprint: data.previewFingerprint },
      async (tx: Prisma.TransactionClient) => {
        // Structural validation per item
        for (const item of data.items) {
          if (item.targetType === "VARIANT" && !item.variantId) {
            throw new ApiError(400, "معرف الحجم مطلوب لتسعير الأحجام");
          }
          if (item.targetType === "PRODUCT" && item.variantId) {
            throw new ApiError(400, "لا يمكن تمرير معرف حجم مع تسعير المنتج الأساسي");
          }
        }

        // Collect unique IDs to lock
        const productIds = Array.from(new Set(data.items.map((i) => i.productId)));
        const variantIds = Array.from(
          new Set(
            data.items
              .filter((i) => i.targetType === "VARIANT" && i.variantId)
              .map((i) => i.variantId!)
          )
        );

        // Deterministic lock on products within tenant scope
        if (productIds.length > 0) {
          const lockedProducts = await tx.$queryRaw<{ id: string; cafeId: string; activeVariantCount: number }[]>`
            SELECT p."id", p."cafeId",
                   (SELECT COUNT(*)::int FROM "ProductVariant" pv WHERE pv."productId" = p."id" AND pv."isActive" = true) as "activeVariantCount"
            FROM "Product" p
            WHERE p."id" = ANY(${productIds}) AND p."cafeId" = ${cafeId} AND p."isActive" = true
            FOR UPDATE
          `;
          if (lockedProducts.length !== productIds.length) {
            throw new ApiError(400, "واحد أو أكثر من المنتجات غير موجود أو غير نشط في هذه المنشأة");
          }
          var productMap = new Map(lockedProducts.map((p) => [p.id, p]));
        } else {
          var productMap = new Map<string, { id: string; cafeId: string; activeVariantCount: number }>();
        }

        // Deterministic lock on variants with strict tenant isolation via join
        const variantMap = new Map<string, { id: string; productId: string }>();
        if (variantIds.length > 0) {
          const lockedVariants = await tx.$queryRaw<{ id: string; productId: string }[]>`
            SELECT pv."id", pv."productId"
            FROM "ProductVariant" pv
            JOIN "Product" p ON p."id" = pv."productId"
            WHERE pv."id" = ANY(${variantIds})
              AND p."cafeId" = ${cafeId}
              AND pv."isActive" = true
              AND p."isActive" = true
            FOR UPDATE
          `;
          if (lockedVariants.length !== variantIds.length) {
            throw new ApiError(400, "واحد أو أكثر من الأحجام غير موجود أو غير نشط في هذه المنشأة");
          }
          for (const v of lockedVariants) {
            variantMap.set(v.id, v);
          }
        }

        // Invariant checks:
        // 1. Single SKU check: Product.basePrice CANNOT be modified if active variants exist (Branch Shift Invariant)
        // 2. Variant ownership check: Variant must belong to the specified product
        for (const item of data.items) {
          const product = productMap.get(item.productId);
          if (!product) {
            throw new ApiError(400, `المنتج ${item.productId} غير موجود أو خارج نطاق المنشأة`);
          }
          if (item.targetType === "PRODUCT") {
            if (product.activeVariantCount > 0) {
              throw new ApiError(
                400,
                `لا يمكن تعديل سعر الأساس للمنتج ذو الأحجام "${item.productId}" لحماية إزاحة أسعار الفروع`
              );
            }
          } else if (item.targetType === "VARIANT") {
            const variant = variantMap.get(item.variantId!);
            if (!variant || variant.productId !== item.productId) {
              throw new ApiError(
                400,
                `الحجم ${item.variantId} لا ينتمي للمنتج المحدد ${item.productId}`
              );
            }
          }
        }

        // Apply targeted, atomic updates WITHOUT deleteMany or resetting sibling variants
        const updatedSummary: Array<{
          targetType: "PRODUCT" | "VARIANT";
          productId: string;
          variantId: string | null;
          oldPrice: number | null;
          newPrice: number;
        }> = [];

        for (const item of data.items) {
          if (item.targetType === "PRODUCT") {
            await tx.product.update({
              where: { id: item.productId },
              data: { basePrice: item.newPrice },
            });
            updatedSummary.push({
              targetType: "PRODUCT",
              productId: item.productId,
              variantId: null,
              oldPrice: item.currentPrice ?? null,
              newPrice: item.newPrice,
            });
          } else if (item.targetType === "VARIANT" && item.variantId) {
            await tx.productVariant.update({
              where: { id: item.variantId },
              data: { price: item.newPrice },
            });
            updatedSummary.push({
              targetType: "VARIANT",
              productId: item.productId,
              variantId: item.variantId,
              oldPrice: item.currentPrice ?? null,
              newPrice: item.newPrice,
            });
          }
        }

        // Transactional Audit Log
        await auditInTransaction(tx, {
          cafeId,
          userId: session.id,
          action: "MENU_PRICING_APPLIED",
          entity: "Product",
          details: {
            previewFingerprint: data.previewFingerprint ?? null,
            updatedCount: updatedSummary.length,
            items: updatedSummary,
          },
        });

        return NextResponse.json(
          {
            ok: true,
            updatedCount: updatedSummary.length,
            appliedAt: new Date().toISOString(),
          },
          { status: 200 }
        );
      },
      { scope: { cafeId } }
    );
  } catch (error) {
    return handleApiError(error);
  }
}
