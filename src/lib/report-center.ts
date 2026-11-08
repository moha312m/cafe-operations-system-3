import {SALES_REPORT_CATALOG} from './sales-report-catalog';
import type { CafeFeatures } from './cafe-settings';

export const REPORT_GROUPS = [
  { id: 'sales', title: 'المبيعات', description: 'المبيعات والتحصيلات والمرتجعات كلٌ بمعناه.' },
  { id: 'inventory', title: 'المخزون', description: 'الأرصدة الحالية وحركات الأصناف.' },
  { id: 'purchasing', title: 'المشتريات', description: 'فواتير الموردين والمدفوع والمتبقي؛ ليست تكلفة الاستهلاك.' },
  { id: 'finance', title: 'المالية', description: 'الحسابات والمصاريف والدفاتر التجريبية.' },
  { id: 'customers', title: 'العملاء', description: 'سجل العملاء والولاء وفق نطاق البيانات المتاح.' },
  { id: 'system', title: 'النظام ونشاط الموظفين', description: 'الشيفتات والعهد والفروقات وسجل النشاط.' },
] as const;
type ReportGroup = typeof REPORT_GROUPS[number]['id'];
export type ReportCatalogEntry = { id: string; group: ReportGroup; title: string; description: string; href: string;
  keys: string[]; features?: (keyof CafeFeatures)[]; ownerOnly?: boolean; cafeWide?: boolean; format: string };
