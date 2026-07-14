import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

const productInclude = {
  category: { select: { id: true, name: true } },
  variants: {
    orderBy: [{ sortOrder: "asc" as const }, { price: "asc" as const }],
  },
  addOns: { include: { addOn: true } },
  branchPrices: { select: { branchId: true, price: true } },
};

async function findOwnedProduct(id: string, session: { role: string; cafeId: string | null }) {
  const product = await db.product.findUnique({ where: { id } });
  if (!product) throw new ApiError(404, "Product not found");
  if (session.role !== "SUPER_ADMIN" && product.cafeId !== session.cafeId) {
    throw new ApiError(403, "Not allowed");
  }
  return product;
}

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  categoryId: z.string().optional(),
  basePrice: z.number().min(0).optional(),
  costPrice: z.number().min(0).nullable().optional(),
  imageUrl: z.string().url().nullable().optional().or(z.literal("")),
  isActive: z.boolean().optional(),
  showInCustomerMenu: z.boolean().optional(),
  showInPOS: z.boolean().optional(),
  isAvailable: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  // Full replacement lists; omit to leave untouched.
  variants: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.number().min(0),
        isAvailable: z.boolean().default(true),
        sortOrder: z.number().int().default(0),
      })
    )
    .optional(),
  addOnIds: z.array(z.string()).optional(),
  branchPrices: z
    .array(z.object({ branchId: z.string(), price: z.number().min(0) }))
    .optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("menu:manage");
    const { id } = await params;
    const existing = await findOwnedProduct(id, session);

    const data = updateProductSchema.parse(await request.json());

    if (data.categoryId) {
      const category = await db.menuCategory.findFirst({
        where: { id: data.categoryId, cafeId: existing.cafeId },
      });
      if (!category) throw new ApiError(400, "Category not found in this cafe");
    }
    if (data.addOnIds && data.addOnIds.length > 0) {
      const count = await db.addOn.count({
        where: { id: { in: data.addOnIds }, cafeId: existing.cafeId },
      });
      if (count !== data.addOnIds.length) {
        throw new ApiError(400, "One or more add-ons not found in this cafe");
      }
    }
    if (data.branchPrices && data.branchPrices.length > 0) {
      const count = await db.branch.count({
        where: {
          id: { in: data.branchPrices.map((b) => b.branchId) },
          cafeId: existing.cafeId,
        },
      });
      if (count !== data.branchPrices.length) {
        throw new ApiError(400, "One or more branches not found in this cafe");
      }
    }

    const product = await db.$transaction(async (tx) => {
      if (data.variants) {
        await tx.productVariant.deleteMany({ where: { productId: id } });
      }
      if (data.addOnIds) {
        await tx.productAddOn.deleteMany({ where: { productId: id } });
      }
      if (data.branchPrices) {
        await tx.productBranchPrice.deleteMany({ where: { productId: id } });
      }
      return tx.product.update({
        where: { id },
        data: {
          name: data.name,
          description: data.description,
          categoryId: data.categoryId,
          basePrice: data.basePrice,
          costPrice: data.costPrice,
          imageUrl: data.imageUrl === "" ? null : data.imageUrl,
          isActive: data.isActive,
          showInCustomerMenu: data.showInCustomerMenu,
          showInPOS: data.showInPOS,
          isAvailable: data.isAvailable,
          sortOrder: data.sortOrder,
          ...(data.variants
            ? {
                variants: {
                  create: data.variants.map((v, i) => ({
                    name: v.name,
                    price: v.price,
                    isActive: v.isAvailable,
                    sortOrder: v.sortOrder || i,
                  })),
                },
              }
            : {}),
          ...(data.addOnIds
            ? { addOns: { create: data.addOnIds.map((addOnId) => ({ addOnId })) } }
            : {}),
          ...(data.branchPrices
            ? { branchPrices: { create: data.branchPrices } }
            : {}),
        },
        include: productInclude,
      });
    });

    // Price changes get their own dedicated audit trail entry.
    const oldPrice = Number(existing.basePrice);
    if (data.basePrice !== undefined && data.basePrice !== oldPrice) {
      await audit({
        cafeId: existing.cafeId,
        userId: session.id,
        action: "PRODUCT_PRICE_CHANGED",
        entity: "Product",
        entityId: id,
        details: {
          productName: product.name,
          oldPrice,
          newPrice: data.basePrice,
          currency: "EGP",
        },
      });
    }

    await audit({
      cafeId: existing.cafeId,
      userId: session.id,
      action: "product.update",
      entity: "Product",
      entityId: id,
      details: { name: product.name },
    });

    return NextResponse.json({ product });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("menu:manage");
    const { id } = await params;
    const product = await findOwnedProduct(id, session);

    await db.product.delete({ where: { id } });

    await audit({
      cafeId: product.cafeId,
      userId: session.id,
      action: "product.delete",
      entity: "Product",
      entityId: id,
      details: { name: product.name },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
