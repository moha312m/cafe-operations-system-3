import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, resolveCafeId, handleApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  try {
    const session = await requirePermission("menu:read");
    const cafeId = resolveCafeId(
      session,
      request.nextUrl.searchParams.get("cafeId")
    );
    const categories = await db.menuCategory.findMany({
      where: { cafeId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { _count: { select: { products: true } } },
    });
    return NextResponse.json({ categories });
  } catch (error) {
    return handleApiError(error);
  }
}

const createCategorySchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().default(0),
  showInCustomerMenu: z.boolean().default(true),
  cafeId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("menu:manage");
    const data = createCategorySchema.parse(await request.json());
    const cafeId = resolveCafeId(session, data.cafeId);

    const category = await db.menuCategory.create({
      data: {
        cafeId,
        name: data.name,
        sortOrder: data.sortOrder,
        showInCustomerMenu: data.showInCustomerMenu,
      },
    });

    await audit({
      cafeId,
      userId: session.id,
      action: "category.create",
      entity: "MenuCategory",
      entityId: category.id,
      details: { name: category.name },
    });

    return NextResponse.json({ category }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