const CATALOG: ReportCatalogEntry[] = [
  ...SALES_REPORT_CATALOG.map(entry=>({...entry,group:'sales' as const,href:'/reports/'+entry.id,format:'تقرير · تفاصيل · طباعة · تصدير'})),
  { id: 'daily', group: 'sales', title: 'قَفلة اليوم والفترة', description: 'المبيعات المعترف بها والتحصيلات والمرتجعات حسب الفرع والكاشير والصنف. طباعة وCSV وExcel من اللقطة المعروضة.', href: '/reports', keys: ['reports.view'], format: 'تقرير · طباعة · تصدير' },
  { id: 'invoices', group: 'sales', title: 'سجل فواتير البيع', description: 'بحث وفلاتر وتفاصيل الفاتورة والإيصال؛ المبيعات والتحصيلات منفصلة.', href: '/sales', keys: ['sales.view'], format: 'سجل · تفاصيل · تصدير' },
  { id: 'historical', group: 'sales', title: 'المبيعات التاريخية المستوردة', description: 'بيانات مستوردة مستقلة عن مبيعات الكاشير، بلا ربط موثوق بالفرع.', href: '/reports/historical-sales', keys: ['reports.view', 'finance.view_revenue'], ownerOnly: true, cafeWide: true, format: 'تقرير سنوي مستقل' },
  { id: 'stock', group: 'inventory', title: 'رصيد الأصناف وحركات المخزون', description: 'يفتح شاشة المخزون الحالية وفلاترها وتفاصيل حركات الأصناف، وليس رصيداً تاريخياً.', href: '/inventory', keys: ['inventory.view'], features: ['inventoryEnabled'], format: 'شاشة تشغيلية · تفاصيل' },
  { id: 'purchase-invoices', group: 'purchasing', title: 'تقرير فواتير المشتريات', description: 'فترة القاهرة والفرع والمورد والحالة؛ الإجماليات والفواتير من نفس الاستعلام. تصدير الصفحة المعروضة.', href: '/report-center/purchases', keys: ['purchases.view', 'purchases.view_cost'], features: ['inventoryEnabled', 'purchasesEnabled'], format: 'تقرير · طباعة · تصدير' },
  { id: 'expenses', group: 'finance', title: 'مصروفات التشغيل', description: 'الفترة والفرع والتصنيف وتفاصيل المصروف من السجل التشغيلي.', href: '/expenses', keys: ['expenses.view'], format: 'سجل تشغيلي' },
  { id: 'money', group: 'finance', title: 'الحسابات وكشوف الحركة', description: 'الخزينة والبنك والمحفظة والتحويلات الداخلية. الرصيد الافتتاحي المجهول يبقى مجهولاً.', href: '/treasury', keys: ['treasury.view'], ownerOnly: true, format: 'كشف حساب · تفاصيل' },
  { id: 'trial-balance', group: 'finance', title: 'ميزان المراجعة', description: 'الدفاتر التجريبية؛ يعرض حالة الإعداد الفعلية.', href: '/accounting/trial-balance', keys: ['accounting.view'], format: 'دفاتر تجريبية' },
  { id: 'income', group: 'finance', title: 'قائمة الدخل', description: 'الحساب الخلفي المعتمد للدفاتر التجريبية مع نطاق الفرع المسموح.', href: '/accounting/statements?kind=income', keys: ['accounting.view'], format: 'دفاتر تجريبية · طباعة · تصدير' },
  { id: 'balance-sheet', group: 'finance', title: 'الميزانية العمومية', description: 'قائمة على مستوى الكافيه؛ لا تتاح للقارئ المقيد بفرع.', href: '/accounting/statements?kind=balance-sheet', keys: ['accounting.view'], cafeWide: true, format: 'دفاتر تجريبية · طباعة · تصدير' },
  { id: 'cash-flow', group: 'finance', title: 'التدفقات النقدية', description: 'قائمة على مستوى الكافيه من الدفاتر التجريبية؛ التحويل الداخلي ليس إيراداً أو مصروفاً.', href: '/accounting/statements?kind=cash-flow', keys: ['accounting.view'], cafeWide: true, format: 'دفاتر تجريبية · طباعة · تصدير' },
  { id: 'ledger', group: 'finance', title: 'الأستاذ العام', description: 'حركات الحساب المحاسبي وتفاصيل القيود من مصدرها.', href: '/accounting/ledger', keys: ['accounting.view'], format: 'دفاتر تجريبية · تفاصيل' },
  { id: 'journal', group: 'finance', title: 'دفتر اليومية', description: 'القيود التجريبية وتفاصيل المصدر؛ لا يُنشئ العرض قيوداً.', href: '/accounting/journal', keys: ['accounting.view'], format: 'دفاتر تجريبية · تفاصيل' },
  { id: 'customers', group: 'customers', title: 'العملاء والولاء', description: 'بحث العملاء وسجل الطلبات والنقاط. الإحصاءات الحالية تراكمية على مستوى الكافيه، بلا فلتر فترة أو تصدير.', href: '/customers', keys: ['customers.view'], cafeWide: true, format: 'سجل تراكمي · تفاصيل' },
  { id: 'shifts', group: 'system', title: 'تقارير الشيفتات', description: 'القفل والتسويات والتقرير التفصيلي للشيفت وفق الصلاحيات.', href: '/reports/shift-sales', keys: ['shifts.view_reports'], features: ['shiftManagementEnabled'], format: 'سجل · تقارير شيفت' },
  { id: 'opening', group: 'system', title: 'الاستلام والمسؤولية', description: 'عجز وزيادة كل موظف في النقدية والخامات، وسجل التسليمات والاستثناءات. Excel وCSV وطباعة.', href: '/reports/opening-receipts', keys: ['reports.view', 'shifts.view_reports'], features: ['shiftManagementEnabled'], format: 'تقرير · تفاصيل' },
  { id: 'variances', group: 'system', title: 'فروق الموظفين', description: 'فروق الكاش والبطاقات والمحفظة والخامات حسب الموظف والفترة.', href: '/reports/employee-variances', keys: ['variance.view'], features: ['shiftManagementEnabled'], format: 'تقرير · تفاصيل' },
  { id: 'actions', group: 'system', title: 'مسؤولية الإلغاء والاسترداد', description: 'طلب الموافقة وقرار المالك والمنفذ والأحداث المرتبطة.', href: '/reports/employee-actions', keys: ['reports.view'], format: 'تقرير · تفاصيل' },
  { id: 'audit', group: 'system', title: 'سجل نشاط النظام', description: 'سجل الحركات الحالي على مستوى الكافيه؛ أحدث ٢٠٠ حركة، بلا فلتر فرع أو تصدير.', href: '/audit', keys: ['audit.view'], cafeWide: true, format: 'سجل نشاط محدود' },
];
export function visibleReportCatalog(authority: { keys: ReadonlySet<string>; features: Partial<CafeFeatures>; role: string; branchId?: string | null }): ReportCatalogEntry[] {
  return CATALOG.filter(report => report.keys.every(key => authority.keys.has(key))
    && (!report.features || report.features.every(key => authority.features[key] === true))
    && (!report.ownerOnly || ['CAFE_OWNER', 'SUPER_ADMIN'].includes(authority.role))
    && (!report.cafeWide || (!authority.branchId && ['CAFE_OWNER', 'SUPER_ADMIN'].includes(authority.role))));
}
