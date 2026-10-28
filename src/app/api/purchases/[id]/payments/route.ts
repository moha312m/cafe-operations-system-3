import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { lockPurchaseInvoice } from "@/lib/transaction-locks";
import { money, moneyMax } from "@/lib/money";
import { paymentStatusFor } from "@/lib/purchases";
import type { SessionUser } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  amount: z.number().positive("مبلغ الدفعة يجب أن يكون أكبر من صفر"),
  method: z.enum(["CASH", "CARD", "WALLET", "BANK_TRANSFER"]),
  note: z.string().max(300).optional(),
});

// The operation key is scoped to the invoice's own café and branch, and the
// same visibility rules as before decide who may pay it.
async function invoiceRequestScope(tx: Prisma.TransactionClient, session: SessionUser, id: string) {
  const inv = await tx.purchaseInvoice.findUnique({ where: { id }, select: { cafeId: true, branchId: true } });
  if (!inv) throw new ApiError(404, "الفاتورة غير موجودة");
  if (session.role !== "SUPER_ADMIN" && inv.cafeId !== session.cafeId) {
    throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
  }
  if (session.branchId && inv.branchId !== session.branchId) {
    throw new ApiError(403, "الفاتورة تبع فرع تاني");
  }
  return requestScope({ ...session, cafeId: inv.cafeId, branchId: inv.branchId }, `POST /api/purchases/${id}/payments`);
}

// POST /api/purchases/[id]/payments — record a supplier payment (cash out).
// Every decision is taken on the locked invoice row, the request is keyed so
// a retry cannot pay twice, and the audit row commits with the payment.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("purchases.record_payment");
    await requireFeature(session, "purchasesEnabled");
    const { id } = await params;
    const data = bodySchema.parse(await request.json());
    const scope = session.role === "SUPER_ADMIN" ? {} : { cafeId: session.cafeId ?? undefined, branchId: session.branchId ?? undefined };

    return await withIdempotency(request, (tx) => invoiceRequestScope(tx, session, id), data, async (tx) => {
      await lockPurchaseInvoice(tx, id);
      const inv = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id } });
      if (inv.status === "CANCELLED") throw new ApiError(400, "الفاتورة ملغية");

      const total = money(inv.totalAmount);
      const paid = money(inv.paidAmount);
      const remaining = moneyMax(total.minus(paid), 0);
      if (remaining.lte(0)) throw new ApiError(400, "الفاتورة مدفوعة بالكامل");
      const amount = money(data.amount);
      if (amount.gt(remaining)) throw new ApiError(400, "مبلغ الدفعة أكبر من المتبقي");

      const newPaid = money(paid.plus(amount));
      const newRemaining = moneyMax(total.minus(newPaid), 0);
      const newStatus = paymentStatusFor(total.toNumber(), newPaid.toNumber());

      const payment = await tx.purchasePayment.create({
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
      await auditInTransaction(tx, {
        cafeId: inv.cafeId, userId: session.id, action: "PURCHASE_PAYMENT_RECORDED",
        entity: "PurchaseInvoice", entityId: id,
        details: {
          branchId: inv.branchId, purchaseInvoiceId: id, paymentId: payment.id,
          amount: amount.toNumber(), method: data.method,
          oldValue: { paid: paid.toNumber(), remaining: remaining.toNumber() },
          newValue: { paid: newPaid.toNumber(), remaining: newRemaining.toNumber(), status: newStatus },
        },
      });

      return NextResponse.json({ paidAmount: newPaid.toNumber(), remainingAmount: newRemaining.toNumber(), paymentStatus: newStatus });
    }, { scope });
  } catch (error) {
    return handleApiError(error);
  }
}
