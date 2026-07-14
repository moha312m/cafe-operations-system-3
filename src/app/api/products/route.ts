import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  requirePermission,
  resolveCafeId,
  handleApiError,
  ApiError,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { hasPermission } from "@/lib/permissions";
import { productCost, profitFor } from "@/lib/costing";

const productInclude = {
  category: { select: { id: true, name: true } },
  variants: {
    orderBy: [{ sortOrder: "asc" as const }, { price: "asc" as const }],
  },
  addOns: { include: { addOn: true } },
  branchPrices: { select: { branchId: true, price: true } },
};

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("menu:read");
    const cafeId = resolveCafeId(
      session,
      request.nextUrl.searchParams.get("cafeId")
    );

    // Cost/profit data is only attached for roles allowed to see it
    // (owner/manager/inventory). Cashier/waiter/barista never receive it.
    const showCost = hasPermission(session.role, "cost:read");

    const products = await db.product.findMany({
      where: { cafeId },
      include: showCost
        ? {
            ...productInclude,
            recipeItems: {
              include: {
                inventoryItem: { select: { unit: true, costPerUnit: true } },
              },
            },
          }
        : productInclude,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

    if (!showCost) return NextResponse.json({ products });

    // Attach cost/profit and strip the raw recipe rows from the payload.
    const enriched = products.map((p) => {
      const recipe = (p as typeof p & { recipeItems: Parameters<typeof productCost>[0] })
        .recipeItems;
      const hasRecipe = recipe.length > 0;
      const cost = productCost(recipe);
      const profit = profitFor(Number(p.basePrice), cost, hasRecipe);
      const { recipeItems: _drop, ...rest } = p as typeof p & { recipeItems: unknown };
      void _drop;
      return { ...rest, hasRecipe, ...profit };
    });

    return NextResponse.json({ products: enriched, costVisible: true });
  } catch (error) {
    return handleApiError(error);
  }
}

const variantSchema = z.object({
  name: z.string().min(1),
  price: z.number().min(0), // absolute سعر الحجم
  isAvailable: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  categoryId: z.string(),
  basePrice: z.number().min(0),
  costPrice: z.number().min(0).nullable().optional(),
  imageUrl: z.string().url().optional().or(z.literal("")),
  showInCustomerMenu: z.boolean().default(true),
  showInPOS: z.boolean().default(true),
  isAvailable: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  variants: z.array(variantSchema).default([]),
  addOnIds: z.array(z.string()).default([]),
  branchPrices: z
    .array(z.object({ branchId: z.string(), price: z.number().min(0) }))
    .default([]),
  cafeId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("menu:manage");
    const data = createProductSchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    // Category, add-ons, and branches must belong to the same tenant.
    const category = await db.menuCategory.findFirst({
      where: { id: data.categoryId, cafeId },
    });
    if (!category) throw new ApiError(400, "Category not found in this cafe");
    if (data.addOnIds.length > 0) {
      const count = await db.addOn.count({
        where: { id: { in: data.addOnIds }, cafeId },
      });
      if (count !== data.addOnIds.length) {
        throw new ApiError(400, "One or more add-ons not found in this cafe");
      }
    }
    if (data.branchPrices.length > 0) {
      const count = await db.branch.count({
        where: { id: { in: data.branchPrices.map((b) => b.branchId) }, cafeId },
      });
      if (count !== data.branchPrices.length) {
        throw new ApiError(400, "One or more branches not found in this cafe");
      }
    }

    const product = await db.product.create({
      data: {
        cafeId,
        categoryId: data.categoryId,
        name: data.name,
        description: data.description,
        basePrice: data.basePrice,
        costPrice: data.costPrice ?? null,
        imageUrl: data.imageUrl || null,
        showInCustomerMenu: data.showInCustomerMenu,
        showInPOS: data.showInPOS,
        isAvailable: data.isAvailable,
        sortOrder: data.sortOrder,
        variants: {
          create: data.variants.map((v, i) => ({
            name: v.name,
            price: v.price,
            isActive: v.isAvailable,
            sortOrder: v.sortOrder || i,
          })),
        },
        addOns: { create: data.addOnIds.map((addOnId) => ({ addOnId })) },
        branchPrices: { create: data.branchPrices },
      },
      include: productInclude,
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "product.create",
      entity: "Product",
      entityId: product.id,
      details: { name: product.name, basePrice: data.basePrice },
    });

    return NextResponse.json({ product }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
