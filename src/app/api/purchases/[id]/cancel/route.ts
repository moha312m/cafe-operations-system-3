import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireKey, handleApiError, ApiError, requireFeature } from "@/lib/api";
import { audit } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// POST /api/purchases/[id]/cancel — cancel an invoice. Confirmed invoices are
// NOT auto-reversed out of stock (that would need a return); the stock stays,
// but the invoice is marked cancelled so it drops out of purchase totals.
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const session = await requireKey("purchases.cancel");
    await requireFeature(session, "purchasesEnabled");
    const { id } = await params;

    const inv = await db.purchaseInvoice.findUnique({ where: { id } });
    if (!inv) throw new ApiError(404, "الفاتورة غير موجودة");
    if (session.role !== "SUPER_ADMIN" && inv.cafeId !== session.cafeId) {
      throw new ApiError(403, "ليس لديك صلاحية لتنفيذ هذا الإجراء");
    }
    if (session.branchId && inv.branchId !== session.branchId) {
      throw new ApiError(403, "الفاتورة تبع فرع تاني");
    }
    if (inv.status === "CANCELLED") throw new ApiError(400, "الفاتورة ملغية بالفعل");

    await db.purchaseInvoice.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await audit({
      cafeId: inv.cafeId, userId: session.id, action: "PURCHASE_INVOICE_CANCELLED",
      entity: "PurchaseInvoice", entityId: id,
      details: { branchId: inv.branchId, purchaseInvoiceId: id, invoiceNumber: inv.invoiceNumber, oldValue: inv.status, newValue: "CANCELLED", wasConfirmed: inv.status === "CONFIRMED" },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
