import { NextRequest, NextResponse } from 'next/server';
import { ApiError, handleApiError } from '@/lib/api';
import { requirePurchaseReportAccess } from '@/lib/purchase-report-access';
import { purchaseReportActorId, assertPurchaseReportScope, PurchaseReportError } from '@/lib/purchase-report';
import { reportOutputFiles, verifyReportOutput } from '@/lib/report-output';

export async function POST(request: NextRequest) {
  try {
    const { actor, scope } = await requirePurchaseReportAccess(true);
    const input = await request.json();
    if (typeof input.snapshot !== 'string') throw new ApiError(400, 'لقطة التقرير مطلوبة');
    let report;
    try { report = verifyReportOutput(purchaseReportActorId(actor.id), input.snapshot); }
    catch { throw new ApiError(400, 'حدّث التقرير قبل الطباعة أو التصدير'); }
    assertPurchaseReportScope(report, scope);
    return NextResponse.json(reportOutputFiles(report));
  } catch (error) { return handleApiError(error instanceof PurchaseReportError ? new ApiError(error.status, error.message) : error); }
}
