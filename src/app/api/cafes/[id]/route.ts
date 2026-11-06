import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePermission, handleApiError, ApiError } from "@/lib/api";
import { isSupportedCurrency } from "@/lib/currency";
import { mapCurrencyDatabaseError } from "@/lib/branch-currency";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("cafe:manage");
    const { id } = await params;
    if (session.role !== "SUPER_ADMIN" && session.cafeId !== id) {
      throw new ApiError(403, "Not allowed");
    }
    const cafe = await db.cafe.findUnique({
      where: { id },
      include: { branches: { orderBy: { createdAt: "asc" } } },
    });
    if (!cafe) throw new ApiError(404, "Cafe not found");
    return NextResponse.json({ cafe });
  } catch (error) {
    return handleApiError(error);
  }
}

const updateCafeSchema = z.object({
  name: z.string().min(2).optional(),
  currency: z.string().length(3).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  isActive: z.boolean().optional(), // suspend/reactivate — super admin only
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requirePermission("cafe:manage");
    const { id } = await params;
    if (session.role !== "SUPER_ADMIN" && session.cafeId !== id) {
      throw new ApiError(403, "Not allowed");
    }
    const data = updateCafeSchema.parse(await request.json());
    if (data.isActive !== undefined && session.role !== "SUPER_ADMIN") {
      throw new ApiError(403, "Only super admin can suspend a cafe");
    }

    if (data.currency !== undefined) {
      data.currency = data.currency.toUpperCase();
      if (!isSupportedCurrency(data.currency)) throw new ApiError(400, "عملة غير مدعومة حالياً");
      // The owner changes the currency from Settings (audited, idempotent). Platform staff may set it on a cafe
      // that has no financial records yet; the database refuses it once there are any.
      const current = await db.cafe.findUnique({ where: { id }, select: { currency: true } });
      if (current && current.currency !== data.currency && session.role !== "SUPER_ADMIN") {
        throw new ApiError(400, "غيّر العملة من الإعدادات");
      }
    }

    let cafe;
    try {
      cafe = await db.cafe.update({ where: { id }, data });
    } catch (error) {
      mapCurrencyDatabaseError(error);
    }

    await audit({
      cafeId: id,
      userId: session.id,
      action: "cafe.update",
      entity: "Cafe",
      entityId: id,
      details: data,
    });

    return NextResponse.json({ cafe });
  } catch (error) {
    return handleApiError(error);
  }
}
