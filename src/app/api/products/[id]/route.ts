import { stockBindingsSchema, saveProductStockBindings } from "@/lib/product-stock-bindings";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { requireCatalogPriceAuthority } from "@/lib/price-authorization";
import { validCurrencyInput } from "@/lib/money";

type Params = { params: Promise<{ id: string }> };

const productInclude = {
  stockBindings: true,
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
  stockMode: z.enum(["RECIPE", "FINISHED_GOOD"]).optional(),
  stockBindings: stockBindingsSchema.optional(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  categoryId: z.string().optional(),
  basePrice: z.number().min(0).refine(validCurrencyInput, "Invalid currency amount").optional(),
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
        id: z.string().optional(),
        name: z.string().min(1),
        price: z.number().min(0).refine(validCurrencyInput, "Invalid currency amount"),
        isAvailable: z.boolean().default(true),
        sortOrder: z.number().int().default(0),
      })
    )
    .optional(),
  addOnIds: z.array(z.string()).optional(),
  branchPrices: z
    .array(z.object({ branchId: z.string(), price: z.number().min(0).refine(validCurrencyInput, "Invalid currency amount") }))
    .optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("menu:manage");
    const { id } = await params;
    const existing = await findOwnedProduct(id, session);

    const data = updateProductSchema.parse(await request.json());
    if (data.basePrice !== undefined || data.variants !== undefined || data.branchPrices !== undefined) {
      await requireCatalogPriceAuthority(session, existing.cafeId);
    }

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
      await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id"=${id} FOR UPDATE`;
      if (data.variants) {
        const ids = data.variants.flatMap(v => v.id ? [v.id] : []);
        if (new Set(ids).size !== ids.length || await tx.productVariant.count({ where: { id: { in: ids }, productId: id } }) !== ids.length) throw new ApiError(400, "حجم خارج المنتج أو مكرر");
        await tx.productVariant.deleteMany({ where: { productId: id, id: { notIn: ids } } });
        for (const [i,v] of data.variants.entries()) {
          const values = { name: v.name, price: v.price, isActive: v.isAvailable, sortOrder: v.sortOrder || i };
          if (v.id) await tx.productVariant.update({ where: { id: v.id }, data: values });
          else await tx.productVariant.create({ data: { ...values, productId: id } });
        }
      }
      if (data.stockBindings) await saveProductStockBindings(tx, id, existing.cafeId, data.stockBindings, session.branchId);
      if (data.addOnIds) {
        await tx.productAddOn.deleteMany({ where: { productId: id } });
      }
      if (data.branchPrices) {
        await tx.productBranchPrice.deleteMany({ where: { productId: id } });
      }
      return tx.product.update({
        where: { id },
        data: {
          stockMode: data.stockMode,
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
          ...(data.addOnIds
            ? { addOns: { create: data.addOnIds.map((addOnId) => ({ addOnId })) } }
            : {}),
          ...(data.branchPrices
            ? { branchPrices: { create: data.branchPrices } }
            : {}),
        },
        include: { ...productInclude, stockBindings: { where: session.branchId ? { branchId: session.branchId } : {} } },
      });
    });

    // Price changes get their own dedicated audit trail entry.
    if (data.variants !== undefined || data.branchPrices !== undefined) {
      await audit({ cafeId: existing.cafeId, userId: session.id, action: "CATALOG_PRICES_CHANGED", entity: "Product", entityId: id,
        details: { variantsChanged: data.variants !== undefined, branchOverridesChanged: data.branchPrices !== undefined } });
    }
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
