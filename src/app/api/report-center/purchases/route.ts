import { NextRequest, NextResponse } from 'next/server';
import { ApiError, handleApiError } from '@/lib/api';
import { db } from '@/lib/db';
import { requirePurchaseReportAccess } from '@/lib/purchase-report-access';
import { purchaseReportSelection, purchaseReportWhere, purchaseReportSnapshot, purchaseReportActorId, PurchaseReportError, type PurchaseReportRow } from '@/lib/purchase-report';
import { signReportOutput } from '@/lib/report-output';

export async function GET(request: NextRequest) {
  try {
    const { actor, scope } = await requirePurchaseReportAccess();
    const q = purchaseReportSelection(request.nextUrl.searchParams, scope);
    if (q.branchId && !await db.branch.findFirst({ where: { id: q.branchId, cafeId: q.cafeId }, select: { id: true } })) throw new ApiError(403, 'الفرع خارج الكافيه');
    if (q.supplierId && !await db.supplier.findFirst({ where: { id: q.supplierId, cafeId: q.cafeId }, select: { id: true } })) throw new ApiError(400, 'المورد خارج الكافيه');
    const where = purchaseReportWhere(q);
    const [invoices, aggregate, branches, suppliers] = await db.$transaction([
      db.purchaseInvoice.findMany({ where, orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.pageSize,
        select: { id: true, invoiceNumber: true, invoiceDate: true, status: true, paymentStatus: true, totalAmount: true, paidAmount: true, remainingAmount: true, supplier: { select: { name: true } }, branch: { select: { name: true } } } }),
      db.purchaseInvoice.aggregate({ where, _count: true, _sum: { totalAmount: true, paidAmount: true, remainingAmount: true } }),
      db.branch.findMany({ where: { cafeId: q.cafeId, ...(scope.branchId ? { id: scope.branchId } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      db.supplier.findMany({ where: { cafeId: q.cafeId, ...(scope.branchId ? { invoices: { some: { cafeId: q.cafeId, branchId: scope.branchId } } } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ], { isolationLevel: 'RepeatableRead' });
    const rows: PurchaseReportRow[] = invoices.map(inv => ({ id: inv.id, invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate.toISOString(), status: inv.status, paymentStatus: inv.paymentStatus, totalAmount: inv.totalAmount.toFixed(2), paidAmount: inv.paidAmount.toFixed(2), remainingAmount: inv.remainingAmount.toFixed(2), supplier: inv.supplier?.name ?? null, branch: inv.branch.name }));
    const totals = { count: aggregate._count, totalAmount: aggregate._sum.totalAmount?.toFixed(2) ?? '0.00', paidAmount: aggregate._sum.paidAmount?.toFixed(2) ?? '0.00', remainingAmount: aggregate._sum.remainingAmount?.toFixed(2) ?? '0.00' };
    const generatedAt = new Date().toISOString(), snapshot = purchaseReportSnapshot(q, rows, totals, branches, generatedAt);
    return NextResponse.json({ rows, totals, branches, suppliers, selection: { from: q.fromDate, to: q.toDate, branchId: q.branchId ?? '', supplierId: q.supplierId ?? '', search: q.search, status: q.status ?? '', paymentStatus: q.paymentStatus ?? '', page: q.page }, pageSize: q.pageSize, generatedAt, outputSnapshot: signReportOutput(purchaseReportActorId(actor.id), snapshot) });
  } catch (error) { return handleApiError(error instanceof PurchaseReportError ? new ApiError(error.status, error.message) : error); }
}
