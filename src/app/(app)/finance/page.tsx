'use client';
import Link from 'next/link';
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
  return <main dir="rtl" className="mx-auto max-w-6xl space-y-6"><header className="rounded-2xl border bg-primary/5 p-6"><p className="text-sm font-medium text-primary">NEXT CUP · مساحة العمل</p><h1 className="mt-2 text-3xl font-bold">الماليات</h1><p className="mt-2 text-muted-foreground">ابدأ بالمهمة المطلوبة، ثم راجع السجل وتفاصيل الحركة في مكانها.</p></header><aside role="note" className="rounded-xl border p-4 text-sm leading-7">حسابات الأموال محدودة المصادر؛ الرصيد الافتتاحي غير المعتمد يظل غير معلوم. الدفاتر المحاسبية تجريبية SHADOW وتحتاج مراجعة المحاسب. التحويل الداخلي لا يُعد إيرادًا أو مصروفًا.</aside>{!visible.length && <p role="alert">ليس لديك صلاحية عرض الأقسام المالية.</p>}<nav aria-label="مهام الماليات" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{visible.map(l => <Link href={l.href} key={l.href} className="rounded-xl border bg-card p-5 transition hover:border-primary focus-visible:outline-2 focus-visible:outline-primary"><h2 className="font-bold">{l.title}</h2><p className="mt-2 text-sm text-muted-foreground">{l.text}</p><span className="mt-4 block text-sm text-primary">فتح القسم ←</span></Link>)}</nav></main>;
}
