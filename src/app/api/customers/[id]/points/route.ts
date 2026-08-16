import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { serializeCustomer } from "@/lib/customers";

type Params = { params: Promise<{ id: string }> };

const adjustSchema = z.object({
  delta: z.number().int().refine((v) => v !== 0, "عدد النقاط لا يمكن أن يكون صفر"),
  note: z.string().trim().max(300).optional(),
});

// POST /api/customers/[id]/points — manual add/subtract with a ledger row.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("customers.adjust_points", "ليس لديك صلاحية لتعديل نقاط العملاء");
    const { id } = await params;
    const data = adjustSchema.parse(await request.json());

    const customer = await db.customer.findFirst({
      where: { id, cafeId: session.cafeId ?? "" },
    });
    if (!customer) throw new ApiError(404, "العميل غير موجود");
    if (data.delta < 0 && customer.loyaltyPointsBalance + data.delta < 0) {
      throw new ApiError(400, "لا يوجد رصيد نقاط كافي");
    }

    const [, updated] = await db.$transaction([
      db.loyaltyTransaction.create({
        data: {
          cafeId: customer.cafeId,
          customerId: customer.id,
          type: data.delta > 0 ? "ADJUSTMENT_ADD" : "ADJUSTMENT_SUBTRACT",
          points: data.delta,
          note: data.note || "تعديل يدوي",
          createdByUserId: session.id,
        },
      }),
      db.customer.update({
        where: { id: customer.id },
        data: {
          loyaltyPointsBalance: { increment: data.delta },
          ...(data.delta > 0
            ? { lifetimePointsEarned: { increment: data.delta } }
            : { lifetimePointsRedeemed: { increment: -data.delta } }),
        },
      }),
    ]);

    await audit({
      cafeId: customer.cafeId,
      userId: session.id,
      action: "LOYALTY_POINTS_ADJUSTED",
      entity: "Customer",
      entityId: customer.id,
      details: {
        customerId: customer.id,
        oldValue: { balance: customer.loyaltyPointsBalance },
        newValue: { balance: updated.loyaltyPointsBalance, delta: data.delta, note: data.note ?? null },
      },
    });

    return NextResponse.json({ customer: serializeCustomer(updated) });
  } catch (error) {
    return handleApiError(error);
  }
}
