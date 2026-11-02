'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Search, ArrowUpLeft, FileText } from 'lucide-react';
import { REPORT_GROUPS, type ReportCatalogEntry } from '@/lib/report-center';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ReportCenter({ reports, branchScoped, configured }: { reports: ReportCatalogEntry[]; branchScoped: boolean; configured: boolean }) {
  const [search, setSearch] = useState(''), [group, setGroup] = useState('all');
  const filtered = reports.filter(report => (group === 'all' || report.group === group) && `${report.title} ${report.description}`.includes(search.trim()));
  return <div className="workspace-page" dir="rtl">
    <header className="workspace-header"><div className="mb-2 flex items-center gap-2 text-primary"><FileText className="size-5" /><span className="text-sm font-medium">NEXT CUP</span></div><h1 className="text-2xl font-bold sm:text-3xl">مركز التقارير</h1><p className="mt-2 max-w-3xl text-sm leading-7 text-muted-foreground">اختر التقرير ثم حدد الفترة والفلاتر داخل شاشته. كل تقرير يستخدم مصدره الأصلي؛ صلاحية التصدير تُراجع عند الطلب.</p><p className="mt-2 text-sm">{branchScoped ? 'التقارير المتاحة ضمن نطاق فرعك. التقارير على مستوى الكافيه مخفية.' : 'التقارير المتاحة حسب صلاحيات حسابك والميزات المفعلة.'}</p></header>
    <div className="grid gap-4 rounded-xl bg-card p-4 sm:grid-cols-[1fr_16rem]"><div className="space-y-2"><Label htmlFor="report-search">ابحث عن تقرير</Label><div className="relative"><Search className="pointer-events-none absolute start-3 top-3 size-4 text-muted-foreground" /><Input id="report-search" className="ps-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="اسم التقرير أو محتواه" /></div></div><div className="space-y-2"><Label htmlFor="report-group">القسم</Label><select id="report-group" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={group} onChange={event => setGroup(event.target.value)}><option value="all">كل الأقسام</option>{REPORT_GROUPS.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div></div>
    {!configured && <p role="alert" className="rounded-xl border p-4">إعدادات الكافيه غير متاحة؛ لم يُنشئ مركز التقارير إعدادات تلقائية. راجع المالك.</p>}
    <p className="text-sm text-muted-foreground" role="status">{filtered.length} تقرير أو سجل متاح</p>
    {REPORT_GROUPS.filter(item => group === 'all' || group === item.id).map(item => {
      const rows = filtered.filter(report => report.group === item.id);
      return <section key={item.id} aria-labelledby={'group-' + item.id} className="space-y-3"><div><h2 id={'group-' + item.id} className="text-xl font-semibold">{item.title}</h2><p className="mt-1 text-sm text-muted-foreground">{item.description}</p></div>{rows.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map(report => <Link key={report.id} href={report.href} className="group flex flex-col rounded-xl border bg-card p-5 transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-primary"><div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{report.title}</h3><ArrowUpLeft className="size-4 shrink-0 text-primary" /></div><p className="my-3 flex-1 text-sm leading-7 text-muted-foreground">{report.description}</p><span className="text-xs font-medium text-primary">{report.format}</span></Link>)}</div> : <p className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">{search ? 'لا توجد نتائج مطابقة في هذا القسم.' : 'لا توجد تقارير متاحة لهذا القسم ضمن صلاحياتك والميزات المفعلة.'}</p>}</section>;
    })}
    <p className="rounded-xl border p-4 text-sm leading-7 text-muted-foreground">القوائم المحاسبية تجريبية SHADOW وتعرض حالة الإعداد كما هي. المصروفات والمشتريات والتحصيلات والتحويلات الداخلية لكلٍ منها معنى مستقل؛ لا يجمعها المركز في رصيد أو ربح جديد.</p>
  </div>;
}
