import { NextResponse, type NextRequest } from 'next/server';
import { ApiError, handleApiError } from '@/lib/api';
import { accountingScope } from '@/lib/accounting/api-scope';
import { assertStatementOutputScope, StatementScopeError } from '@/lib/accounting/statement-request';
import { resolvePermissions } from '@/lib/perms/effective';
import { verifyReportOutput, reportOutputFiles } from '@/lib/report-output';
export async function POST(request: NextRequest) {
  try {
    const { session, scope } = await accountingScope(request);
    const { keys } = await resolvePermissions(session);
    if (!keys.has('accounting.export') || !keys.has('reports.export')) throw new ApiError(403, 'ليس لديك صلاحية تصدير المحاسبة');
    const input = await request.json();
    if (typeof input.snapshot !== 'string') throw new ApiError(400, 'لقطة التقرير مطلوبة');
    let report;
    try { report = verifyReportOutput('statement:' + session.id, input.snapshot); } catch { throw new ApiError(400, 'حدّث التقرير قبل الطباعة أو التصدير'); }
    assertStatementOutputScope(report.reporting, scope);
    return NextResponse.json(reportOutputFiles(report));
  } catch (e) { return handleApiError(e instanceof StatementScopeError ? new ApiError(403, e.message) : e); }
}
