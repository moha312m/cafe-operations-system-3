'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, money } from '@/lib/client';
import { useApp } from '@/components/app-shell';
import { addDays, dateStrInTz } from '@/lib/date-range';
import { PURCHASE_REPORT_NOTICE, type PurchaseReportRow, type PurchaseReportTotals } from '@/lib/purchase-report';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { INVOICE_STATUS_LABEL as PURCHASE_STATUS_LABEL, PAYMENT_STATUS_LABEL, PURCHASE_METHOD_LABEL } from '@/lib/purchases';
import { UNIT_LABEL } from '@/lib/inventory';

type Filters = { from: string; to: string; branchId: string; supplierId: string; search: string; status: string; paymentStatus: string };
type Result = { rows: PurchaseReportRow[]; totals: PurchaseReportTotals; branches: { id: string; name: string }[]; suppliers: { id: string; name: string }[]; selection: Filters & { page: number }; pageSize: number; generatedAt: string; outputSnapshot: string };
type InvoiceDetail = { id: string; invoiceNumber: string; invoiceDate: string; status: string; paymentStatus: string; totalAmount: string; paidAmount: string; remainingAmount: string; notes: string | null; supplier: { name: string } | null; branch: { name: string }; items: { id: string; quantity: string; unit: string; unitCost: string; totalCost: string; inventoryItem: { name: string } }[]; payments: { id: string; amount: string; method: string; fundingSource: string | null; paidAt: string; note: string | null }[] };
const field = 'h-10 w-full rounded-md border bg-background px-3 text-sm';
const statusLabel = (value: string) => PURCHASE_STATUS_LABEL[value as keyof typeof PURCHASE_STATUS_LABEL] ?? value;
const paymentLabel = (value: string) => PAYMENT_STATUS_LABEL[value as keyof typeof PAYMENT_STATUS_LABEL] ?? value;
const cairo = (value: string) => new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

