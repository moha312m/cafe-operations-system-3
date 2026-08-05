import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { audit } from "@/lib/audit";
import { round2, paymentStatusFor } from "@/lib/purchases";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  amount: z.number().positive("مبلغ الدفعة يجب أن يكون أكبر من صفر"),
  method: z.enum(["CASH", "CARD", "WALLET", "BANK_TRANSFER"]),
  note: z.string().max(300).optional(),
});

// POST /api/purchases/[id]/payments — record a supplier payment (cash out).
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("purchases.record_payment");
    await requireFeature(session, "purchasesEnabled");
    const { id } = await params;
    const data = bodySchema.parse(await request.json());

    const inv = await db.purchaseInvoice.findUnique({ where: { id } });
    if (!inv) throw new ApiError(404, "الفاتورة غير موجودة");
    if (session.role !== "SUPER_ADMIN" && inv.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && inv.branchId !== session.branchId) {
      throw new ApiError(403, "الفاتورة تبع فرع تاني");
    }
    if (inv.status === "CANCELLED") throw new ApiError(400, "الفاتورة ملغية");

    const remaining = Number(inv.remainingAmount);
    if (remaining <= 0.001) throw new ApiError(400, "الفاتورة مدفوعة بالكامل");
    const amount = round2(data.amount);
    if (amount > remaining + 0.001) throw new ApiError(400, "مبلغ الدفعة أكبر من المتبقي");

    const newPaid = round2(Number(inv.paidAmount) + amount);
    const newRemaining = Math.max(round2(Number(inv.totalAmount) - newPaid), 0);
    const newStatus = paymentStatusFor(Number(inv.totalAmount), newPaid);

    const payment = await db.$transaction(async (tx) => {
      const p = await tx.purchasePayment.create({
        data: {
          cafeId: inv.cafeId, branchId: inv.branchId, purchaseInvoiceId: id,
          amount, method: data.method, note: data.note || null,
          createdByUserId: session.id,
        },
      });
      await tx.purchaseInvoice.update({
        where: { id },
        data: { paidAmount: newPaid, remainingAmount: newRemaining, paymentStatus: newStatus },
      });
      return p;
    });

    await audit({
      cafeId: inv.cafeId, userId: session.id, action: "PURCHASE_PAYMENT_RECORDED",
      entity: "PurchaseInvoice", entityId: id,
      details: {
        branchId: inv.branchId, purchaseInvoiceId: id, paymentId: payment.id,
        amount, method: data.method,
        oldValue: { paid: Number(inv.paidAmount), remaining }, newValue: { paid: newPaid, remaining: newRemaining, status: newStatus },
      },
    });

    return NextResponse.json({ paidAmount: newPaid, remainingAmount: newRemaining, paymentStatus: newStatus });
  } catch (error) {
    return handleApiError(error);
  }
}
