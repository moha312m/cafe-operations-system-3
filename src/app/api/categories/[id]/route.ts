import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

async function findOwnedCategory(id: string, session: { role: string; cafeId: string | null }) {
  const category = await db.menuCategory.findUnique({ where: { id } });
  if (!category) throw new ApiError(404, "Category not found");
  if (session.role !== "SUPER_ADMIN" && category.cafeId !== session.cafeId) {
    throw new ApiError(403, "Not allowed");
  }
  return category;
}

const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  showInCustomerMenu: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("menu:manage");
    const { id } = await params;
    const category = await findOwnedCategory(id, session);

    const data = updateCategorySchema.parse(await request.json());
    const updated = await db.menuCategory.update({ where: { id }, data });

    await audit({
      cafeId: category.cafeId,
      userId: session.id,
      action: "category.update",
      entity: "MenuCategory",
      entityId: id,
      details: data,
    });

    return NextResponse.json({ category: updated });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("menu:manage");
    const { id } = await params;
    const category = await findOwnedCategory(id, session);

    await db.menuCategory.delete({ where: { id } });

    await audit({
      cafeId: category.cafeId,
      userId: session.id,
      action: "category.delete",
      entity: "MenuCategory",
      entityId: id,
      details: { name: category.name },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
