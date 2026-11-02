'use client';
import Link from 'next/link';
import { Landmark, Wallet, ArrowLeftRight, BookOpen, ArrowUpLeft, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/cafe/ui';
import { useApp } from '@/components/app-shell';
const links = [
  { href: '/expenses', title: 'المصروفات والتصنيفات', text: 'إيصالات الصرف ورد النقد وتصنيف المصروفات', key: 'expenses.view', owner: false, cafeWide: false },
  { href: '/treasury', title: 'حسابات الأموال', text: 'الخزنة والبنك والمحفظة وكشوف الحركات', key: 'treasury.view', owner: true, cafeWide: false },
  { href: '/treasury#transfers', title: 'التحويلات الداخلية', text: 'مسودة، خروج فعلي ثم استلام مؤكد', key: 'treasury.view', owner: true, cafeWide: false },
  { href: '/accounting/trial-balance', title: 'ميزان المراجعة', text: 'الافتتاح والمدين والدائن والختام', key: 'accounting.view', owner: false, cafeWide: false },
  { href: '/accounting/statements?kind=balance-sheet', title: 'الميزانية العمومية', text: 'الأصول والالتزامات وحقوق الملكية', key: 'accounting.view', owner: false, cafeWide: true },
  { href: '/accounting/statements?kind=cash-flow', title: 'التدفقات النقدية', text: 'المقبوضات والمدفوعات من الدفاتر', key: 'accounting.view', owner: false, cafeWide: true },
  { href: '/accounting/statements?kind=income', title: 'قائمة الدخل', text: 'الإيراد وتكلفة المبيعات والمصروفات', key: 'accounting.view', owner: false, cafeWide: false },
  { href: '/accounting/ledger', title: 'دفتر الأستاذ', text: 'حركة كل حساب مع الرصيد المرحّل', key: 'accounting.view', owner: false, cafeWide: false },
  { href: '/accounting/journal', title: 'القيود اليومية', text: 'تفاصيل القيد وروابط مصدره', key: 'accounting.view', owner: false, cafeWide: false },
];
export default function FinancePage() {
  const { user, canKey } = useApp();
  const visible = links.filter(l => canKey(l.key) && (!l.owner || user.role === 'CAFE_OWNER') && (!l.cafeWide || !user.branchId));
  const groups=[
    {title:'حركة الأموال اليومية',description:'راجع الحسابات والتحويلات والمصروفات بوثائقها الأصلية.',icon:Wallet,items:visible.filter(l=>['/expenses','/treasury','/treasury#transfers'].includes(l.href))},
    {title:'المراجعة والدفاتر',description:'قوائم وقيود تجريبية SHADOW للمراجعة مع المحاسب.',icon:BookOpen,items:visible.filter(l=>l.href.startsWith('/accounting'))},
  ];
  return <div dir="rtl" className="workspace-page">
    <PageHeader title="الماليات" subtitle="الحسابات والمصروفات والدفاتر · اختر المهمة وراجع مصدرها" />
    <aside role="note" className="flex gap-3 rounded-xl bg-caramel-soft p-4 text-sm leading-relaxed text-caramel-ink"><ShieldCheck className="size-5 shrink-0"/><p><strong>تغطية مالية محدودة.</strong> الرصيد الافتتاحي غير المعتمد يظل غير معلوم. الدفاتر تجريبية SHADOW وتحتاج مراجعة المحاسب. التحويل الداخلي ليس إيرادًا أو مصروفًا.</p></aside>
    {!visible.length&&<p role="alert" className="workspace-state">ليس لديك صلاحية عرض الأقسام المالية.</p>}
    {groups.filter(group=>group.items.length).map(group=><section key={group.title} className="space-y-4"><header className="flex items-start gap-3"><group.icon aria-hidden="true" className="mt-1 size-5 text-primary"/><div><h2 className="text-xl font-semibold">{group.title}</h2><p className="mt-1 text-sm text-muted-foreground">{group.description}</p></div></header><nav aria-label={group.title} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{group.items.map(l=><Link href={l.href} key={l.href} className="group flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-5 transition hover:border-primary hover:shadow-sm focus-visible:outline-2 focus-visible:outline-primary"><div className="flex items-center justify-between gap-3"><span className="rounded-xl bg-sage-soft p-2.5 text-primary">{l.href==='/treasury'?<Landmark className="size-5"/>:l.href.includes('#transfers')?<ArrowLeftRight className="size-5"/>:l.href==='/expenses'?<Wallet className="size-5"/>:<BookOpen className="size-5"/>}</span><ArrowUpLeft className="size-5 text-muted-foreground group-hover:text-primary"/></div><h3 className="text-lg font-semibold">{l.title}</h3><p className="flex-1 text-sm leading-relaxed text-muted-foreground">{l.text}</p><span className="mt-2 text-sm font-semibold text-primary">فتح مساحة العمل ←</span></Link>)}</nav></section>)}
  </div>;
}
