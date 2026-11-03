import { NextResponse, type NextRequest } from 'next/server';
import { ApiError, handleApiError } from '@/lib/api';
import { db } from '@/lib/db';
import { dateStrInTz } from '@/lib/date-range';
import { accountingScope } from '@/lib/accounting/api-scope';
import { statementRequest, StatementScopeError } from '@/lib/accounting/statement-request';
import { balanceSheet, cashFlow, incomeStatement } from '@/lib/accounting/statements';
import { SHADOW_NOTICE } from '@/lib/accounting/queries';
import { resolvePermissions } from '@/lib/perms/effective';
import { signReportOutput } from '@/lib/report-output';

export async function GET(request: NextRequest) {
  try {
    const { session, scope } = await accountingScope(request);
    const q = statementRequest(request.nextUrl.searchParams, scope, dateStrInTz(new Date()));
    const branches = await db.branch.findMany({ where: { cafeId: scope.cafeId, ...(session.branchId ? { id: session.branchId } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const entity = await db.accountingEntity.findUnique({ where: { cafeId: scope.cafeId }, select: { id: true } });
    if (!entity) return NextResponse.json({ configured: false, kind: q.kind, from: q.from, to: q.to, branchId: scope.branchId ?? null, branches, notice: SHADOW_NOTICE, outputSnapshot: null });
    const result = q.kind === 'income' ? await incomeStatement(q) : q.kind === 'balance-sheet' ? await balanceSheet({ cafeId: q.cafeId, asOf: q.to }) : await cashFlow(q);
    const title = { income: 'قائمة الدخل', 'balance-sheet': 'الميزانية العمومية', 'cash-flow': 'التدفقات النقدية' }[q.kind];
    const rows: Record<string, string | number>[] = [], metrics: Record<string, number | boolean> = {};
    for (const [section, value] of Object.entries(result)) {
      if (typeof value === 'number' || typeof value === 'boolean') metrics[section] = value;
      else if (Array.isArray(value)) for (const line of value) rows.push({ section, الحساب: line.name ?? line.label, ...(line.code ? { الكود: line.code } : {}), القيمة: line.amount });
    }
    const canExport = (await resolvePermissions(session)).keys.has('accounting.export');
    const outputSnapshot = canExport ? signReportOutput('statement:' + session.id, { title: title + ' — تجريبي غير معتمد', reporting: { mode: 'accounting', boundary: 'أيام محاسبية شاملة للبداية والنهاية', kind: q.kind, cafeId: scope.cafeId, from: q.from, to: q.to, branchId: scope.branchId ?? null, notice: SHADOW_NOTICE }, metrics, rows, generatedAt: new Date().toISOString() }) : null;
    return NextResponse.json({ configured: true, mode: 'SHADOW', kind: q.kind, from: q.from, to: q.to, branchId: scope.branchId ?? null, branches, notice: SHADOW_NOTICE, result, outputSnapshot });
  } catch (e) { return handleApiError(e instanceof StatementScopeError ? new ApiError(403, e.message) : e); }
}
