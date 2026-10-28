import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { auditInTransaction } from "@/lib/audit";
import { withIdempotency, requestScope } from "@/lib/idempotency";
import { lockPurchaseInvoice, lockShifts } from "@/lib/transaction-locks";
import { money, moneyMax } from "@/lib/money";
import { paymentStatusFor, fundingMethodError, FUNDING_SOURCES } from "@/lib/purchases";
import { requireCashCustody, recomputeShiftTotals } from "@/lib/shifts";
import type { SessionUser } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  amount: z.number().positive("مبلغ الدفعة يجب أن يكون أكبر من صفر"),
  method: z.enum(["CASH", "CARD", "WALLET", "BANK_TRANSFER"]),
  note: z.string().max(300).optional(),
  // Optional for older clients, which record an unspecified source.
  fundingSource: z.enum(FUNDING_SOURCES).optional(),
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
//
// A DRAWER payment is cash out of the payer's own open drawer in the
// invoice's branch — the same custody rule as collecting into it. The shift
// is locked before the invoice (lock rank order), must still be OPEN under
// that lock (a racing close waits or wins), and cannot pay out more than
// the drawer is expected to hold.
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("purchases.record_payment");
    await requireFeature(session, "purchasesEnabled");
    const { id } = await params;
    const data = bodySchema.parse(await request.json());
    const scope = session.role === "SUPER_ADMIN" ? {} : { cafeId: session.cafeId ?? undefined, branchId: session.branchId ?? undefined };

    const fundingError = data.fundingSource ? fundingMethodError(data.fundingSource, data.method) : null;
    if (fundingError) throw new ApiError(400, fundingError);

    return await withIdempotency(request, (tx) => invoiceRequestScope(tx, session, id), data, async (tx) => {
      let shiftId: string | null = null;
      if (data.fundingSource === "DRAWER") {
        const { branchId } = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id }, select: { branchId: true } });
        const shift = await requireCashCustody(branchId, session.id, "الدفع من الدرج محتاج شيفت مفتوح باسمك في نفس الفرع", tx);
        await lockShifts(tx, [shift.id]);
        shiftId = shift.id;
      }
      await lockPurchaseInvoice(tx, id);
      const inv = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id } });
      if (inv.status === "CANCELLED") throw new ApiError(400, "الفاتورة ملغية");

      const total = money(inv.totalAmount);
      const paid = money(inv.paidAmount);
      const remaining = moneyMax(total.minus(paid), 0);
      if (remaining.lte(0)) throw new ApiError(400, "الفاتورة مدفوعة بالكامل");
      const amount = money(data.amount);
      if (amount.gt(remaining)) throw new ApiError(400, "مبلغ الدفعة أكبر من المتبقي");

      if (shiftId) {
        // Fresh under the lock: the drawer's own authoritative figure.
        const drawer = await recomputeShiftTotals(shiftId, tx);
        if (drawer?.status !== "OPEN") throw new ApiError(409, "الشيفت اتقفل — الدفع من الدرج مش ممكن");
        if (amount.gt(money(drawer.expectedCashAmount))) throw new ApiError(400, "الكاش المتوقع في الدرج أقل من مبلغ الدفعة");
      }

      const newPaid = money(paid.plus(amount));
      const newRemaining = moneyMax(total.minus(newPaid), 0);
      const newStatus = paymentStatusFor(total.toNumber(), newPaid.toNumber());

      const payment = await tx.purchasePayment.create({
        data: {
          cafeId: inv.cafeId, branchId: inv.branchId, purchaseInvoiceId: id,
          amount, method: data.method, note: data.note || null,
          fundingSource: data.fundingSource ?? null, shiftId,
          createdByUserId: session.id,
        },
      });
      if (shiftId) await recomputeShiftTotals(shiftId, tx);
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
          fundingSource: data.fundingSource ?? null, shiftId,
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
