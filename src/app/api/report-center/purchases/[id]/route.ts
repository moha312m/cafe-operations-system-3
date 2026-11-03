import { NextResponse } from 'next/server';
import { ApiError, handleApiError } from '@/lib/api';
import { requirePurchaseReportAccess } from '@/lib/purchase-report-access';
import { db } from '@/lib/db';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { scope } = await requirePurchaseReportAccess();
    const { id } = await params;
    const invoice = await db.purchaseInvoice.findFirst({ where: { id, cafeId: scope.cafeId, ...(scope.branchId ? { branchId: scope.branchId } : {}) },
      select: { id: true, invoiceNumber: true, status: true, paymentStatus: true, invoiceDate: true, totalAmount: true, paidAmount: true, remainingAmount: true, notes: true,
        supplier: { select: { name: true } }, branch: { select: { name: true } },
        items: { select: { id: true, quantity: true, unit: true, unitCost: true, totalCost: true, inventoryItem: { select: { name: true } } } },
        payments: { orderBy: [{ paidAt: 'desc' }, { id: 'desc' }], select: { id: true, amount: true, method: true, fundingSource: true, paidAt: true, note: true } } } });
    if (!invoice) throw new ApiError(404, 'الفاتورة غير موجودة في نطاقك');
    return NextResponse.json({ invoice });
  } catch (error) { return handleApiError(error); }
}
