import type { Prisma } from '@prisma/client';
import { addDays, dateStrInTz, getDateRangeFromFilter } from './date-range';
import type { ReportOutput } from './report-output';

export class PurchaseReportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function assertPurchaseReportPermissions(keys: ReadonlySet<string>, features: { inventoryEnabled?: boolean; purchasesEnabled?: boolean } | null, exporting: boolean): void {
  if (!['purchases.view', 'purchases.view_cost', ...(exporting ? ['reports.export'] : [])].every(key => keys.has(key))) throw new PurchaseReportError(403, 'ليس لديك صلاحية لعرض أو تصدير تكاليف المشتريات');
  if (!features?.inventoryEnabled || !features.purchasesEnabled) throw new PurchaseReportError(403, 'تقارير المشتريات غير مفعلة لهذا الكافيه');
}
export type PurchaseReportScope = { cafeId: string; branchId?: string | null; role: string };
export type PurchaseReportSelection = { cafeId: string; branchId?: string; from: Date; to: Date; fromDate: string; toDate: string;
  search: string; supplierId?: string; status?: 'DRAFT' | 'CONFIRMED' | 'CANCELLED'; paymentStatus?: 'UNPAID' | 'PARTIAL' | 'PAID'; page: number; pageSize: number; skip: number };
export function purchaseReportSelection(params: URLSearchParams, actor: PurchaseReportScope, now = new Date()): PurchaseReportSelection {
  if (!actor.cafeId || (!actor.branchId && !['CAFE_OWNER', 'SUPER_ADMIN'].includes(actor.role))) throw new PurchaseReportError(403, 'الحساب غير معيّن على فرع');
  const requested = params.get('branchId') || undefined;
  if (actor.branchId && requested && requested !== actor.branchId) throw new PurchaseReportError(403, 'الفرع خارج نطاقك');
  const today = dateStrInTz(now), fromDate = params.get('from') ?? addDays(today, -6), toDate = params.get('to') ?? today;
  for (const value of [fromDate, toDate]) {
    const parsed = new Date(value + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new PurchaseReportError(400, 'تاريخ غير صالح');
  }
  const range = getDateRangeFromFilter('custom_range', { from: fromDate, to: toDate });
  if (range.error) throw new PurchaseReportError(400, range.error);
  const status = params.get('status') || undefined, paymentStatus = params.get('paymentStatus') || undefined;
  if (status && !['DRAFT', 'CONFIRMED', 'CANCELLED'].includes(status)) throw new PurchaseReportError(400, 'حالة الفاتورة غير صالحة');
  if (paymentStatus && !['UNPAID', 'PARTIAL', 'PAID'].includes(paymentStatus)) throw new PurchaseReportError(400, 'حالة الدفع غير صالحة');
  const pageText = params.get('page') ?? '1';
  if (!/^[1-9]\d{0,5}$/.test(pageText)) throw new PurchaseReportError(400, 'رقم الصفحة غير صالح');
  const search = (params.get('search') ?? '').trim();
  if (search.length > 100) throw new PurchaseReportError(400, 'البحث أطول من المسموح');
  const page = Number(pageText), pageSize = 25;
  return { cafeId: actor.cafeId, branchId: actor.branchId || requested, from: range.from, to: new Date(range.to.getTime() + 1), fromDate, toDate,
    search, supplierId: params.get('supplierId') || undefined, status: status as PurchaseReportSelection['status'], paymentStatus: paymentStatus as PurchaseReportSelection['paymentStatus'], page, pageSize, skip: (page - 1) * pageSize };
}
export function purchaseReportWhere(q: PurchaseReportSelection): Prisma.PurchaseInvoiceWhereInput {
  return { cafeId: q.cafeId, ...(q.branchId ? { branchId: q.branchId } : {}), invoiceDate: { gte: q.from, lt: q.to },
    ...(q.supplierId ? { supplierId: q.supplierId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.paymentStatus ? { paymentStatus: q.paymentStatus } : {}),
    ...(q.search ? { OR: [{ invoiceNumber: { contains: q.search, mode: 'insensitive' } }, { supplier: { name: { contains: q.search, mode: 'insensitive' } } }] } : {}) };
}
export type PurchaseReportRow = { id: string; invoiceNumber: string | null; supplier: string | null; branch: string; invoiceDate: string; status: string; paymentStatus: string; totalAmount: string; paidAmount: string; remainingAmount: string };
export type PurchaseReportTotals = { count: number; totalAmount: string; paidAmount: string; remainingAmount: string };
export const PURCHASE_REPORT_NOTICE = 'إجماليات الفواتير حسب تاريخ الفاتورة، وتشمل الحالات المختارة. المدفوع والمتبقي حالتهما الحالية وليسا مدفوعات الفترة؛ المشتريات ليست تكلفة الاستهلاك. التصدير يضم صفوف الصفحة المعروضة وإجماليات كل النتائج المطابقة.';
export function purchaseReportSnapshot(q: PurchaseReportSelection, rows: PurchaseReportRow[], totals: PurchaseReportTotals, branches: { id: string; name: string }[], generatedAt: string): ReportOutput {
  return { title: 'تقرير فواتير المشتريات', generatedAt,
    reporting: { reportType: 'purchase-invoices-v1', cafeId: q.cafeId, branchId: q.branchId ?? null, mode: 'calendar', filters: { from: q.fromDate, to: q.toDate, branchId: q.branchId ?? '', supplierId: q.supplierId ?? '', search: q.search, status: q.status ?? '', paymentStatus: q.paymentStatus ?? '', page: q.page, pageSize: q.pageSize }, branches,
      windows: [{ from: q.from.toISOString(), to: q.to.toISOString(), startLocal: q.fromDate + 'T00:00', endLocal: addDays(q.toDate, 1) + 'T00:00', timezone: 'Africa/Cairo', warnings: [] }] },
    metrics: { totals, page: { number: q.page, size: q.pageSize, displayed: rows.length }, filters: { branch: q.branchId ? branches.find(branch => branch.id === q.branchId)?.name ?? q.branchId : 'كل الفروع المسموحة', supplierId: q.supplierId ?? 'كل الموردين', search: q.search, status: q.status ?? 'كل الحالات', paymentStatus: q.paymentStatus ?? 'كل حالات الدفع' }, notice: PURCHASE_REPORT_NOTICE },
    labels: { 'totals.count': 'عدد الفواتير المطابقة', 'totals.totalAmount': 'قيمة الفواتير المطابقة', 'totals.paidAmount': 'المدفوع حالياً للفواتير المطابقة', 'totals.remainingAmount': 'المتبقي حالياً للفواتير المطابقة', 'page.number': 'الصفحة', 'page.size': 'حجم الصفحة', 'page.displayed': 'صفوف اللقطة', 'filters.branch': 'فلتر الفرع', 'filters.supplierId': 'فلتر المورد — المعرّف', 'filters.search': 'فلتر البحث', 'filters.status': 'فلتر حالة الفاتورة', 'filters.paymentStatus': 'فلتر حالة الدفع', notice: 'أساس التقرير' },
    rows: rows.map(row => ({ 'الفاتورة': row.invoiceNumber ?? row.id, 'المورد': row.supplier ?? 'بدون مورد', 'الفرع': row.branch, 'تاريخ الفاتورة — القاهرة': new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Cairo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(row.invoiceDate)), 'الحالة': row.status, 'حالة الدفع': row.paymentStatus, 'القيمة': row.totalAmount, 'المدفوع حالياً': row.paidAmount, 'المتبقي حالياً': row.remainingAmount })) };
}
// Domain separation prevents this snapshot from bypassing purchase permission
// checks through the generic sales-report output endpoint.
export const purchaseReportActorId = (id: string): string => 'purchase-report:' + id;
export function assertPurchaseReportScope(report: ReportOutput, actor: PurchaseReportScope): void {
  const scope = report.reporting as { reportType?: string; cafeId?: string; branchId?: string | null };
  if (scope?.reportType !== 'purchase-invoices-v1' || scope.cafeId !== actor.cafeId || (actor.branchId ? scope.branchId !== actor.branchId : !['CAFE_OWNER', 'SUPER_ADMIN'].includes(actor.role))) throw new PurchaseReportError(403, 'نطاق التقرير تغيّر؛ حدّث التقرير قبل التصدير');
}
