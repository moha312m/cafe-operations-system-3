import { z } from 'zod';

export class StatementScopeError extends Error {}
export function assertStatementOutputScope(metadata: unknown, scope: { cafeId: string; branchId?: string }) {
  const value = z.object({ cafeId: z.string(), branchId: z.string().nullable(), kind: z.enum(['income', 'balance-sheet', 'cash-flow']) }).parse(metadata);
  if (value.cafeId !== scope.cafeId || (scope.branchId && value.branchId !== scope.branchId) || (scope.branchId && value.kind !== 'income')) throw new StatementScopeError('نطاق التقرير تغير؛ حدّثه قبل الطباعة أو التصدير');
}
const input = z.object({
  kind: z.enum(['income', 'balance-sheet', 'cash-flow']).default('income'),
  from: z.iso.date(), to: z.iso.date(),
}).refine(v => v.from <= v.to, { message: 'تاريخ البداية بعد النهاية' });

/** Scope is already authenticated; request parameters may never widen it. */
export function statementRequest(params: URLSearchParams, scope: { cafeId: string; branchId?: string }, today: string) {
  const q = input.parse({ kind: params.get('kind') ?? undefined, from: params.get('from') ?? `${today.slice(0, 7)}-01`, to: params.get('to') ?? today });
  if (scope.branchId && q.kind !== 'income') throw new StatementScopeError('هذا التقرير متاح للقارئ المخوّل على مستوى الكافيه فقط');
  return { ...q, cafeId: scope.cafeId, branchId: scope.branchId };
}