function PurchaseOutput({ snapshot, disabled }: { snapshot?: string; disabled: boolean }) {
  const { canKey } = useApp(), [busy, setBusy] = useState(false), [error, setError] = useState(''), lock = useRef(false);
  if (!snapshot || !canKey('reports.export')) return null;
  async function output(kind: 'print' | 'csv' | 'xlsx') {
    if (disabled || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const files = await api<{ html: string; csv: string; xlsx: string }>('/api/report-center/purchases/output', { method: 'POST', body: { snapshot } });
      if (kind === 'print') {
        const frame = document.createElement('iframe'); frame.title = 'طباعة تقرير المشتريات'; frame.style.cssText = 'position:fixed;width:1px;height:1px;inset:0;opacity:0;pointer-events:none';
        frame.onload = () => { frame.contentWindow?.addEventListener('afterprint', () => frame.remove(), { once: true }); frame.contentWindow?.focus(); frame.contentWindow?.print(); };
        document.body.append(frame); frame.srcdoc = files.html;
      } else {
        const blob = kind === 'csv' ? new Blob([files.csv], { type: 'text/csv;charset=utf-8' }) : new Blob([Uint8Array.from(atob(files.xlsx), character => character.charCodeAt(0))], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'purchase-report.' + kind; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'تعذر تصدير التقرير'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="space-y-2"><div className="flex flex-wrap gap-2">{(['print', 'csv', 'xlsx'] as const).map(kind => <Button key={kind} variant="outline" disabled={disabled || busy} onClick={() => void output(kind)}>{kind === 'print' ? 'طباعة اللقطة المعروضة' : kind === 'csv' ? 'تصدير CSV — الصفحة المعروضة' : 'تصدير Excel — الصفحة المعروضة'}</Button>)}</div>{error && <p role="alert" className="text-destructive">{error}</p>}</div>;
}

export function PurchaseReportWorkspace() {
  const { user, cafe, canKey } = useApp(), currency = cafe?.currency ?? 'EGP';
  const [filters, setFilters] = useState<Filters>(() => { const today = dateStrInTz(new Date()); return { from: addDays(today, -6), to: today, branchId: user.branchId ?? '', supplierId: '', search: '', status: '', paymentStatus: '' }; });
  const [page, setPage] = useState(1), [refresh, setRefresh] = useState(0), [data, setData] = useState<Result | null>(null), [loadedQuery, setLoadedQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState(''), [detail, setDetail] = useState<InvoiceDetail | null>(null), [detailError, setDetailError] = useState('');
  const query = new URLSearchParams({ ...filters, page: String(page) }).toString(), permitted = canKey('purchases.view') && canKey('purchases.view_cost');
  const valid = !!filters.from && !!filters.to && filters.from <= filters.to, pending = loading || loadedQuery !== query;
  useEffect(() => {
    if (!permitted || !valid) return;
    let active = true;
    const timer = setTimeout(async () => {
      setLoading(true); setError('');
      try { const result = await api<Result>('/api/report-center/purchases?' + query); if (active) { setData(result); setLoadedQuery(query); } }
      catch (failure) { if (active) setError(failure instanceof Error ? failure.message : 'تعذر تحميل التقرير'); }
      finally { if (active) setLoading(false); }
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [query, refresh, permitted, valid]);
  useEffect(() => {
    if (!detailId) return;
    let active = true;
    const timer = setTimeout(async () => {
      setDetailError('');
      try { const result = await api<{ invoice: InvoiceDetail }>('/api/report-center/purchases/' + encodeURIComponent(detailId)); if (active) setDetail(result.invoice); }
      catch (failure) { if (active) setDetailError(failure instanceof Error ? failure.message : 'تعذر تحميل الفاتورة'); }
    }, 0);
    return () => { active = false; clearTimeout(timer); };
  }, [detailId]);
  function change(key: keyof Filters, value: string) { setFilters(current => ({ ...current, [key]: value })); setPage(1); }
  if (!permitted) return <p role="alert">تقرير المشتريات يحتاج صلاحية عرض المشتريات وتكاليفها.</p>;
  return <div dir="rtl" className="max-w-7xl space-y-5">
    <header className="space-y-2"><Link href="/report-center" className="text-sm text-primary underline">مركز التقارير</Link><h1 className="text-2xl font-bold">تقرير فواتير المشتريات</h1><p className="text-sm leading-7 text-muted-foreground">{PURCHASE_REPORT_NOTICE}</p></header>
    <div className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2 xl:grid-cols-4">
      <div className="space-y-2"><Label htmlFor="purchase-report-from">من تاريخ الفاتورة — القاهرة</Label><Input id="purchase-report-from" type="date" value={filters.from} onChange={event => change('from', event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="purchase-report-to">إلى تاريخ الفاتورة — القاهرة</Label><Input id="purchase-report-to" type="date" value={filters.to} onChange={event => change('to', event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="purchase-report-branch">الفرع</Label><select id="purchase-report-branch" className={field} disabled={!!user.branchId} value={filters.branchId} onChange={event => change('branchId', event.target.value)}>{!user.branchId && <option value="">كل الفروع المسموحة</option>}{!data && user.branchId && <option value={user.branchId}>الفرع المعيّن</option>}{data?.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
      <div className="space-y-2"><Label htmlFor="purchase-report-supplier">المورد</Label><select id="purchase-report-supplier" className={field} value={filters.supplierId} onChange={event => change('supplierId', event.target.value)}><option value="">كل الموردين</option>{data?.suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></div>
      <div className="space-y-2"><Label htmlFor="purchase-report-search">بحث الفاتورة أو المورد</Label><Input id="purchase-report-search" maxLength={100} value={filters.search} onChange={event => change('search', event.target.value)} placeholder="رقم الفاتورة أو اسم المورد" /></div>
      <div className="space-y-2"><Label htmlFor="purchase-report-status">حالة الفاتورة</Label><select id="purchase-report-status" className={field} value={filters.status} onChange={event => change('status', event.target.value)}><option value="">كل الحالات</option>{Object.entries(PURCHASE_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="space-y-2"><Label htmlFor="purchase-report-payment">حالة الدفع</Label><select id="purchase-report-payment" className={field} value={filters.paymentStatus} onChange={event => change('paymentStatus', event.target.value)}><option value="">كل حالات الدفع</option>{Object.entries(PAYMENT_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="flex items-end"><Button variant="outline" disabled={!valid || loading} onClick={() => setRefresh(current => current + 1)}>تحديث التقرير</Button></div>
    </div>
    {!valid && <p role="alert" className="text-destructive">أدخل فترة صحيحة؛ البداية لا تتجاوز النهاية.</p>}
    {valid && pending && !error && <p role="status">جارٍ تحديث التقرير…</p>}
    {error && <p role="alert" className="rounded-xl border p-4 text-destructive">{error}{data ? ' — المعروض آخر لقطة ناجحة. صحّح الفلاتر أو أعد التحديث؛ التصدير معطل.' : ' — صحّح الفلاتر أو أعد التحديث.'}</p>}
    {data && <><p className="text-sm text-muted-foreground">اللقطة المعروضة: {data.selection.from} إلى {data.selection.to} — توقيت القاهرة · تم إنشاؤها {cairo(data.generatedAt)}{pending ? ' · لم تُحدّث بعد للفلاتر الجديدة' : ''}</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['الفواتير المطابقة', String(data.totals.count)], ['قيمة الفواتير المطابقة', money(Number(data.totals.totalAmount), currency)], ['المدفوع حالياً للفواتير المطابقة', money(Number(data.totals.paidAmount), currency)], ['المتبقي حالياً للفواتير المطابقة', money(Number(data.totals.remainingAmount), currency)]].map(([label, value]) => <div key={label} className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-xl font-bold tabular-nums">{value}</p></div>)}</div>
      <PurchaseOutput snapshot={data.outputSnapshot} disabled={pending || !!error || !valid} />
      <div className="overflow-x-auto rounded-xl border"><table className="w-full whitespace-nowrap text-start text-sm"><thead className="bg-muted/40"><tr>{['الفاتورة', 'المورد / الفرع', 'تاريخ الفاتورة — القاهرة', 'الحالة', 'الدفع', 'القيمة', 'المدفوع حالياً', 'المتبقي حالياً', 'التفاصيل'].map(label => <th className="px-4 py-3 text-start font-medium" key={label}>{label}</th>)}</tr></thead><tbody className="divide-y">{data.rows.map(row => <tr key={row.id}><td className="px-4 py-3 font-medium">{row.invoiceNumber}</td><td className="px-4 py-3">{row.supplier ?? 'بدون مورد'}<small className="block text-muted-foreground">{row.branch}</small></td><td className="px-4 py-3">{cairo(row.invoiceDate)}</td><td className="px-4 py-3">{statusLabel(row.status)}</td><td className="px-4 py-3">{paymentLabel(row.paymentStatus)}</td>{[row.totalAmount, row.paidAmount, row.remainingAmount].map((amount, index) => <td className="px-4 py-3 tabular-nums" key={index}>{money(Number(amount), currency)}</td>)}<td className="px-4 py-3"><Button size="sm" variant="outline" onClick={() => { setDetailError(''); setDetailId(row.id); }}>فتح الفاتورة</Button></td></tr>)}</tbody></table>{!data.rows.length && <p className="p-8 text-center text-muted-foreground">لا توجد فواتير مطابقة لهذه الفلاتر.</p>}</div>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">الصفحة {data.selection.page} · {data.rows.length} من {data.totals.count} فاتورة · التصدير لهذه الصفحة</p><div className="flex gap-2"><Button variant="outline" disabled={pending || page <= 1} onClick={() => setPage(current => current - 1)}>السابق</Button><Button variant="outline" disabled={pending || page * data.pageSize >= data.totals.count} onClick={() => setPage(current => current + 1)}>التالي</Button></div></div>
    </>}
    <Dialog open={!!detailId} onOpenChange={open => { if (!open) setDetailId(''); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl" dir="rtl"><DialogHeader><DialogTitle>تفاصيل الفاتورة الأصلية</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">حالة الفاتورة الآن من سجل المشتريات، وقد تختلف عن لقطة التقرير السابقة.</p>{detailError ? <p role="alert" className="text-destructive">{detailError}</p> : detail?.id !== detailId ? <p role="status">جارٍ تحميل الفاتورة…</p> : <div className="space-y-4"><p className="font-bold">{detail.invoiceNumber} · {detail.supplier?.name ?? 'بدون مورد'} · {detail.branch.name}</p><p>{cairo(detail.invoiceDate)} · {statusLabel(detail.status)} · {paymentLabel(detail.paymentStatus)}</p><dl className="grid grid-cols-3 gap-3">{[['القيمة', detail.totalAmount], ['المدفوع حالياً', detail.paidAmount], ['المتبقي حالياً', detail.remainingAmount]].map(([label, value]) => <div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="tabular-nums">{money(Number(value), currency)}</dd></div>)}</dl><h3 className="font-semibold">الأصناف</h3><ul className="divide-y">{detail.items.map(item => <li key={item.id} className="flex justify-between gap-3 py-3"><span>{item.inventoryItem.name}<small className="block text-muted-foreground">{item.quantity} {UNIT_LABEL[item.unit as keyof typeof UNIT_LABEL] ?? item.unit} × {money(Number(item.unitCost), currency)}</small></span><span className="tabular-nums">{money(Number(item.totalCost), currency)}</span></li>)}</ul><h3 className="font-semibold">دفعات المورد الأصلية</h3>{detail.payments.length ? <ul className="divide-y">{detail.payments.map(payment => <li key={payment.id} className="flex justify-between gap-3 py-3"><span>{PURCHASE_METHOD_LABEL[payment.method as keyof typeof PURCHASE_METHOD_LABEL] ?? payment.method}<small className="block text-muted-foreground">{cairo(payment.paidAt)}{payment.note && ' · ' + payment.note}</small></span><span className="tabular-nums">{money(Number(payment.amount), currency)}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">لا توجد دفعات مسجلة.</p>}{detail.notes && <p className="whitespace-pre-wrap text-sm">{detail.notes}</p>}</div>}</DialogContent></Dialog>
  </div>;
}
