import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { serializeCustomer } from "@/lib/customers";

type Params = { params: Promise<{ id: string }> };

const DENIED = "ليس لديك صلاحية للوصول لبيانات العملاء";

// GET /api/customers/[id] — profile + recent orders + points ledger.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("customers.view", DENIED);
    const { id } = await params;
    const customer = await db.customer.findFirst({
      // cafeId filter = tenant isolation, even with a leaked id.
      where: { id, cafeId: session.cafeId ?? "" },
      include: {
        orders: {
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true, orderNumber: true, type: true, status: true, paymentStatus: true,
            total: true, loyaltyPointsEarned: true, loyaltyPointsRedeemed: true, createdAt: true,
          },
        },
        loyaltyTxns: {
          orderBy: { createdAt: "desc" },
          take: 30,
          include: {
            createdBy: { select: { name: true } },
            order: { select: { orderNumber: true } },
          },
        },
      },
    });
    if (!customer) throw new ApiError(404, "العميل غير موجود");

    return NextResponse.json({
      customer: serializeCustomer(customer),
      orders: customer.orders.map((o) => ({ ...o, total: Number(o.total) })),
      transactions: customer.loyaltyTxns.map((t) => ({
        id: t.id,
        type: t.type,
        points: t.points,
        amountValue: t.amountValue === null ? null : Number(t.amountValue),
        note: t.note,
        orderNumber: t.order?.orderNumber ?? null,
        createdBy: t.createdBy?.name ?? null,
        createdAt: t.createdAt,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email("بريد إلكتروني غير صحيح").optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
});

// PATCH /api/customers/[id] — edit profile / deactivate.
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("customers.edit", DENIED);
    const { id } = await params;
    const data = patchSchema.parse(await request.json());

    const existing = await db.customer.findFirst({
      where: { id, cafeId: session.cafeId ?? "" },
    });
    if (!existing) throw new ApiError(404, "العميل غير موجود");

    const updated = await db.customer.update({
      where: { id: existing.id },
      data: {
        name: data.name !== undefined ? data.name || null : undefined,
        email: data.email !== undefined ? data.email || null : undefined,
        notes: data.notes !== undefined ? data.notes || null : undefined,
        isActive: data.isActive,
      },
    });

    await audit({
      cafeId: existing.cafeId,
      userId: session.id,
      action: "CUSTOMER_UPDATED",
      entity: "Customer",
      entityId: existing.id,
      details: {
        customerId: existing.id,
        oldValue: { name: existing.name, email: existing.email, notes: existing.notes, isActive: existing.isActive },
        newValue: { name: updated.name, email: updated.email, notes: updated.notes, isActive: updated.isActive },
      },
    });

    return NextResponse.json({ customer: serializeCustomer(updated) });
  } catch (error) {
    return handleApiError(error);
  }
}
